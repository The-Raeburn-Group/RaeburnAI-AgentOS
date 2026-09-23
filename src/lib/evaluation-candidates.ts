import { createHash } from "node:crypto";
import {
  EvaluationCandidateStatus,
  EvaluationCandidateTrigger,
  EvaluationReviewDecision,
  Prisma,
} from "@prisma/client";
import { z } from "zod";
import {
  DatasetProvenanceSchema,
  DatasetRecordSchema,
  DatasetToolTraceSchema,
  assertEvaluationRecordAdmissible,
  assertTrainingRecordAdmissible,
  serializeDatasetRecordsJsonl,
  type DatasetRecord,
} from "@/lib/dataset-provenance";
import { db } from "@/lib/db";
import { resolveTenantReference } from "@/lib/human-tenant";
import {
  MemoryPolicyError,
  sanitizeMemoryCandidate,
  type MemoryClassification,
  type MemoryFindingType,
} from "@/lib/memory-policy";
import { JsonValueSchema, type JsonValue } from "@/lib/types";

export const EVALUATION_CANDIDATE_CONTRACT_VERSION =
  "raeburnai.evaluation-candidate.v1" as const;

export const EvaluationCandidateTriggerSchema = z.enum([
  "benchmark_failure",
  "human_correction",
  "tool_failure",
  "low_confidence",
  "security_event",
  "manual",
]);

export const EvaluationReasonLabelSchema = z.enum([
  "unsupported_claim",
  "stale_fact",
  "fabricated_citation",
  "incorrect_answer",
  "tool_selection",
  "tool_arguments",
  "tool_failure",
  "approval_bypass",
  "prompt_injection",
  "routing_error",
  "unsafe_output",
  "other",
]);

export const EvaluationCandidateCaptureSchema = z
  .object({
    contractVersion: z
      .literal(EVALUATION_CANDIDATE_CONTRACT_VERSION)
      .default(EVALUATION_CANDIDATE_CONTRACT_VERSION),
    trigger: EvaluationCandidateTriggerSchema,
    sourceRef: z.string().trim().min(1).max(512),
    task: z.string().trim().min(3).max(256),
    domain: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    prompt: z.string().min(1).max(50_000),
    observedOutput: z.string().max(50_000).optional(),
    correction: z.string().min(1).max(50_000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reasonLabels: z
      .array(EvaluationReasonLabelSchema)
      .min(1)
      .max(12)
      .transform((labels) => [...new Set(labels)].sort()),
    toolTrace: z.array(DatasetToolTraceSchema).max(100).default([]),
    metadata: z.record(JsonValueSchema).default({}),
    provenance: DatasetProvenanceSchema,
    sensitivityLabels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  })
  .superRefine((value, context) => {
    if (value.trigger === "human_correction" && !value.correction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correction"],
        message: "human corrections require the corrected output",
      });
    }
    if (
      value.trigger === "low_confidence" &&
      (value.confidence === undefined || value.confidence > 0.5)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: "low-confidence capture requires confidence <= 0.5",
      });
    }
    if (
      value.trigger === "tool_failure" &&
      !value.toolTrace.some((item) => !item.succeeded)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolTrace"],
        message: "tool-failure capture requires at least one failed tool trace",
      });
    }
  });

export const EvaluationCandidateReviewSchema = z
  .object({
    decision: z.enum(["approve_evaluation", "approve_training", "reject"]),
    note: z.string().trim().min(3).max(2_000),
    datasetRecord: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    if (value.decision !== "reject" && value.datasetRecord === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetRecord"],
        message: "approved candidates require a reviewed dataset record",
      });
    }
    if (value.decision === "reject" && value.datasetRecord !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["datasetRecord"],
        message: "rejected candidates must not carry a promoted dataset record",
      });
    }
  });

export type EvaluationCandidateCapture = z.output<
  typeof EvaluationCandidateCaptureSchema
>;
export type EvaluationCandidateReview = z.output<
  typeof EvaluationCandidateReviewSchema
