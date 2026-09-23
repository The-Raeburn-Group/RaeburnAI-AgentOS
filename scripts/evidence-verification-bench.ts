import {
  evidenceSourceContentHash,
  verifyEvidenceBundle,
  type EvidenceVerificationRequest,
  type TrustedEvidenceSource,
} from "../src/lib/evidence-verification";

function source(
  id: string,
  excerpt: string,
  sourceType: TrustedEvidenceSource["sourceType"] = "primary",
): TrustedEvidenceSource {
  return {
    id,
    uri: "https://example.com/evidence/" + id,
    title: "Evidence " + id,
    sourceType,
    retrievedAt: "2026-09-23T12:00:00.000Z",
    documentId: "document-" + id,
    documentVersion: "v1",
    chunkId: "chunk-" + id,
    excerpt,
    contentHash: evidenceSourceContentHash(excerpt),
  };
}

const independentCritic = {
  reviewer: {
    provider: "openai",
    model: "critic-model",
    family: "critic-family",
  },
  primaryModelFamily: "primary-family",
  findings: [],
};

const cases: Array<{
  id: string;
  request: EvidenceVerificationRequest;
  expectedDecision: "pass" | "review" | "fail";
}> = [
  {
    id: "supported-primary-claim",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "standard",
      answer: "The approved limit is 50.",
      sources: [source("s1", "The approved limit is 50.")],
      claims: [
        {
          id: "c1",
          claim: "The approved limit is 50.",
          sourceIds: ["s1"],
          material: true,
        },
      ],
      calculations: [],
      contradictionSearchPerformed: false,
    },
    expectedDecision: "pass",
  },
  {
    id: "contradicted-claim",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "standard",
      answer: "The rate is 5 percent.",
      sources: [source("s1", "The rate is not 5 percent.")],
      claims: [
        {
          id: "c1",
          claim: "The rate is 5 percent.",
          sourceIds: ["s1"],
          material: true,
        },
      ],
      calculations: [],
      contradictionSearchPerformed: false,
    },
    expectedDecision: "fail",
  },
  {
    id: "verified-calculation",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "standard",
      answer: "The result is 25.",
      sources: [],
      claims: [],
      calculations: [
        {
          id: "calc-1",
          expression: "125 * 20%",
          assertedResult: 25,
          absoluteTolerance: 1e-9,
          relativeTolerance: 1e-9,
          material: true,
        },
      ],
      contradictionSearchPerformed: false,
    },
    expectedDecision: "pass",
  },
  {
    id: "wrong-calculation",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "standard",
      answer: "The result is 30.",
      sources: [],
      claims: [],
      calculations: [
        {
          id: "calc-1",
          expression: "125 * 20%",
          assertedResult: 30,
          absoluteTolerance: 1e-9,
          relativeTolerance: 1e-9,
          material: true,
        },
      ],
      contradictionSearchPerformed: false,
    },
    expectedDecision: "fail",
  },
  {
    id: "regulated-two-source-evidence",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "regulated",
      answer: "The regulated ratio is 12 percent.",
      sources: [
        source("primary", "The regulated ratio is 12 percent.", "primary"),
        source(
          "secondary",
          "The regulated ratio is 12 percent.",
          "secondary",
        ),
      ],
      claims: [
        {
          id: "c1",
          claim: "The regulated ratio is 12 percent.",
          sourceIds: ["primary", "secondary"],
          material: true,
        },
      ],
      calculations: [],
      contradictionSearchPerformed: true,
      criticReview: independentCritic,
    },
    expectedDecision: "pass",
  },
  {
    id: "unsubstantiated-critic-review",
    request: {
      contractVersion: "raeburnai.evidence-verification.v1",
      strictness: "standard",
      answer: "The approved limit is 50.",
      sources: [source("s1", "The approved limit is 50.")],
      claims: [
        {
          id: "c1",
          claim: "The approved limit is 50.",
          sourceIds: ["s1"],
          material: true,
        },
      ],
      calculations: [],
      contradictionSearchPerformed: false,
      criticReview: {
        ...independentCritic,
        findings: [
          {
            id: "f1",
            category: "factuality",
            severity: "critical",
            summary: "Potential error without independent evidence.",
            claimIds: ["c1"],
            sourceIds: [],
          },
        ],
      },
    },
    expectedDecision: "review",
  },
];

const results = cases.map((benchmarkCase) => {
  const result = verifyEvidenceBundle(benchmarkCase.request);
  return {
    caseId: benchmarkCase.id,
    expectedDecision: benchmarkCase.expectedDecision,
    actualDecision: result.decision,
    passed: result.decision === benchmarkCase.expectedDecision,
    overallScore: result.scores.overall,
  };
});

const passed = results.filter((result) => result.passed).length;
const evidenceScore = passed / results.length;

console.log(
  JSON.stringify(
    {
      candidate: {
        id: "evidence-verification-core",
        version: "0.1.0",
      },
      evidenceScore,
      cases: results,
    },
    null,
    2,
  ),
);

if (evidenceScore !== 1) {
  process.exitCode = 1;
}
