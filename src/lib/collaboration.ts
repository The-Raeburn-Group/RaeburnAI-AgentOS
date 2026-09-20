import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentManifest, JsonValue, WorkflowRunRequest } from "@/lib/types";

export const AGENT_MANIFEST_CONTRACT_VERSION =
  "raeburnai.agent-manifest.v1" as const;
export const COLLABORATION_CONTRACT_VERSION =
  "raeburnai.collaboration.v1" as const;
export const EVIDENCE_PROTOCOL_VERSION =
  "raeburnai.evidence-protocol.v1" as const;

export const CollaborationModeSchema = z.enum([
  "sequential",
  "parallel",
  "adjudicated",
  "evidence",
]);
export type CollaborationMode = z.infer<typeof CollaborationModeSchema>;

export const EvidenceStrictnessSchema = z.enum([
  "standard",
  "high",
  "regulated",
]);
export type EvidenceStrictness = z.infer<typeof EvidenceStrictnessSchema>;

export const ExpertContributionSchema = z.object({
  agent: z.string().min(1),
  text: z.string().min(1),
});
export type ExpertContribution = z.infer<typeof ExpertContributionSchema>;

export const EvidenceSourceSchema = z.object({
  id: z.string().min(1),
  uri: z.string().url().optional(),
  title: z.string().min(1),
  sourceType: z.enum(["primary", "secondary", "internal", "unknown"]),
  retrievedAt: z.string().datetime().optional(),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceClaimSchema = z.object({
  claim: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  support: z.enum(["supports", "contradicts", "unclear"]),
});
export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

export const AdjudicationResultSchema = z
  .object({
    contractVersion: z.literal(COLLABORATION_CONTRACT_VERSION),
    evidenceProtocolVersion: z.literal(EVIDENCE_PROTOCOL_VERSION).optional(),
    decision: z.string().min(1),
    confidence: z.number().min(0).max(1),
    agreements: z.array(z.string()).default([]),
    conflicts: z
      .array(
        z.object({
          topic: z.string().min(1),
          positions: z
            .array(
              z.object({
                agent: z.string().min(1),
                position: z.string().min(1),
              }),
            )
            .min(2),
        }),
      )
      .default([]),
    sources: z.array(EvidenceSourceSchema).default([]),
    claims: z.array(EvidenceClaimSchema).default([]),
    contradictionSearchPerformed: z.boolean().default(false),
    unresolvedRisks: z.array(z.string()).default([]),
  })
  .superRefine((value, context) => {
    const sourceIds = new Set(value.sources.map((source) => source.id));
    for (const [index, claim] of value.claims.entries()) {
      for (const sourceId of claim.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["claims", index, "sourceIds"],
            message: `Unknown evidence source: ${sourceId}`,
          });
        }
      }
    }
  });
export type AdjudicationResult = z.infer<typeof AdjudicationResultSchema>;

export interface CollaborationPlan {
  contractVersion: typeof COLLABORATION_CONTRACT_VERSION;
  mode: CollaborationMode;
  primaryAgents: string[];
  adjudicator?: string;
  strictness: EvidenceStrictness;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentManifestDigest(manifest: AgentManifest): string {
  const payload = {
    contractVersion: AGENT_MANIFEST_CONTRACT_VERSION,
    manifest,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function buildCollaborationPlan(
  request: WorkflowRunRequest,
): CollaborationPlan {
  const mode = request.mode;
  const adjudicator = request.adjudicator;
  if (
    (mode === "adjudicated" || mode === "evidence") &&
    !adjudicator
  ) {
    throw new Error(`${mode} workflow requires an adjudicator`);
  }
  if (adjudicator && request.agents.includes(adjudicator)) {
    throw new Error("Adjudicator must be separate from primary expert agents");
  }
  return {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    mode,
    primaryAgents: [...request.agents],
    ...(adjudicator ? { adjudicator } : {}),
    strictness: request.strictness,
  };
}

function inputJson(input: Record<string, JsonValue>): string {
  return JSON.stringify(input);
}

export function expertStagePrompt(request: WorkflowRunRequest): string {
  return [
    "You are one independent expert in a governed multi-expert workflow.",
    "Do not assume other experts agree with you.",
    "State material uncertainty and identify evidence that would change your conclusion.",
    `Goal: ${request.goal}`,
    `Input: ${inputJson(request.input)}`,
  ].join("\n");
}

export function adjudicationPrompt(options: {
  request: WorkflowRunRequest;
  contributions: ExpertContribution[];
}): string {
  const { request, contributions } = options;
  const evidenceMode = request.mode === "evidence";
  const minimumSources =
    request.strictness === "regulated"
      ? 2
      : request.strictness === "high"
        ? 1
        : 0;

  return [
    "You are the governed adjudicator for a multi-expert RaeburnAI workflow.",
    "Return JSON only. Do not invent agreement, evidence, citations or certainty.",
    `contractVersion must equal "${COLLABORATION_CONTRACT_VERSION}".`,
    ...(evidenceMode
      ? [
          `evidenceProtocolVersion must equal "${EVIDENCE_PROTOCOL_VERSION}".`,
          "For every factual claim in claims, cite sourceIds that exist in sources.",
          `Target at least ${minimumSources} source(s) per material factual claim when available.`,
          "Prefer primary sources and explicitly record contradictory evidence.",
          "Set contradictionSearchPerformed truthfully.",
        ]
      : []),
    "Required JSON fields: decision, confidence (0..1), agreements, conflicts, sources, claims, contradictionSearchPerformed, unresolvedRisks.",
    "Each conflict must include topic and at least two agent/position entries.",
    `Goal: ${request.goal}`,
    `Strictness: ${request.strictness}`,
    "Independent expert contributions:",
    ...contributions.map(
      (contribution) =>
        `--- ${contribution.agent} ---\n${contribution.text}`,
    ),
  ].join("\n\n");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Adjudicator response must be a JSON object");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("Adjudicator response is not valid JSON");
  }
}

export function parseAdjudicationResult(
  text: string,
  mode: CollaborationMode,
  strictness: EvidenceStrictness,
): AdjudicationResult {
  const result = AdjudicationResultSchema.parse(extractJsonObject(text));
  if (mode === "evidence") {
    if (result.evidenceProtocolVersion !== EVIDENCE_PROTOCOL_VERSION) {
      throw new Error("Evidence workflow returned the wrong protocol version");
    }
    if (
      (strictness === "high" || strictness === "regulated") &&
      !result.contradictionSearchPerformed
    ) {
      throw new Error(
        "High-assurance evidence workflow requires contradiction search",
      );
    }
    const requiredSources = strictness === "regulated" ? 2 : strictness === "high" ? 1 : 0;
    if (requiredSources > 0) {
      for (const claim of result.claims) {
        if (claim.support === "supports" && claim.sourceIds.length < requiredSources) {
          throw new Error(
            `Evidence claim requires at least ${requiredSources} source(s)`,
          );
        }
      }
    }
  }
  return result;
}