>;

export interface EvaluationExecutionContext {
  tenantReference: string;
  actorId: string;
  requestId: string;
}

export class EvaluationCandidateError extends Error {
  constructor(
    public readonly code:
      | "tenant_not_found"
      | "candidate_not_found"
      | "candidate_already_reviewed"
      | "candidate_review_conflict"
      | "special_category_data_not_allowed"
      | "privacy_declaration_mismatch"
      | "approved_record_mismatch"
      | "approved_record_provenance_mismatch"
      | "approved_record_requires_redaction",
    public readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = "EvaluationCandidateError";
  }
}

interface SanitizationAccumulator {
  findingTypes: Set<MemoryFindingType>;
  redactionCount: number;
  classification: MemoryClassification;
}

const classificationRank: Record<MemoryClassification, number> = {
  general: 0,
  personal: 1,
  sensitive: 2,
};

function mergeSanitization(
  accumulator: SanitizationAccumulator,
  result: {
    findingTypes: MemoryFindingType[];
    redactionCount: number;
    classification: MemoryClassification;
  },
): void {
  result.findingTypes.forEach((item) => accumulator.findingTypes.add(item));
  accumulator.redactionCount += result.redactionCount;
  if (
    classificationRank[result.classification] >
    classificationRank[accumulator.classification]
  ) {
    accumulator.classification = result.classification;
  }
}

function sanitizeText(
  value: string | undefined,
  sensitivityLabels: string[],
  accumulator: SanitizationAccumulator,
): string | undefined {
  if (value === undefined) return undefined;
  const result = sanitizeMemoryCandidate({
    content: value,
    metadata: {},
    sensitivityLabels,
  });
  mergeSanitization(accumulator, result);
  return result.content;
}

