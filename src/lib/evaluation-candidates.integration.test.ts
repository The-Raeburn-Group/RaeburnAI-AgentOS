import {
  EvaluationCandidateStatus,
  EvaluationCandidateTrigger,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DatasetAdmissibilityError,
  DatasetRecordSchema,
  parseDatasetRecordsJsonl,
} from "@/lib/dataset-provenance";
import { db } from "@/lib/db";
import {
  EvaluationCandidateError,
  captureEvaluationCandidate,
  exportApprovedEvaluationRecordsJsonl,
  listEvaluationCandidates,
  reviewEvaluationCandidate,
} from "@/lib/evaluation-candidates";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantA = "evaluation-candidate-tenant-a";
const tenantB = "evaluation-candidate-tenant-b";

function context(
  tenantReference = tenantA,
  actorId = "quality-operator",
  requestId = "eval-request-1",
) {
  return { tenantReference, actorId, requestId };
}

function provenance(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "raeburnai.dataset-provenance.v1",
    sourceKind: "first_party",
    sourceId: "workflow-run-001",
    collectedAt: "2026-09-23T12:00:00.000Z",
    jurisdiction: "GB",
    license: {
      identifier: "first-party-reviewed",
      evaluationAllowed: true,
      trainingAllowed: true,
      redistributionAllowed: false,
    },
    privacy: {
      containsPersonalData: false,
      containsSpecialCategoryData: false,
    },
    permittedPurposes: ["evaluation", "training"],
    ...overrides,
  };
}

function captureInput(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "raeburnai.evaluation-candidate.v1",
    trigger: "benchmark_failure",
    sourceRef: "workflow:run-001",
    task: "Verify a factual answer",
    domain: "research",
    prompt: "Which primary source supports the disputed statement?",
    observedOutput: "The model cited a source that was not in evidence.",
    confidence: 0.42,
    reasonLabels: ["fabricated_citation"],
    metadata: { benchmarkCaseId: "citation.failure.001" },
    provenance: provenance(),
    ...overrides,
  };
}

async function clean() {
  await db.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
}

