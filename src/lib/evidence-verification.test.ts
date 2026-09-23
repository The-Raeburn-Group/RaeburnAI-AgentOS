import { describe, expect, it } from "vitest";
import {
  COLLABORATION_CONTRACT_VERSION,
  EVIDENCE_PROTOCOL_VERSION,
  AdjudicationResultSchema,
} from "@/lib/collaboration";
import {
  EvidenceVerificationError,
  buildVerificationRequestFromAdjudication,
  evaluateArithmeticExpression,
  evidenceSourceContentHash,
  verifyEvidenceBundle,
  type CriticReview,
  type TrustedEvidenceSource,
} from "@/lib/evidence-verification";

function source(
  id: string,
  excerpt: string,
  overrides: Partial<TrustedEvidenceSource> = {},
): TrustedEvidenceSource {
  return {
    id,
    uri: "https://example.com/" + id,
    title: "Trusted source " + id,
    sourceType: "primary",
    retrievedAt: "2026-09-23T12:00:00.000Z",
    documentId: "doc-" + id,
    documentVersion: "v1",
    chunkId: "chunk-" + id,
    excerpt,
    contentHash: evidenceSourceContentHash(excerpt),
    ...overrides,
  };
}

function critic(
  findings: CriticReview["findings"] = [],
  overrides: Partial<CriticReview> = {},
): CriticReview {
  return {
    reviewer: {
      provider: "openai",
      model: "critic-model",
      family: "critic-family",
    },
    primaryModelFamily: "primary-family",
    findings,
    ...overrides,
  };
}

