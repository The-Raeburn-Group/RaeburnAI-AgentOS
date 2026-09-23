import {
  EvaluationCandidateStatus,
  type AuditEvent,
  type EvaluationCandidate,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  DatasetRecordSchema,
  assertEvaluationRecordAdmissible,
  assertTrainingRecordAdmissible,
  type DatasetRecord,
} from "@/lib/dataset-provenance";
import {
  MemoryPolicyError,
  sanitizeMemoryCandidate,
} from "@/lib/memory-policy";
import { sha256 } from "@/lib/raeburnbench";
import type { JsonValue } from "@/lib/types";

export const QUALITY_LOOP_CONTRACT_VERSION =
  "raeburnai.quality-loop.v1" as const;

export const QUALITY_FAILURE_ACTIONS = [
  "workflow.job.dead_lettered",
  "agent.failed",
  "workflow.adjudication.rejected",
] as const;

export type QualityFailureAction = (typeof QUALITY_FAILURE_ACTIONS)[number];

export const EvaluationFailureKindSchema = z.enum([
  "authorization",
  "provider",
  "timeout",
  "validation",
  "tool",
  "adjudication",
  "execution",
]);
export type EvaluationFailureKind = z.infer<typeof EvaluationFailureKindSchema>;

const ReviewInputSchema = z.object({
  decision: z.enum(["accept", "reject"]),
  reviewer: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2_000).optional(),
});

const PromotionInputSchema = z.object({
  reviewer: z.string().trim().min(1).max(200),
  record: z.unknown(),
});

export class QualityLoopError extends Error {
  constructor(
    public readonly code:
      | "candidate_not_found"
      | "invalid_transition"
      | "counterexample_incomplete"
      | "counterexample_source_mismatch",
  ) {
    super(code);
    this.name = "QualityLoopError";
  }
}

type FailureEvent = Pick<
  AuditEvent,
  "id" | "tenantId" | "runId" | "action" | "metadata" | "createdAt"
>;

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function metadataRecord(
  value: Prisma.JsonValue,
): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, Prisma.JsonValue>;
}

