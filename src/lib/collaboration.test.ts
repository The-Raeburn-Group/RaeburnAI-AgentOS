import { describe, expect, it } from "vitest";
import {
  COLLABORATION_CONTRACT_VERSION,
  EVIDENCE_PROTOCOL_VERSION,
  adjudicationPrompt,
  agentManifestDigest,
  buildCollaborationPlan,
  expertStagePrompt,
  parseAdjudicationResult,
} from "@/lib/collaboration";
import { AgentManifestSchema, WorkflowRunRequestSchema } from "@/lib/types";

describe("expert collaboration contracts", () => {
  it("builds a deterministic versioned expert manifest digest", () => {
    const manifest = AgentManifestSchema.parse({
      name: "Research Expert",
      slug: "research-expert",
      description: "Independent research expert with evidence requirements.",
      systemPrompt: "Research independently and state uncertainty.",
      domains: ["research"],
      capabilities: ["source-analysis"],
      evidencePolicy: {
        requireSources: true,
        preferPrimarySources: true,
        contradictionSearch: true,
      },
    });

    const first = agentManifestDigest(manifest);
    const second = agentManifestDigest({ ...manifest });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it("requires a separate adjudicator for adjudicated and evidence modes", () => {
    expect(() =>
      WorkflowRunRequestSchema.parse({
        goal: "Compare expert findings",
        agents: ["expert-a", "expert-b"],
        mode: "adjudicated",
      }),
    ).toThrow();

    expect(() =>
      WorkflowRunRequestSchema.parse({
        goal: "Compare expert findings",
        agents: ["expert-a", "expert-b"],
        mode: "evidence",
        adjudicator: "expert-a",
      }),
    ).toThrow();
  });

  it("builds a versioned collaboration plan and independent expert prompt", () => {
    const request = WorkflowRunRequestSchema.parse({
      goal: "Determine the strongest supported conclusion",
      agents: ["expert-a", "expert-b"],
      mode: "evidence",
      adjudicator: "verifier",
      strictness: "high",
      input: { caseId: "case-1" },
    });

    expect(buildCollaborationPlan(request)).toEqual({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      mode: "evidence",
      primaryAgents: ["expert-a", "expert-b"],
      adjudicator: "verifier",
      strictness: "high",
    });
    const prompt = expertStagePrompt(request);
    expect(prompt).toContain("independent expert");
    expect(prompt).toContain("case-1");
  });

  it("requires schema-valid adjudication JSON and known evidence sources", () => {
    const good = JSON.stringify({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      evidenceProtocolVersion: EVIDENCE_PROTOCOL_VERSION,
      decision: "Supported conclusion",
      confidence: 0.8,
      agreements: ["Both experts agree on the core fact."],
      conflicts: [],
      sources: [
        {
          id: "source-1",
          title: "Primary record",
          sourceType: "primary",
        },
      ],
      claims: [
        {
          claim: "The primary record supports the conclusion.",
          sourceIds: ["source-1"],
          support: "supports",
        },
      ],
      contradictionSearchPerformed: true,
      unresolvedRisks: [],
    });

    expect(parseAdjudicationResult(good, "evidence", "high").decision).toBe(
      "Supported conclusion",
    );

    const unknownSource = good.replace('"source-1"]', '"missing-source"]');
    expect(() =>
      parseAdjudicationResult(unknownSource, "evidence", "high"),
    ).toThrow();
    expect(() =>
      parseAdjudicationResult("not-json", "adjudicated", "standard"),
    ).toThrow();
  });

  it("requires contradiction search for high-assurance evidence workflows", () => {
    const response = JSON.stringify({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      evidenceProtocolVersion: EVIDENCE_PROTOCOL_VERSION,
      decision: "Tentative conclusion",
      confidence: 0.5,
      agreements: [],
      conflicts: [],
      sources: [
        {
          id: "source-1",
          title: "Primary record",
          sourceType: "primary",
        },
      ],
      claims: [
        {
          claim: "A claim",
          sourceIds: ["source-1"],
          support: "supports",
        },
      ],
      contradictionSearchPerformed: false,
      unresolvedRisks: ["Contradiction search not completed."],
    });

    expect(() => parseAdjudicationResult(response, "evidence", "high")).toThrow(
      "requires contradiction search",
    );
  });

  it("tells the adjudicator not to invent evidence or certainty", () => {
    const request = WorkflowRunRequestSchema.parse({
      goal: "Adjudicate findings",
      agents: ["expert-a", "expert-b"],
      mode: "evidence",
      adjudicator: "verifier",
      strictness: "regulated",
    });
    const prompt = adjudicationPrompt({
      request,
      contributions: [
        { agent: "expert-a", text: "Position A" },
        { agent: "expert-b", text: "Position B" },
      ],
    });

    expect(prompt).toContain(
      "Do not invent agreement, evidence, citations or certainty",
    );
    expect(prompt).toContain(EVIDENCE_PROTOCOL_VERSION);
    expect(prompt).toContain("at least 2 source(s)");
  });
});
