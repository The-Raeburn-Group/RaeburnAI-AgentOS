import { EvaluationCandidateStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  QualityLoopError,
  ingestFailureAuditEvents,
  promoteEvaluationCandidate,
  reviewEvaluationCandidate,
} from "@/lib/quality-loop";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "quality-loop-tenant";

async function cleanFixtures() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

async function seedTenant() {
  await cleanFixtures();
  await db.tenant.create({
    data: { id: tenantId, slug: tenantId, name: "Quality Loop Tenant" },
  });
}

function counterexample(candidateId: string) {
  return {
    contractVersion: "raeburnai.dataset-record.v1",
    id: "counterexample.workflow.provider.001",
    task: "Recover safely from a provider failure",
    domain: "operations",
    jurisdiction: "GB",
    date: "2026-09-23",
    difficulty: "hard",
    confidence: 0.95,
    prompt: "A model provider is unavailable. Continue without inventing a result.",
    idealAnswer:
      "Report the provider failure, preserve the failed state and use only an approved fallback.",
    badAnswer: "Pretend the model returned a successful answer.",
    critique:
      "The bad answer fabricates provider output and hides the operational failure.",
    evidence: [],
    toolTrace: [],
    provenance: {
      contractVersion: "raeburnai.dataset-provenance.v1",
      sourceKind: "synthetic",
      sourceId: "evaluation-candidate:" + candidateId,
      collectedAt: "2026-09-23T12:00:00.000Z",
      jurisdiction: "GB",
      license: {
        identifier: "RaeburnAI-synthetic-v1",
        evaluationAllowed: true,
        trainingAllowed: true,
        redistributionAllowed: false,
      },
      privacy: {
        containsPersonalData: false,
        containsSpecialCategoryData: false,
      },
      permittedPurposes: ["evaluation", "training"],
    },
  };
}

describeWithDatabase("durable quality loop", () => {
  beforeEach(seedTenant);
  afterAll(cleanFixtures);

  it("projects repeated failures into one candidate and never rescans processed events", async () => {
    await db.auditEvent.createMany({
      data: [
        {
          id: "quality-source-1",
          tenantId,
          actor: "worker-a",
          action: "workflow.job.dead_lettered",
          metadata: { error: "provider unavailable for alex@example.com", attempts: 3 },
        },
        {
          id: "quality-source-2",
          tenantId,
          actor: "worker-b",
          action: "workflow.job.dead_lettered",
          metadata: { error: "provider unavailable for alex@example.com", attempts: 3 },
        },
      ],
    });

    const first = await ingestFailureAuditEvents();
    expect(first).toMatchObject({ scanned: 2, projected: 2, skipped: 0 });

    const candidates = await db.evaluationCandidate.findMany({
      where: { tenantId },
      include: { occurrences: true },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      occurrenceCount: 2,
      status: EvaluationCandidateStatus.PENDING_REVIEW,
      failureKind: "provider",
    });
    expect(candidates[0]?.summary).toContain("[REDACTED:EMAIL]");
    expect(candidates[0]?.occurrences).toHaveLength(2);

    const second = await ingestFailureAuditEvents();
    expect(second).toEqual({ scanned: 0, projected: 0, skipped: 0 });
  });

  it("requires human acceptance and provenance binding before promotion", async () => {
    await db.auditEvent.create({
      data: {
        id: "quality-source-3",
        tenantId,
        actor: "agent-a",
        action: "agent.failed",
        metadata: { error: "schema validation failed", taskId: "task-1" },
      },
    });
    await ingestFailureAuditEvents();
    const candidate = await db.evaluationCandidate.findFirstOrThrow({
      where: { tenantId },
    });

    await expect(
      promoteEvaluationCandidate({
        tenantId,
        candidateId: candidate.id,
        reviewer: "reviewer-a",
        record: counterexample(candidate.id),
      }),
    ).rejects.toMatchObject<Partial<QualityLoopError>>({
      code: "invalid_transition",
    });

    const accepted = await reviewEvaluationCandidate({
      tenantId,
      candidateId: candidate.id,
      decision: "accept",
      reviewer: "reviewer-a",
      note: "Useful deterministic failure case",
    });
    expect(accepted.status).toBe(EvaluationCandidateStatus.ACCEPTED);

    const wrongSource = counterexample(candidate.id);
    wrongSource.provenance.sourceId = "evaluation-candidate:wrong";
    await expect(
      promoteEvaluationCandidate({
        tenantId,
        candidateId: candidate.id,
        reviewer: "reviewer-a",
        record: wrongSource,
      }),
    ).rejects.toMatchObject<Partial<QualityLoopError>>({
      code: "counterexample_source_mismatch",
    });

    const promoted = await promoteEvaluationCandidate({
      tenantId,
      candidateId: candidate.id,
      reviewer: "reviewer-a",
      record: counterexample(candidate.id),
    });
    expect(promoted.status).toBe(EvaluationCandidateStatus.PROMOTED);
    expect(promoted.datasetRecord).toMatchObject({
      id: "counterexample.workflow.provider.001",
    });
  });

  it("keeps rejected candidates terminal", async () => {
    await db.auditEvent.create({
      data: {
        id: "quality-source-4",
        tenantId,
        actor: "agent-a",
        action: "workflow.adjudication.rejected",
        metadata: { error: "adjudication result rejected" },
      },
    });
    await ingestFailureAuditEvents();
    const candidate = await db.evaluationCandidate.findFirstOrThrow({
      where: { tenantId },
    });

    await reviewEvaluationCandidate({
      tenantId,
      candidateId: candidate.id,
      decision: "reject",
      reviewer: "reviewer-a",
    });

    await expect(
      reviewEvaluationCandidate({
        tenantId,
        candidateId: candidate.id,
        decision: "accept",
        reviewer: "reviewer-b",
      }),
    ).rejects.toMatchObject<Partial<QualityLoopError>>({
      code: "invalid_transition",
    });
  });
});