describe("independent evidence verification", () => {
  it("passes independently supported claims and deterministic calculations", () => {
    const trusted = source(
      "s1",
      "The approved service level target is 99.9 percent availability.",
    );
    const result = verifyEvidenceBundle({
      strictness: "standard",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim:
            "The approved service level target is 99.9 percent availability.",
          sourceIds: ["s1"],
        },
      ],
      calculations: [
        {
          id: "calc-1",
          expression: "125 * 20%",
          assertedResult: 25,
          unit: "GBP",
        },
      ],
    });

    expect(result).toMatchObject({
      decision: "pass",
      scores: {
        correctness: 1,
        evidenceIntegrity: 1,
        citationIntegrity: 1,
        calculationAccuracy: 1,
      },
    });
    expect(result.claimResults[0]?.verdict).toBe("supported");
    expect(result.calculationResults[0]).toMatchObject({
      passed: true,
      computedResult: 25,
    });
  });

  it("fails high-assurance verification without contradiction search or an independent critic", () => {
    const trusted = source("s1", "The policy requires two approvals.");
    const result = verifyEvidenceBundle({
      strictness: "high",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim: "The policy requires two approvals.",
          sourceIds: ["s1"],
        },
      ],
      contradictionSearchPerformed: false,
    });

    expect(result.decision).toBe("fail");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "high-assurance verification requires a completed contradiction search",
        "high-assurance verification requires a critic from an independent model family",
      ]),
    );
  });

  it("rejects same-family critics for high-assurance verification", () => {
    const trusted = source("s1", "The policy requires two approvals.");
    const result = verifyEvidenceBundle({
      strictness: "high",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim: "The policy requires two approvals.",
          sourceIds: ["s1"],
        },
      ],
      contradictionSearchPerformed: true,
      criticReview: critic([], {
        reviewer: {
          provider: "openai",
          model: "primary-sibling",
          family: "same-family",
        },
        primaryModelFamily: "same-family",
      }),
    });

    expect(result.decision).toBe("fail");
    expect(result.critic.independentModelFamily).toBe(false);
  });

  it("fails closed when a trusted source excerpt is tampered after hashing", () => {
    const trusted = source("s1", "The filing deadline is 30 September.");
    trusted.excerpt = "The filing deadline is 31 December.";

    const result = verifyEvidenceBundle({
      strictness: "standard",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim: "The filing deadline is 30 September.",
          sourceIds: ["s1"],
        },
      ],
    });

    expect(result.decision).toBe("fail");
    expect(result.scores.evidenceIntegrity).toBe(0);
    expect(result.reasons).toContain(
      "source integrity failure for evidence source s1",
    );
  });

  it("requires two independently verified sources including a primary source for regulated claims", () => {
    const secondary = source(
      "s1",
      "The regulated capital ratio is 12 percent.",
      { sourceType: "secondary" },
    );
    const single = verifyEvidenceBundle({
      strictness: "regulated",
      sources: [secondary],
      claims: [
        {
          id: "c1",
          claim: "The regulated capital ratio is 12 percent.",
          sourceIds: ["s1"],
        },
      ],
      contradictionSearchPerformed: true,
      criticReview: critic(),
    });
    expect(single.decision).toBe("fail");
    expect(single.claimResults[0]?.verdict).toBe("insufficient");

    const primary = source("s2", "The regulated capital ratio is 12 percent.", {
      sourceType: "primary",
    });
    const complete = verifyEvidenceBundle({
      strictness: "regulated",
      sources: [secondary, primary],
      claims: [
        {
          id: "c1",
          claim: "The regulated capital ratio is 12 percent.",
          sourceIds: ["s1", "s2"],
        },
      ],
      contradictionSearchPerformed: true,
      criticReview: critic(),
    });
    expect(complete.decision).toBe("pass");
    expect(complete.claimResults[0]?.verdict).toBe("supported");
  });

  it("detects contradictory evidence instead of trusting a model support label", () => {
    const adjudication = AdjudicationResultSchema.parse({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      evidenceProtocolVersion: EVIDENCE_PROTOCOL_VERSION,
      decision: "The rate is 5 percent.",
      confidence: 0.9,
      agreements: [],
      conflicts: [],
      sources: [
        {
          id: "s1",
          title: "Model-supplied title",
          sourceType: "primary",
        },
      ],
      claims: [
        {
          claim: "The rate is 5 percent.",
          sourceIds: ["s1"],
          support: "supports",
        },
      ],
      contradictionSearchPerformed: true,
      unresolvedRisks: [],
    });
    const trusted = source("s1", "The rate is not 5 percent.");
    const request = buildVerificationRequestFromAdjudication({
      adjudication,
      strictness: "high",
      trustedSources: [trusted],
      criticReview: critic(),
    });

    const result = verifyEvidenceBundle(request);
    expect(result.decision).toBe("fail");
    expect(result.claimResults[0]?.verdict).toBe("contradicted");
  });

  it("does not let an unsubstantiated critic override verified evidence", () => {
    const trusted = source("s1", "The approved limit is 50.");
    const result = verifyEvidenceBundle({
      strictness: "standard",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim: "The approved limit is 50.",
          sourceIds: ["s1"],
        },
      ],
      criticReview: critic([
        {
          id: "f1",
          category: "factuality",
          severity: "critical",
          summary: "The answer may be wrong, but no evidence is supplied.",
          claimIds: ["c1"],
          sourceIds: [],
        },
      ]),
    });

    expect(result.decision).toBe("review");
    expect(result.critic.ignoredFindingIds).toEqual(["f1"]);
    expect(result.reasons).not.toContain(
      "substantiated high-severity critic finding: f1",
    );
    expect(result.unresolvedRisks).toHaveLength(1);
  });

  it("fails on a substantiated high-severity critic finding in high assurance mode", () => {
    const trusted = source(
      "s1",
      "The approved limit is 50. A documented exception applies to emergency cases.",
    );
    const result = verifyEvidenceBundle({
      strictness: "high",
      sources: [trusted],
      claims: [
        {
          id: "c1",
          claim: "The approved limit is 50.",
          sourceIds: ["s1"],
        },
      ],
      contradictionSearchPerformed: true,
      criticReview: critic([
        {
          id: "f1",
          category: "factuality",
          severity: "high",
          summary: "A documented exception applies to emergency cases.",
          claimIds: ["c1"],
          sourceIds: ["s1"],
        },
      ]),
    });

    expect(result.decision).toBe("fail");
    expect(result.critic.substantiatedFindingIds).toEqual(["f1"]);
    expect(result.reasons).toContain(
      "substantiated high-severity critic finding: f1",
    );
  });

  it("evaluates arithmetic without eval and rejects unsupported expressions", () => {
    expect(evaluateArithmeticExpression("(100 + 25) * 20%")).toBe(25);
    expect(evaluateArithmeticExpression("-5 + 2 * 4")).toBe(3);
    expect(() => evaluateArithmeticExpression("process.exit(1)")).toThrow(
      "unsupported_expression_token",
    );
    expect(() => evaluateArithmeticExpression("10 / 0")).toThrow(
      "division_by_zero",
    );
  });

  it("fails material numerical claims when the recomputed result differs", () => {
    const result = verifyEvidenceBundle({
      strictness: "standard",
      calculations: [
        {
          id: "calc-1",
          expression: "100 * 15%",
          assertedResult: 20,
          absoluteTolerance: 0.001,
        },
      ],
    });

    expect(result.decision).toBe("fail");
    expect(result.calculationResults[0]).toMatchObject({
      passed: false,
      computedResult: 15,
    });
  });

  it("rejects an empty verification bundle instead of treating missing assertions as perfect scores", () => {
    expect(() => verifyEvidenceBundle({})).toThrow(
      "verification requires at least one claim or calculation",
    );
  });

  it("rejects duplicate identifiers and unknown citation references", () => {
    const trusted = source("s1", "Supported claim.");
    expect(() =>
      verifyEvidenceBundle({
        sources: [trusted, trusted],
      }),
    ).toThrow(EvidenceVerificationError);

    expect(() =>
      verifyEvidenceBundle({
        sources: [trusted],
        claims: [
          {
            id: "c1",
            claim: "Supported claim.",
            sourceIds: ["missing"],
          },
        ],
      }),
    ).toThrow("unknown_claim_source");
  });

  it("keeps comparable supporting and contradicting evidence unresolved rather than majority voting", () => {
    const support = source("support", "The service is available today.");
    const contradict = source(
      "contradict",
      "The service is not available today.",
    );
    const result = verifyEvidenceBundle({
      strictness: "standard",
      sources: [support, contradict],
      claims: [
        {
          id: "c1",
          claim: "The service is available today.",
          sourceIds: ["support", "contradict"],
        },
      ],
    });

    expect(result.decision).toBe("fail");
    expect(result.claimResults[0]?.verdict).toBe("conflicted");
  });
});