function sanitizeMetadata(
  metadata: Record<string, JsonValue>,
  sensitivityLabels: string[],
  accumulator: SanitizationAccumulator,
): Record<string, JsonValue> {
  const result = sanitizeMemoryCandidate({
    content: "evaluation-candidate-metadata",
    metadata,
    sensitivityLabels,
  });
  mergeSanitization(accumulator, result);
  return result.metadata;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

const triggerMap: Record<
  z.infer<typeof EvaluationCandidateTriggerSchema>,
  EvaluationCandidateTrigger
> = {
  benchmark_failure: EvaluationCandidateTrigger.BENCHMARK_FAILURE,
  human_correction: EvaluationCandidateTrigger.HUMAN_CORRECTION,
  tool_failure: EvaluationCandidateTrigger.TOOL_FAILURE,
  low_confidence: EvaluationCandidateTrigger.LOW_CONFIDENCE,
  security_event: EvaluationCandidateTrigger.SECURITY_EVENT,
  manual: EvaluationCandidateTrigger.MANUAL,
};

function sanitizedCapture(input: unknown) {
  const parsed = EvaluationCandidateCaptureSchema.parse(input);
  if (parsed.provenance.privacy.containsSpecialCategoryData) {
    throw new EvaluationCandidateError("special_category_data_not_allowed");
  }

  const accumulator: SanitizationAccumulator = {
    findingTypes: new Set(),
    redactionCount: 0,
    classification: "general",
  };
  const sourceRef = sanitizeText(
    parsed.sourceRef,
    parsed.sensitivityLabels,
    accumulator,
  )!;
  const prompt = sanitizeText(
    parsed.prompt,
    parsed.sensitivityLabels,
    accumulator,
  )!;
  const observedOutput = sanitizeText(
    parsed.observedOutput,
    parsed.sensitivityLabels,
    accumulator,
  );
  const correction = sanitizeText(
    parsed.correction,
    parsed.sensitivityLabels,
    accumulator,
  );
  const metadata = sanitizeMetadata(
    parsed.metadata,
    parsed.sensitivityLabels,
    accumulator,
  );
  const toolTrace = parsed.toolTrace.map((trace) => ({
    tool: sanitizeText(trace.tool, parsed.sensitivityLabels, accumulator)!,
    action: sanitizeText(trace.action, parsed.sensitivityLabels, accumulator)!,
    outputSummary: sanitizeText(
      trace.outputSummary,
      parsed.sensitivityLabels,
      accumulator,
    )!,
    succeeded: trace.succeeded,
  }));

  const detectedPersonal = [...accumulator.findingTypes].some((finding) =>
    ["email", "phone", "payment_card", "national_id"].includes(finding),
  );
  if (detectedPersonal && !parsed.provenance.privacy.containsPersonalData) {
    throw new EvaluationCandidateError(
      "privacy_declaration_mismatch",
      "detected personal data must be declared in provenance before capture",
    );
  }

  const provenanceFingerprint = {
    sourceKind: parsed.provenance.sourceKind,
    jurisdiction: parsed.provenance.jurisdiction,
    license: parsed.provenance.license,
    privacy: parsed.provenance.privacy,
    permittedPurposes: [...parsed.provenance.permittedPurposes].sort(),
  };
  const fingerprint = digest({
    contractVersion: parsed.contractVersion,
    trigger: parsed.trigger,
    task: parsed.task,
    domain: parsed.domain,
    prompt,
    observedOutput: observedOutput ?? null,
    correction: correction ?? null,
    confidence: parsed.confidence ?? null,
    reasonLabels: parsed.reasonLabels,
    toolTrace,
    metadata,
    provenance: provenanceFingerprint,
  });

  return {
    parsed,
    sourceRefHash: digest(sourceRef),
    fingerprint,
    prompt,
    observedOutput,
    correction,
    toolTrace,
    metadata,
    classification: accumulator.classification,
    findingTypes: [...accumulator.findingTypes].sort(),
    redactionCount: accumulator.redactionCount,
  };
}

async function tenantIdFor(reference: string): Promise<string> {
  const tenant = await resolveTenantReference(reference);
  if (!tenant) throw new EvaluationCandidateError("tenant_not_found");
  return tenant.id;
}

export async function captureEvaluationCandidate(
  input: unknown,
  context: EvaluationExecutionContext,
) {
  let candidate;
  try {
    candidate = sanitizedCapture(input);
  } catch (error) {
    if (error instanceof MemoryPolicyError) {
      throw new EvaluationCandidateError(
        error.code === "high_risk_personal_data_not_allowed"
          ? "special_category_data_not_allowed"
          : "approved_record_requires_redaction",
        error.message,
      );
    }
    throw error;
  }

  const tenantId = await tenantIdFor(context.tenantReference);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const persisted = await tx.evaluationCandidate.upsert({
      where: {
        tenantId_fingerprint: {
          tenantId,
          fingerprint: candidate.fingerprint,
        },
      },
      create: {
        tenantId,
        fingerprint: candidate.fingerprint,
        trigger: triggerMap[candidate.parsed.trigger],
        task: candidate.parsed.task,
        domain: candidate.parsed.domain,
        prompt: candidate.prompt,
        observedOutput: candidate.observedOutput,
        correction: candidate.correction,
        confidence: candidate.parsed.confidence,
        reasonLabels: candidate.parsed.reasonLabels,
        toolTrace: candidate.toolTrace as Prisma.InputJsonValue,
        metadata: candidate.metadata as Prisma.InputJsonValue,
        provenance: candidate.parsed.provenance as Prisma.InputJsonValue,
        classification: candidate.classification,
        findingTypes: candidate.findingTypes,
        redactionCount: candidate.redactionCount,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        occurrenceCount: { increment: 1 },
        lastSeenAt: now,
      },
    });

    await tx.evaluationCandidateOccurrence.create({
      data: {
        tenantId,
        candidateId: persisted.id,
        sourceRefHash: candidate.sourceRefHash,
        actorId: context.actorId,
        requestId: context.requestId,
        createdAt: now,
      },
    });

    const deduplicated = persisted.occurrenceCount > 1;
    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: context.actorId,
        action: deduplicated
          ? "evaluation.candidate.deduplicated"
          : "evaluation.candidate.quarantined",
        metadata: {
          requestId: context.requestId,
          candidateId: persisted.id,
          fingerprint: persisted.fingerprint,
          trigger: persisted.trigger,
          reasonLabels: persisted.reasonLabels,
          classification: persisted.classification,
          findingTypes: persisted.findingTypes,
          redactionCount: persisted.redactionCount,
          occurrenceCount: persisted.occurrenceCount,
          sourceRefHash: candidate.sourceRefHash,
        },
      },
    });

    return { candidate: persisted, deduplicated };
  });
}

