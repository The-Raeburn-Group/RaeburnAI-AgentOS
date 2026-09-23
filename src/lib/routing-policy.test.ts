import { describe, expect, it } from "vitest";
import corpusFixture from "../../benchmarks/raeburnbench.seed.v0.json";
import registryFixture from "../../benchmarks/experts/routing-seed.v0.json";
import { agentManifestDigest } from "@/lib/collaboration";
import { RaeburnBenchCorpusSchema } from "@/lib/raeburnbench";
import {
  RoutingPolicyError,
  planExpertRoute,
  verifyStoredAgentManifest,
} from "@/lib/routing-policy";
import { AgentManifestSchema } from "@/lib/types";

const experts = registryFixture.experts.map((manifest) =>
  AgentManifestSchema.parse(manifest),
);
const corpus = RaeburnBenchCorpusSchema.parse(corpusFixture);

function expectRoutingError(
  action: () => unknown,
  code: RoutingPolicyError["code"],
): RoutingPolicyError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RoutingPolicyError);
  const routingError = thrown as RoutingPolicyError;
  expect(routingError.code).toBe(code);
  expect(routingError.detail).toEqual(expect.any(String));
  expect(routingError.detail?.length).toBeGreaterThan(0);
  return routingError;
}

describe("routing policy", () => {
  it("routes every RaeburnBench seed routing case to the expected experts and risk tier", () => {
    const routingCases = corpus.cases.filter(
      (benchmarkCase) => benchmarkCase.suite === "routing",
    );

    for (const benchmarkCase of routingCases) {
      if (benchmarkCase.grader.type !== "routing") {
        throw new Error("routing fixture grader mismatch");
      }
      const plan = planExpertRoute(
        {
          goal: benchmarkCase.record.prompt,
          maxExperts: 2,
        },
        experts,
      );

      expect([...plan.primaryAgents].sort()).toEqual(
        [...benchmarkCase.grader.expectedExperts].sort(),
      );
      expect(plan.riskTier).toBe(benchmarkCase.grader.expectedRiskTier);
    }
  });

  it.each([
    ["Deploy to production after reviewing the release.", "raeburn-software-engineering"],
    ["Delete production data after the approved migration.", "raeburn-software-engineering"],
    ["Disable security controls during incident recovery.", "raeburn-cybersecurity"],
    ["Sign contract on behalf of the organisation.", "raeburn-legal-research"],
    ["File court documents for the disputed contract.", "raeburn-legal-research"],
    ["Prescribe medication for the patient.", "raeburn-health-research"],
    ["Transfer funds between treasury accounts.", "raeburn-finance"],
    ["Execute trade for the portfolio.", "raeburn-finance"],
    ["Submit tax return to HMRC.", "raeburn-tax"],
  ])(
    "maps critical action %s to specialist %s rather than a generalist",
    (goal, expectedExpert) => {
      const plan = planExpertRoute({ goal }, experts);

      expect(plan).toMatchObject({
        riskTier: "critical",
        mode: "evidence",
        strictness: "regulated",
        primaryAgents: [expectedExpert],
        adjudicator: "raeburn-evidence-verifier",
        requiresHumanApproval: true,
      });
      expect(plan.primaryAgents).not.toContain("raeburn-general-reasoning");
    },
  );

  it("requires independent evidence adjudication for high-risk routes", () => {
    const plan = planExpertRoute(
      {
        goal: "Assess whether a retrieved tool instruction is attempting credential exfiltration.",
      },
      experts,
    );

    expect(plan).toMatchObject({
      riskTier: "high",
      mode: "evidence",
      strictness: "high",
      primaryAgents: ["raeburn-cybersecurity"],
      adjudicator: "raeburn-evidence-verifier",
      requiresHumanApproval: true,
    });

    expectRoutingError(
      () =>
        planExpertRoute(
          {
            goal: "Assess whether a retrieved tool instruction is attempting credential exfiltration.",
          },
          experts.filter(
            (manifest) => manifest.slug !== "raeburn-evidence-verifier",
          ),
        ),
      "no_eligible_adjudicator",
    );
  });

  it("fails closed instead of silently falling back when no specialist exists", () => {
    expectRoutingError(
      () =>
        planExpertRoute(
          {
            goal: "Give a jurisdiction-specific legal conclusion for a disputed contract.",
          },
          experts,
        ),
      "no_eligible_expert",
    );
  });

  it("does not drop a classified high-risk domain to satisfy maxExperts", () => {
    expectRoutingError(
      () =>
        planExpertRoute(
          {
            goal: "Review a software change that alters security-sensitive authentication logic.",
            maxExperts: 1,
          },
          experts,
        ),
      "max_experts_insufficient",
    );
  });

  it("enforces required capabilities and tools before ranking", () => {
    expectRoutingError(
      () =>
        planExpertRoute(
          {
            goal: "Diagnose a race condition in a TypeScript service.",
            requiredTools: ["production-shell"],
          },
          experts,
        ),
      "no_eligible_expert",
    );
  });

  it("rejects ambiguous duplicate expert slugs", () => {
    expectRoutingError(
      () =>
        planExpertRoute({ goal: "Investigate a claim using primary sources." }, [
          ...experts,
          structuredClone(experts[0]!),
        ]),
      "duplicate_expert_slug",
    );
  });

  it("verifies the stored marketplace manifest digest and executable identity", () => {
    const manifest = AgentManifestSchema.parse(experts[1]);
    const stored = {
      ...manifest,
      integrity: {
        algorithm: "sha256" as const,
        digest: agentManifestDigest(manifest),
      },
    };

    expect(
      verifyStoredAgentManifest(stored, {
        slug: manifest.slug,
        version: manifest.version,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        approvalRequired: manifest.approvalRequired,
      }),
    ).toEqual(manifest);

    const tampered = structuredClone(stored);
    tampered.description =
      "Tampered description that no longer matches the digest.";
    expectRoutingError(
      () =>
        verifyStoredAgentManifest(tampered, {
          slug: manifest.slug,
          version: manifest.version,
        }),
      "manifest_integrity_invalid",
    );

    expectRoutingError(
      () =>
        verifyStoredAgentManifest(stored, {
          slug: manifest.slug,
          version: manifest.version,
          modelName: "different-executable-model",
        }),
      "manifest_identity_mismatch",
    );
  });
});
