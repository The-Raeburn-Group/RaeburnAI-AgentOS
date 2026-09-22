import { z } from "zod";

export const DATASET_PROVENANCE_CONTRACT_VERSION =
  "raeburnai.dataset-provenance.v1" as const;
export const DATASET_RECORD_CONTRACT_VERSION =
  "raeburnai.dataset-record.v1" as const;

export const DatasetPurposeSchema = z.enum([
  "evaluation",
  "training",
  "red_team",
]);
export type DatasetPurpose = z.infer<typeof DatasetPurposeSchema>;

export const DatasetProvenanceSchema = z
  .object({
    contractVersion: z
      .literal(DATASET_PROVENANCE_CONTRACT_VERSION)
      .default(DATASET_PROVENANCE_CONTRACT_VERSION),
    sourceKind: z.enum([
      "synthetic",
      "first_party",
      "public_domain",
      "licensed",
      "open_source",
    ]),
    sourceId: z.string().trim().min(1).max(256),
    sourceUri: z.string().url().optional(),
    collectedAt: z.string().datetime().optional(),
    jurisdiction: z.string().trim().min(2).max(32),
    license: z.object({
      identifier: z.string().trim().min(1).max(128),
      evaluationAllowed: z.boolean(),
      trainingAllowed: z.boolean(),
      redistributionAllowed: z.boolean(),
    }),
    privacy: z.object({
      containsPersonalData: z.boolean(),
      containsSpecialCategoryData: z.boolean(),
      lawfulBasis: z.string().trim().min(2).max(128).optional(),
    }),
    permittedPurposes: z.array(DatasetPurposeSchema).min(1),
  })
  .superRefine((value, context) => {
    if (
      value.privacy.containsSpecialCategoryData &&
      !value.privacy.containsPersonalData
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privacy", "containsSpecialCategoryData"],
        message: "special-category data must also be marked as personal data",
      });
    }
    if (
      value.privacy.containsPersonalData &&
      !value.privacy.lawfulBasis &&
      value.sourceKind !== "synthetic"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["privacy", "lawfulBasis"],
        message: "personal-data records require a documented lawful basis",
      });
    }
  });

export const DatasetEvidenceSchema = z.object({
  id: z.string().trim().min(1).max(128),
  text: z.string().min(1).max(20_000),
  sourceType: z.enum(["primary", "secondary", "internal", "unknown"]),
  uri: z.string().url().optional(),
});

export const DatasetToolTraceSchema = z.object({
  tool: z.string().trim().min(1).max(128),
  action: z.string().trim().min(1).max(256),
  outputSummary: z.string().trim().min(1).max(2_000),
  succeeded: z.boolean(),
});

export const DatasetRecordSchema = z
  .object({
    contractVersion: z
      .literal(DATASET_RECORD_CONTRACT_VERSION)
      .default(DATASET_RECORD_CONTRACT_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,199}$/),
    task: z.string().trim().min(3).max(256),
    domain: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    jurisdiction: z.string().trim().min(2).max(32),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    difficulty: z.enum(["easy", "medium", "hard", "expert"]),
    confidence: z.number().min(0).max(1),
    prompt: z.string().min(1).max(50_000),
    idealAnswer: z.string().min(1).max(50_000),
    evidence: z.array(DatasetEvidenceSchema).default([]),
    badAnswer: z.string().max(50_000).nullable().optional(),
    critique: z.string().max(50_000).nullable().optional(),
    toolTrace: z.array(DatasetToolTraceSchema).default([]),
    provenance: DatasetProvenanceSchema,
  })
  .superRefine((value, context) => {
    const evidenceIds = new Set<string>();
    for (const [index, item] of value.evidence.entries()) {
      if (evidenceIds.has(item.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", index, "id"],
          message: `duplicate evidence id: ${item.id}`,
        });
      }
      evidenceIds.add(item.id);
    }
  });

export type DatasetRecord = z.infer<typeof DatasetRecordSchema>;

export class DatasetAdmissibilityError extends Error {
  constructor(
    public readonly code:
      | "purpose_not_permitted"
      | "license_not_permitted"
      | "special_category_data_not_permitted"
      | "personal_data_basis_missing",
  ) {
    super(code);
    this.name = "DatasetAdmissibilityError";
  }
}

function parsedRecord(input: unknown): DatasetRecord {
  return DatasetRecordSchema.parse(input);
}

function requirePurpose(
  record: DatasetRecord,
  purpose: DatasetPurpose,
): DatasetRecord {
  if (!record.provenance.permittedPurposes.includes(purpose)) {
    throw new DatasetAdmissibilityError("purpose_not_permitted");
  }
  if (
    purpose === "evaluation" &&
    !record.provenance.license.evaluationAllowed
  ) {
    throw new DatasetAdmissibilityError("license_not_permitted");
  }
  if (purpose === "training" && !record.provenance.license.trainingAllowed) {
    throw new DatasetAdmissibilityError("license_not_permitted");
  }
  if (record.provenance.privacy.containsSpecialCategoryData) {
    throw new DatasetAdmissibilityError(
      "special_category_data_not_permitted",
    );
  }
  if (
    record.provenance.privacy.containsPersonalData &&
    !record.provenance.privacy.lawfulBasis
  ) {
    throw new DatasetAdmissibilityError("personal_data_basis_missing");
  }
  return record;
}

export function assertEvaluationRecordAdmissible(input: unknown): DatasetRecord {
  return requirePurpose(parsedRecord(input), "evaluation");
}

export function assertTrainingRecordAdmissible(input: unknown): DatasetRecord {
  return requirePurpose(parsedRecord(input), "training");
}