function assertApprovedRecordNeedsNoRedaction(record: DatasetRecord): void {
  const values = [
    record.prompt,
    record.idealAnswer,
    record.badAnswer ?? "",
    record.critique ?? "",
    ...record.evidence.map((item) => item.text),
    ...record.toolTrace.flatMap((item) => [
      item.tool,
      item.action,
      item.outputSummary,
    ]),
  ];
  try {
    for (const value of values) {
      if (!value) continue;
      const sanitized = sanitizeMemoryCandidate({
        content: value,
        metadata: {},
        sensitivityLabels: [],
      });
      if (sanitized.redactionCount > 0 || sanitized.content !== value) {
        throw new EvaluationCandidateError(
          "approved_record_requires_redaction",
          "approved dataset records must be explicitly redacted before promotion",
        );
      }
    }
  } catch (error) {
    if (error instanceof EvaluationCandidateError) throw error;
    if (error instanceof MemoryPolicyError) {
      throw new EvaluationCandidateError(
        "approved_record_requires_redaction",
        "approved dataset records cannot contain private keys or prohibited sensitive data",
      );
    }
    throw error;
  }
}

function reviewedRecordFor(
  candidate: {
    task: string;
    domain: string;
    prompt: string;
    observedOutput: string | null;
    correction: string | null;
    provenance: unknown;
  },
  review: EvaluationCandidateReview,
): DatasetRecord | undefined {
  if (review.decision === "reject") return undefined;
  const record =
    review.decision === "approve_training"
      ? assertTrainingRecordAdmissible(review.datasetRecord)
      : assertEvaluationRecordAdmissible(review.datasetRecord);

  if (
    record.task !== candidate.task ||
    record.domain !== candidate.domain ||
    record.prompt !== candidate.prompt
  ) {
    throw new EvaluationCandidateError(
      "approved_record_mismatch",
      "reviewed dataset record must preserve candidate task, domain and sanitized prompt",
    );
  }
  if (
    candidate.observedOutput !== null &&
    (record.badAnswer ?? null) !== candidate.observedOutput
  ) {
    throw new EvaluationCandidateError(
      "approved_record_mismatch",
      "reviewed dataset record must preserve the observed bad answer",
    );
  }
  if (
    candidate.correction !== null &&
    record.idealAnswer !== candidate.correction
  ) {
    throw new EvaluationCandidateError(
      "approved_record_mismatch",
      "human-correction candidates must preserve the reviewed correction as the ideal answer",
    );
  }

  const candidateProvenance = DatasetProvenanceSchema.parse(
    candidate.provenance,
  );
  if (digest(record.provenance) !== digest(candidateProvenance)) {
    throw new EvaluationCandidateError(
      "approved_record_provenance_mismatch",
      "review cannot silently alter candidate provenance or usage permissions",
    );
  }
  assertApprovedRecordNeedsNoRedaction(record);
  return DatasetRecordSchema.parse(record);
}