function metadataString(
  metadata: Record<string, Prisma.JsonValue>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(
  metadata: Record<string, Prisma.JsonValue>,
  key: string,
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function failureKind(action: string, detail: string): EvaluationFailureKind {
  if (action === "workflow.adjudication.rejected") return "adjudication";
  const normalized = (action + " " + detail).toLowerCase();
  if (/auth|permission|forbidden|unauthori[sz]ed|credential/.test(normalized)) {
    return "authorization";
  }
  if (/timeout|timed out|deadline|lease expired/.test(normalized)) {
    return "timeout";
  }
  if (/schema|validation|invalid|parse|malformed/.test(normalized)) {
    return "validation";
  }
  if (/tool|mcp|connector/.test(normalized)) {
    return "tool";
  }
  if (/provider|model|openai|openrouter|ollama/.test(normalized)) {
    return "provider";
  }
  return "execution";
}

function failureSeverity(action: string): "medium" | "high" {
  return action === "agent.failed" ? "medium" : "high";
}

function safeFailurePayload(
  event: FailureEvent,
  detail: string,
): {
  summary: string;
  metadata: Record<string, JsonValue>;
  redactionCount: number;
} {
  const raw = metadataRecord(event.metadata);
  const safeMetadata: Record<string, JsonValue> = {
    qualityContractVersion: QUALITY_LOOP_CONTRACT_VERSION,
    sourceEventId: event.id,
    sourceAction: event.action,
  };
  if (event.runId) safeMetadata.runId = event.runId;

  for (const key of [
    "requestId",
    "taskId",
    "agentId",
    "risk",
    "reason",
    "error",
  ]) {
    const value = metadataString(raw, key);
    if (value) safeMetadata[key] = value;
  }
  for (const key of ["attempt", "attempts", "maxAttempts"]) {
    const value = metadataNumber(raw, key);
    if (value !== undefined) safeMetadata[key] = value;
  }

  try {
    const sanitized = sanitizeMemoryCandidate({
      content: detail,
      metadata: safeMetadata,
    });
    return {
      summary: sanitized.content.slice(0, 2_000),
      metadata: sanitized.metadata,
      redactionCount: sanitized.redactionCount,
    };
  } catch (error) {
    if (!(error instanceof MemoryPolicyError)) throw error;
    return {
      summary: "[REDACTED:UNSAFE_FAILURE_DETAIL]",
      metadata: {
        qualityContractVersion: QUALITY_LOOP_CONTRACT_VERSION,
        sourceEventId: event.id,
        sourceAction: event.action,
        ...(event.runId ? { runId: event.runId } : {}),
        unsafeFailureDetailRejected: true,
      },
      redactionCount: 1,
    };
  }
}

export function projectFailureAuditEvent(event: FailureEvent) {
  if (!QUALITY_FAILURE_ACTIONS.includes(event.action as QualityFailureAction)) {
    throw new Error("unsupported quality failure action");
  }
  const metadata = metadataRecord(event.metadata);
  const detail =
    metadataString(metadata, "error") ??
    metadataString(metadata, "reason") ??
    event.action;
  const kind = failureKind(event.action, detail);
  const safe = safeFailurePayload(event, detail);
  const fingerprint = sha256({
    tenantId: event.tenantId,
    sourceAction: event.action,
    failureKind: kind,
    summary: safe.summary,
  });

  return {
    fingerprint,
    failureKind: kind,
    severity: failureSeverity(event.action),
    summary: safe.summary,
    reasonLabels: [kind, event.action.replaceAll(".", "_")].sort(),
    metadata: {
      ...safe.metadata,
      redactionCount: safe.redactionCount,
      sourceCreatedAt: event.createdAt.toISOString(),
    } satisfies Record<string, JsonValue>,
  };
}

export async function ingestFailureAuditEvents(
  options: {
    limit?: number;
  } = {},
): Promise<{
  scanned: number;
  projected: number;
  skipped: number;
}> {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(options.limit ?? 100);
  const events = await db.auditEvent.findMany({
    where: {
      action: { in: [...QUALITY_FAILURE_ACTIONS] },
      evaluationCandidateOccurrence: { is: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let projected = 0;
  let skipped = 0;

  for (const event of events) {
    const projection = projectFailureAuditEvent(event);
    try {
      await db.$transaction(async (tx) => {
        const candidate = await tx.evaluationCandidate.upsert({
          where: {
            tenantId_fingerprint: {
              tenantId: event.tenantId,
              fingerprint: projection.fingerprint,
            },
          },
          update: {
            severity: projection.severity,
            summary: projection.summary,
            reasonLabels: projection.reasonLabels,
            metadata: inputJson(projection.metadata),
            occurrenceCount: { increment: 1 },
            lastSeenAt: event.createdAt,
          },
          create: {
            tenantId: event.tenantId,
            fingerprint: projection.fingerprint,
            failureKind: projection.failureKind,
            severity: projection.severity,
            summary: projection.summary,
            reasonLabels: projection.reasonLabels,
            metadata: inputJson(projection.metadata),
            firstSeenAt: event.createdAt,
            lastSeenAt: event.createdAt,
          },
        });

        await tx.evaluationCandidateOccurrence.create({
          data: {
            candidateId: candidate.id,
            sourceEventId: event.id,
          },
        });

        await tx.auditEvent.create({
          data: {
            tenantId: event.tenantId,
            runId: event.runId,
            actor: "quality-loop",
            action: "quality.evaluation_candidate.captured",
            metadata: {
              qualityContractVersion: QUALITY_LOOP_CONTRACT_VERSION,
              candidateId: candidate.id,
              sourceEventId: event.id,
              fingerprint: projection.fingerprint,
              failureKind: projection.failureKind,
              severity: projection.severity,
            },
          },
        });
      });
      projected += 1;
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  return { scanned: events.length, projected, skipped };
}

export async function reviewEvaluationCandidate(options: {
  tenantId: string;
  candidateId: string;
  decision: "accept" | "reject";
  reviewer: string;
  note?: string;
}): Promise<EvaluationCandidate> {
  const input = ReviewInputSchema.parse(options);
  const candidate = await db.evaluationCandidate.findFirst({
    where: {
      id: options.candidateId,
      tenantId: options.tenantId,
    },
  });
  if (!candidate) throw new QualityLoopError("candidate_not_found");

  const targetStatus =
    input.decision === "accept"
      ? EvaluationCandidateStatus.ACCEPTED
      : EvaluationCandidateStatus.REJECTED;
  if (candidate.status === targetStatus) return candidate;
  if (candidate.status !== EvaluationCandidateStatus.PENDING_REVIEW) {
    throw new QualityLoopError("invalid_transition");
  }

  return db.$transaction(async (tx) => {
    const transition = await tx.evaluationCandidate.updateMany({
      where: {
        id: candidate.id,
        tenantId: options.tenantId,
        status: EvaluationCandidateStatus.PENDING_REVIEW,
      },
      data: {
        status: targetStatus,
        reviewedBy: input.reviewer,
        reviewNote: input.note ?? null,
        reviewedAt: new Date(),
      },
    });
    const reviewed = await tx.evaluationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    if (transition.count !== 1) {
      if (reviewed.status === targetStatus) return reviewed;
      throw new QualityLoopError("invalid_transition");
    }
    await tx.auditEvent.create({
      data: {
        tenantId: candidate.tenantId,
        actor: input.reviewer,
        action: "quality.evaluation_candidate.reviewed",
        metadata: {
          qualityContractVersion: QUALITY_LOOP_CONTRACT_VERSION,
          candidateId: candidate.id,
          decision: input.decision,
        },
      },
    });
    return reviewed;
  });
}

function validatedCounterexampleRecord(
  candidate: EvaluationCandidate,
  input: unknown,
): DatasetRecord {
  const record = DatasetRecordSchema.parse(input);
  if (record.provenance.sourceId !== "evaluation-candidate:" + candidate.id) {
    throw new QualityLoopError("counterexample_source_mismatch");
  }
  if (!record.badAnswer?.trim() || !record.critique?.trim()) {
    throw new QualityLoopError("counterexample_incomplete");
  }

  assertEvaluationRecordAdmissible(record);
  if (record.provenance.permittedPurposes.includes("training")) {
    assertTrainingRecordAdmissible(record);
  }
  return record;
}

export async function promoteEvaluationCandidate(options: {
  tenantId: string;
  candidateId: string;
  reviewer: string;
  record: unknown;
}): Promise<EvaluationCandidate> {
  const input = PromotionInputSchema.parse(options);
  const candidate = await db.evaluationCandidate.findFirst({
    where: {
      id: options.candidateId,
      tenantId: options.tenantId,
    },
  });
  if (!candidate) throw new QualityLoopError("candidate_not_found");
  if (candidate.status !== EvaluationCandidateStatus.ACCEPTED) {
    throw new QualityLoopError("invalid_transition");
  }

  const record = validatedCounterexampleRecord(candidate, input.record);
  return db.$transaction(async (tx) => {
    const transition = await tx.evaluationCandidate.updateMany({
      where: {
        id: candidate.id,
        tenantId: options.tenantId,
        status: EvaluationCandidateStatus.ACCEPTED,
      },
      data: {
        status: EvaluationCandidateStatus.PROMOTED,
        datasetRecord: inputJson(record),
        promotedAt: new Date(),
      },
    });
    if (transition.count !== 1) {
      throw new QualityLoopError("invalid_transition");
    }
    const promoted = await tx.evaluationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: candidate.tenantId,
        actor: input.reviewer,
        action: "quality.counterexample.promoted",
        metadata: {
          qualityContractVersion: QUALITY_LOOP_CONTRACT_VERSION,
          candidateId: candidate.id,
          datasetRecordId: record.id,
          permittedPurposes: record.provenance.permittedPurposes,
        },
      },
    });
    return promoted;
  });
}