describeWithDatabase("evaluation candidate quarantine pipeline", () => {
  beforeAll(async () => {
    await clean();
    await db.tenant.createMany({
      data: [
        { id: tenantA, slug: tenantA, name: "Evaluation tenant A" },
        { id: tenantB, slug: tenantB, name: "Evaluation tenant B" },
      ],
    });
  });

  afterAll(async () => {
    await clean();
  });

  it("redacts detected direct identifiers and credentials before persistence and audit", async () => {
    const result = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "support-case:alice@example.com",
        prompt:
          "Email alice@example.com and use api_key=super-secret-key-123 to reproduce the failure.",
        metadata: {
          email: "alice@example.com",
          token: "raw-token-value",
        },
        provenance: provenance({
          privacy: {
            containsPersonalData: true,
            containsSpecialCategoryData: false,
            lawfulBasis: "quality-improvement-legitimate-interest",
          },
        }),
      }),
      context(),
    );

    expect(result.deduplicated).toBe(false);
    expect(result.candidate.prompt).not.toContain("alice@example.com");
    expect(result.candidate.prompt).not.toContain("super-secret-key-123");
    expect(JSON.stringify(result.candidate.metadata)).not.toContain(
      "raw-token-value",
    );
    expect(result.candidate.redactionCount).toBeGreaterThanOrEqual(3);
    expect(result.candidate.findingTypes).toEqual(
      expect.arrayContaining(["credential", "email"]),
    );

    const occurrence = await db.evaluationCandidateOccurrence.findFirstOrThrow({
      where: { candidateId: result.candidate.id, tenantId: tenantA },
    });
    expect(occurrence.sourceRefHash).toMatch(/^[a-f0-9]{64}$/);
    expect(occurrence.sourceRefHash).not.toContain("alice");

    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        tenantId: tenantA,
        action: "evaluation.candidate.quarantined",
      },
      orderBy: { createdAt: "desc" },
    });
    const auditText = JSON.stringify(audit.metadata);
    expect(auditText).toContain(result.candidate.fingerprint);
    expect(auditText).not.toContain("alice@example.com");
    expect(auditText).not.toContain("super-secret-key-123");
    expect(auditText).not.toContain("raw-token-value");
  });

  it("deduplicates equivalent failures while preserving occurrence evidence", async () => {
    const first = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "benchmark:run-a",
        prompt: "A repeatable counterexample with no personal data.",
      }),
      context(tenantA, "quality-operator", "dedupe-a"),
    );
    const second = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "benchmark:run-b",
        prompt: "A repeatable counterexample with no personal data.",
      }),
      context(tenantA, "quality-operator", "dedupe-b"),
    );

    expect(first.candidate.id).toBe(second.candidate.id);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.candidate.occurrenceCount).toBe(2);
    expect(
      await db.evaluationCandidateOccurrence.count({
        where: { candidateId: first.candidate.id, tenantId: tenantA },
      }),
    ).toBe(2);
  });

  it("fails closed on privacy declaration mismatch and special-category provenance", async () => {
    await expect(
      captureEvaluationCandidate(
        captureInput({
          prompt: "Contact undeclared@example.com about the failure.",
        }),
        context(tenantA, "quality-operator", "privacy-mismatch"),
      ),
    ).rejects.toMatchObject({
      code: "privacy_declaration_mismatch",
    });

    await expect(
      captureEvaluationCandidate(
        captureInput({
          provenance: provenance({
            privacy: {
              containsPersonalData: true,
              containsSpecialCategoryData: true,
              lawfulBasis: "test-basis",
            },
          }),
        }),
        context(tenantA, "quality-operator", "special-category"),
      ),
    ).rejects.toMatchObject({
      code: "special_category_data_not_allowed",
    });
  });

  it("requires reviewed provenance and a matching human correction before approval", async () => {
    const input = captureInput({
      trigger: "human_correction",
      sourceRef: "support:correction-1",
      task: "Correct an unsupported factual answer",
      prompt: "What is the approved status?",
      observedOutput: "The status is ACTIVE.",
      correction: "The status is INACTIVE.",
      reasonLabels: ["incorrect_answer"],
    });
    const captured = await captureEvaluationCandidate(
      input,
      context(tenantA, "quality-operator", "correction-capture"),
    );

    const record = DatasetRecordSchema.parse({
      contractVersion: "raeburnai.dataset-record.v1",
      id: "counterexample.correction.001",
      task: input.task,
      domain: "research",
      jurisdiction: "GB",
      date: "2026-09-23",
      difficulty: "medium",
      confidence: 1,
      prompt: captured.candidate.prompt,
      idealAnswer: captured.candidate.correction,
      badAnswer: captured.candidate.observedOutput,
      critique: "The observed answer contradicted the reviewed source state.",
      evidence: [],
      toolTrace: [],
      provenance: input.provenance,
    });

    const approved = await reviewEvaluationCandidate(
      captured.candidate.id,
      {
        decision: "approve_evaluation",
        note: "Human-reviewed correction with matching provenance.",
        datasetRecord: record,
      },
      context(tenantA, "quality-reviewer", "review-1"),
    );

    expect(approved.status).toBe(
      EvaluationCandidateStatus.APPROVED_EVALUATION,
    );
    expect(approved.reviewedBy).toBe("quality-reviewer");
    expect(approved.approvedRecordDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.reviews).toHaveLength(1);

    const jsonl = await exportApprovedEvaluationRecordsJsonl(
      context(tenantA, "quality-reviewer", "export-1"),
      "evaluation",
    );
    const exported = parseDatasetRecordsJsonl(jsonl, "evaluation");
    expect(exported.some((item) => item.id === record.id)).toBe(true);

    await expect(
      reviewEvaluationCandidate(
        captured.candidate.id,
        { decision: "reject", note: "Second review must not win." },
        context(tenantA, "another-reviewer", "review-2"),
      ),
    ).rejects.toMatchObject({ code: "candidate_already_reviewed" });
  });

  it("does not allow a reviewer to launder licence permissions into training", async () => {
    const sourceProvenance = provenance({
      license: {
        identifier: "evaluation-only",
        evaluationAllowed: true,
        trainingAllowed: false,
        redistributionAllowed: false,
      },
    });
    const captured = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "benchmark:eval-only",
        prompt: "Evaluation-only example.",
        provenance: sourceProvenance,
      }),
      context(tenantA, "quality-operator", "eval-only-capture"),
    );
    const record = DatasetRecordSchema.parse({
      contractVersion: "raeburnai.dataset-record.v1",
      id: "counterexample.eval-only.001",
      task: "Verify a factual answer",
      domain: "research",
      jurisdiction: "GB",
      date: "2026-09-23",
      difficulty: "medium",
      confidence: 0.9,
      prompt: captured.candidate.prompt,
      idealAnswer: "Use only the admissible evaluation path.",
      badAnswer: captured.candidate.observedOutput,
      evidence: [],
      toolTrace: [],
      provenance: sourceProvenance,
    });

    await expect(
      reviewEvaluationCandidate(
        captured.candidate.id,
        {
          decision: "approve_training",
          note: "Training must remain licence-gated.",
          datasetRecord: record,
        },
        context(tenantA, "quality-reviewer", "training-denied"),
      ),
    ).rejects.toThrowError(
      new DatasetAdmissibilityError("license_not_permitted"),
    );

    const unchanged = await db.evaluationCandidate.findUniqueOrThrow({
      where: { id: captured.candidate.id },
    });
    expect(unchanged.status).toBe(EvaluationCandidateStatus.QUARANTINED);
    expect(
      await db.evaluationCandidateReview.count({
        where: { candidateId: captured.candidate.id },
      }),
    ).toBe(0);
  });

  it("keeps candidate visibility and review tenant-bound", async () => {
    const captured = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "tenant-a-only",
        prompt: "Tenant A quality failure.",
      }),
      context(tenantA, "quality-operator", "tenant-a-capture"),
    );

    expect(
      await listEvaluationCandidates(
        context(tenantB, "tenant-b-auditor", "tenant-b-list"),
      ),
    ).toEqual([]);

    await expect(
      reviewEvaluationCandidate(
        captured.candidate.id,
        { decision: "reject", note: "Cross-tenant review must fail." },
        context(tenantB, "tenant-b-reviewer", "tenant-b-review"),
      ),
    ).rejects.toThrowError(
      new EvaluationCandidateError("candidate_not_found"),
    );
  });

  it("allows only one concurrent terminal review", async () => {
    const captured = await captureEvaluationCandidate(
      captureInput({
        sourceRef: "race:review",
        prompt: "Concurrent reviewers must not both decide this candidate.",
      }),
      context(tenantA, "quality-operator", "race-capture"),
    );

    const reviews = await Promise.allSettled([
      reviewEvaluationCandidate(
        captured.candidate.id,
        { decision: "reject", note: "Reviewer A rejects the case." },
        context(tenantA, "reviewer-a", "race-a"),
      ),
      reviewEvaluationCandidate(
        captured.candidate.id,
        { decision: "reject", note: "Reviewer B rejects the case." },
        context(tenantA, "reviewer-b", "race-b"),
      ),
    ]);
    expect(reviews.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(reviews.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await db.evaluationCandidateReview.count({
        where: { candidateId: captured.candidate.id },
      }),
    ).toBe(1);
  });

  it("enforces trigger invariants at the PostgreSQL boundary", async () => {
    await expect(
      db.evaluationCandidate.create({
        data: {
          tenantId: tenantA,
          fingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          trigger: EvaluationCandidateTrigger.LOW_CONFIDENCE,
          task: "Invalid direct write",
          domain: "research",
          prompt: "This must fail at the database boundary.",
          confidence: 0.9,
          reasonLabels: ["other"],
          toolTrace: [],
          metadata: {},
          provenance: provenance(),
          classification: "general",
          findingTypes: [],
          redactionCount: 0,
          occurrenceCount: 1,
        },
      }),
    ).rejects.toThrow();

    expect(
      await db.evaluationCandidate.count({
        where: {
          tenantId: tenantA,
          fingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
    ).toBe(0);
  });
});