export async function reviewEvaluationCandidate(
  candidateId: string,
  reviewInput: unknown,
  context: EvaluationExecutionContext,
) {
  const review = EvaluationCandidateReviewSchema.parse(reviewInput);
  const tenantId = await tenantIdFor(context.tenantReference);
  const candidate = await db.evaluationCandidate.findFirst({
    where: { id: candidateId, tenantId },
  });
  if (!candidate) throw new EvaluationCandidateError("candidate_not_found");
  if (candidate.status !== EvaluationCandidateStatus.QUARANTINED) {
    throw new EvaluationCandidateError("candidate_already_reviewed");
  }

  const datasetRecord = reviewedRecordFor(candidate, review);
  const recordDigest = datasetRecord ? digest(datasetRecord) : undefined;
  const now = new Date();
  const status =
    review.decision === "approve_evaluation"
      ? EvaluationCandidateStatus.APPROVED_EVALUATION
      : review.decision === "approve_training"
        ? EvaluationCandidateStatus.APPROVED_TRAINING
        : EvaluationCandidateStatus.REJECTED;
  const decision =
    review.decision === "approve_evaluation"
      ? EvaluationReviewDecision.APPROVE_EVALUATION
      : review.decision === "approve_training"
        ? EvaluationReviewDecision.APPROVE_TRAINING
        : EvaluationReviewDecision.REJECT;

  return db.$transaction(async (tx) => {
    const updated = await tx.evaluationCandidate.updateMany({
      where: {
        id: candidate.id,
        tenantId,
        status: EvaluationCandidateStatus.QUARANTINED,
        updatedAt: candidate.updatedAt,
      },
      data: {
        status,
        reviewedBy: context.actorId,
        reviewedAt: now,
        approvedRecord: datasetRecord
          ? (datasetRecord as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        approvedRecordDigest: recordDigest ?? null,
      },
    });
    if (updated.count !== 1) {
      throw new EvaluationCandidateError("candidate_review_conflict");
    }

    await tx.evaluationCandidateReview.create({
      data: {
        tenantId,
        candidateId: candidate.id,
        reviewer: context.actorId,
        decision,
        note: review.note,
        datasetRecord: datasetRecord
          ? (datasetRecord as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        recordDigest: recordDigest ?? null,
        createdAt: now,
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: context.actorId,
        action: "evaluation.candidate.reviewed",
        metadata: {
          requestId: context.requestId,
          candidateId: candidate.id,
          fingerprint: candidate.fingerprint,
          decision,
          recordDigest: recordDigest ?? null,
        },
      },
    });

    return tx.evaluationCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { reviews: true, occurrences: true },
    });
  });
}

export async function listEvaluationCandidates(
  context: EvaluationExecutionContext,
  options: {
    status?: EvaluationCandidateStatus;
    trigger?: EvaluationCandidateTrigger;
    limit?: number;
  } = {},
) {
  const tenantId = await tenantIdFor(context.tenantReference);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return db.evaluationCandidate.findMany({
    where: {
      tenantId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.trigger ? { trigger: options.trigger } : {}),
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    take: limit,
    include: {
      occurrences: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      reviews: true,
    },
  });
}

export async function exportApprovedEvaluationRecordsJsonl(
  context: EvaluationExecutionContext,
  purpose: "evaluation" | "training",
): Promise<string> {
  const tenantId = await tenantIdFor(context.tenantReference);
  const status =
    purpose === "evaluation"
      ? EvaluationCandidateStatus.APPROVED_EVALUATION
      : EvaluationCandidateStatus.APPROVED_TRAINING;
  const rows = await db.evaluationCandidate.findMany({
    where: {
      tenantId,
      status,
      approvedRecord: { not: Prisma.JsonNull },
    },
    orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
  });
  const records = rows.map((row) => {
    const record =
      purpose === "evaluation"
        ? assertEvaluationRecordAdmissible(row.approvedRecord)
        : assertTrainingRecordAdmissible(row.approvedRecord);
    if (row.approvedRecordDigest !== digest(record)) {
      throw new EvaluationCandidateError(
        "approved_record_mismatch",
        `approved record digest mismatch for candidate ${row.id}`,
      );
    }
    return record;
  });
  return serializeDatasetRecordsJsonl(records, purpose);
}
