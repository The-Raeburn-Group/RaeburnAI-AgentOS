import { createHash } from "node:crypto";
import { z } from "zod";
import { assertTrainingRecordAdmissible, type DatasetRecord } from "@/lib/dataset-provenance";
import {
  evaluateModelRegistryFreshness,
  modelRegistryDigest,
  parseModelRegistry,
  type ModelRegistryEntry,
} from "@/lib/model-registry";
import { canonicalJson } from "@/lib/raeburnbench";

export const TRAINING_DATASET_CONTRACT_VERSION =
  "raeburnai.training-dataset.v1" as const;
export const ADAPTER_TRAINING_PLAN_VERSION =
  "raeburnai.adapter-training-plan.v1" as const;
export const ADAPTER_TRAINING_EVIDENCE_VERSION =
  "raeburnai.adapter-training-evidence.v1" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,199}$/);

export const TrainingDatasetConfigSchema = z.object({
  datasetId: IdentifierSchema,
  version: z.string().trim().min(1).max(64),
  generatedAt: z.string().datetime({ offset: true }),
  domains: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/)).min(1),
  split: z.object({
    groupBy: z.enum(["source", "task"]).default("task"),
    evaluationRatio: z.number().gt(0).lt(0.5).default(0.2),
  }),
});
export type TrainingDatasetConfig = z.infer<typeof TrainingDatasetConfigSchema>;

export const TrainingDatasetManifestSchema = z.object({
  contractVersion: z.literal(TRAINING_DATASET_CONTRACT_VERSION),
  datasetId: IdentifierSchema,
  version: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  domains: z.array(z.string()).min(1),
  split: z.object({
    groupBy: z.enum(["source", "task"]),
    evaluationRatio: z.number().gt(0).lt(0.5),
    groupCount: z.number().int().min(2),
    evaluationGroupCount: z.number().int().min(1),
  }),
  records: z.object({
    total: z.number().int().positive(),
    train: z.number().int().positive(),
    evaluation: z.number().int().positive(),
    taskCount: z.number().int().positive(),
    sourceCount: z.number().int().positive(),
  }),
  provenance: z.object({
    sourceKinds: z.array(z.string()).min(1),
    licenseIdentifiers: z.array(z.string()).min(1),
    jurisdictions: z.array(z.string()).min(1),
    syntheticRecords: z.number().int().min(0),
    personalDataRecords: z.number().int().min(0),
    specialCategoryRecords: z.number().int().min(0),
  }),
  artifacts: z.object({
    trainJsonlSha256: Sha256Schema,
    evaluationJsonlSha256: Sha256Schema,
    recordSetSha256: Sha256Schema,
  }),
  datasetDigest: Sha256Schema,
});
export type TrainingDatasetManifest = z.infer<
  typeof TrainingDatasetManifestSchema
>;

export interface TrainingDatasetBundle {
  manifest: TrainingDatasetManifest;
  trainJsonl: string;
  evaluationJsonl: string;
  trainRecords: DatasetRecord[];
  evaluationRecords: DatasetRecord[];
}

export const AdapterTrainingConfigSchema = z
  .object({
    method: z.enum(["lora", "qlora"]),
    framework: z.literal("transformers-peft").default("transformers-peft"),
    seed: z.number().int().min(0).max(2_147_483_647),
    epochs: z.number().finite().gt(0).max(100),
    learningRate: z.number().finite().gt(0).lt(1),
    rank: z.number().int().min(1).max(1024),
    alpha: z.number().int().min(1).max(8192),
    dropout: z.number().min(0).lt(1),
    targetModules: z.array(z.string().trim().min(1).max(128)).min(1),
    gradientCheckpointing: z.boolean().default(true),
    maxSequenceLength: z.number().int().min(128).max(1_000_000),
    quantizationBits: z.union([z.literal(4), z.literal(8)]).nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.method === "qlora" && value.quantizationBits === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantizationBits"],
        message: "QLoRA requires explicit 4-bit or 8-bit quantization",
      });
    }
    if (value.method === "lora" && value.quantizationBits !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantizationBits"],
        message: "LoRA plan must not declare QLoRA quantization bits",
      });
    }
  });
export type AdapterTrainingConfig = z.infer<typeof AdapterTrainingConfigSchema>;

export const AdapterTrainingPlanSchema = z.object({
  contractVersion: z.literal(ADAPTER_TRAINING_PLAN_VERSION),
  planId: IdentifierSchema,
  planDigest: Sha256Schema,
  createdAt: z.string().datetime({ offset: true }),
  expert: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().trim().min(1).max(64),
    manifestDigest: Sha256Schema,
  }),
  baseModel: z.object({
    registryVersion: z.string().trim().min(1).max(64),
    registryDigest: Sha256Schema,
    entryId: IdentifierSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    revision: z.string().min(1),
    licensingIdentifier: z.string().min(1),
  }),
  dataset: z.object({
    datasetId: IdentifierSchema,
    version: z.string().min(1),
    datasetDigest: Sha256Schema,
    trainJsonlSha256: Sha256Schema,
    evaluationJsonlSha256: Sha256Schema,
    trainRecords: z.number().int().positive(),
    evaluationRecords: z.number().int().positive(),
  }),
  training: AdapterTrainingConfigSchema,
  output: z.object({
    adapterVersion: z.string().trim().min(1).max(64),
    format: z.literal("peft-adapter"),
  }),
  engineeringReadiness: z.enum(["ready", "blocked"]),
  blockers: z.array(
    z.enum([
      "base_model_not_candidate_or_active",
      "base_model_technical_review_missing",
      "base_model_license_unverified",
      "base_model_provider_not_active",
      "base_model_observation_stale",
      "base_model_benchmark_evidence_missing",
      "base_model_text_modality_missing",
    ]),
  ),
});
export type AdapterTrainingPlan = z.infer<typeof AdapterTrainingPlanSchema>;

export const AdapterTrainingEvidenceSchema = z.object({
  contractVersion: z.literal(ADAPTER_TRAINING_EVIDENCE_VERSION),
  planDigest: Sha256Schema,
  datasetDigest: Sha256Schema,
  baseModel: z.object({
    entryId: IdentifierSchema,
    revision: z.string().min(1),
  }),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  seed: z.number().int().min(0).max(2_147_483_647),
  runtime: z.object({
    frameworkVersion: z.string().trim().min(1).max(128),
    peftVersion: z.string().trim().min(1).max(128),
    transformersVersion: z.string().trim().min(1).max(128),
    accelerator: z.enum(["cuda", "rocm", "tpu", "mps"]),
    deviceName: z.string().trim().min(1).max(256),
    peakVramGb: z.number().finite().gt(0),
  }),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  outputArtifact: z.object({
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive(),
    uri: z.string().url().optional(),
  }),
  metrics: z.object({
    trainLoss: z.number().finite().min(0),
    evaluationLoss: z.number().finite().min(0),
    durationSeconds: z.number().finite().gt(0),
  }),
});
export type AdapterTrainingEvidence = z.infer<
  typeof AdapterTrainingEvidenceSchema
>;

export class AdapterTrainingError extends Error {
  constructor(
    public readonly code:
      | "duplicate_training_record"
      | "undeclared_training_domain"
      | "declared_domain_missing"
      | "insufficient_split_groups"
      | "invalid_jsonl"
      | "unknown_base_model"
      | "plan_not_training_ready"
      | "training_evidence_plan_mismatch"
      | "training_evidence_dataset_mismatch"
      | "training_evidence_model_mismatch"
      | "training_evidence_seed_mismatch"
      | "training_evidence_time_invalid",
    public readonly detail?: string,
  ) {
    super(detail ? code + ": " + detail : code);
    this.name = "AdapterTrainingError";
  }
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function serializeRecords(records: DatasetRecord[]): string {
  return (
    [...records]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => canonicalJson(record))
      .join("\n") + "\n"
  );
}

export function parseTrainingJsonl(input: string): DatasetRecord[] {
  const normalized = input.endsWith("\n") ? input.slice(0, -1) : input;
  if (!normalized || normalized.split("\n").some((line) => line.trim() === "")) {
    throw new AdapterTrainingError("invalid_jsonl");
  }

  const records: DatasetRecord[] = [];
  for (const line of normalized.split("\n")) {
    try {
      records.push(assertTrainingRecordAdmissible(JSON.parse(line) as unknown));
    } catch (error) {
      if (error instanceof AdapterTrainingError) throw error;
      throw new AdapterTrainingError(
        "invalid_jsonl",
        error instanceof Error ? error.message : "parse failure",
      );
    }
  }
  return records;
}

function groupKey(
  record: DatasetRecord,
  groupBy: TrainingDatasetConfig["split"]["groupBy"],
): string {
  return groupBy === "source"
    ? record.provenance.sourceKind + ":" + record.provenance.sourceId
    : record.domain + ":" + record.task;
}

function splitRecords(
  records: DatasetRecord[],
  config: TrainingDatasetConfig,
): {
  train: DatasetRecord[];
  evaluation: DatasetRecord[];
  groupCount: number;
  evaluationGroupCount: number;
} {
  const groups = new Map<string, DatasetRecord[]>();
  for (const record of records) {
    const key = groupKey(record, config.split.groupBy);
    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }
  if (groups.size < 2) {
    throw new AdapterTrainingError("insufficient_split_groups");
  }

  const rankedGroups = [...groups.keys()].sort((left, right) => {
    const leftHash = sha256Bytes(left);
    const rightHash = sha256Bytes(right);
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });
  const evaluationGroupCount = Math.max(
    1,
    Math.min(
      rankedGroups.length - 1,
      Math.round(rankedGroups.length * config.split.evaluationRatio),
    ),
  );
  const evaluationGroups = new Set(
    rankedGroups.slice(0, evaluationGroupCount),
  );

  const train: DatasetRecord[] = [];
  const evaluation: DatasetRecord[] = [];
  for (const [key, groupRecords] of groups) {
    (evaluationGroups.has(key) ? evaluation : train).push(...groupRecords);
  }

  return {
    train: train.sort((left, right) => left.id.localeCompare(right.id)),
    evaluation: evaluation.sort((left, right) => left.id.localeCompare(right.id)),
    groupCount: groups.size,
    evaluationGroupCount,
  };
}

export function buildTrainingDataset(
  recordInputs: unknown[],
  configInput: unknown,
): TrainingDatasetBundle {
  const config = TrainingDatasetConfigSchema.parse(configInput);
  const records = recordInputs.map((record) =>
    assertTrainingRecordAdmissible(record),
  );

  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new AdapterTrainingError("duplicate_training_record", record.id);
    }
    ids.add(record.id);
    if (!config.domains.includes(record.domain)) {
      throw new AdapterTrainingError("undeclared_training_domain", record.domain);
    }
  }
  for (const domain of config.domains) {
    if (!records.some((record) => record.domain === domain)) {
      throw new AdapterTrainingError("declared_domain_missing", domain);
    }
  }

  const split = splitRecords(records, config);
  const trainJsonl = serializeRecords(split.train);
  const evaluationJsonl = serializeRecords(split.evaluation);
  const recordSetSha256 = sha256Bytes(serializeRecords(records));

  const unsigned = {
    contractVersion: TRAINING_DATASET_CONTRACT_VERSION,
    datasetId: config.datasetId,
    version: config.version,
    generatedAt: config.generatedAt,
    domains: [...config.domains].sort(),
    split: {
      groupBy: config.split.groupBy,
      evaluationRatio: config.split.evaluationRatio,
      groupCount: split.groupCount,
      evaluationGroupCount: split.evaluationGroupCount,
    },
    records: {
      total: records.length,
      train: split.train.length,
      evaluation: split.evaluation.length,
      taskCount: new Set(records.map((record) => record.task)).size,
      sourceCount: new Set(
        records.map(
          (record) =>
            record.provenance.sourceKind + ":" + record.provenance.sourceId,
        ),
      ).size,
    },
    provenance: {
      sourceKinds: sortedUnique(
        records.map((record) => record.provenance.sourceKind),
      ),
      licenseIdentifiers: sortedUnique(
        records.map((record) => record.provenance.license.identifier),
      ),
      jurisdictions: sortedUnique(
        records.map((record) => record.provenance.jurisdiction),
      ),
      syntheticRecords: records.filter(
        (record) => record.provenance.sourceKind === "synthetic",
      ).length,
      personalDataRecords: records.filter(
        (record) => record.provenance.privacy.containsPersonalData,
      ).length,
      specialCategoryRecords: records.filter(
        (record) => record.provenance.privacy.containsSpecialCategoryData,
      ).length,
    },
    artifacts: {
      trainJsonlSha256: sha256Bytes(trainJsonl),
      evaluationJsonlSha256: sha256Bytes(evaluationJsonl),
      recordSetSha256,
    },
  };
  const manifest = TrainingDatasetManifestSchema.parse({
    ...unsigned,
    datasetDigest: sha256Bytes(canonicalJson(unsigned)),
  });

  return {
    manifest,
    trainJsonl,
    evaluationJsonl,
    trainRecords: split.train,
    evaluationRecords: split.evaluation,
  };
}

function planBlockers(options: {
  entry: ModelRegistryEntry;
  registryInput: unknown;
  now: Date;
}): AdapterTrainingPlan["blockers"] {
  const { entry, registryInput, now } = options;
  const blockers: AdapterTrainingPlan["blockers"] = [];

  if (entry.lifecycle !== "candidate" && entry.lifecycle !== "active") {
    blockers.push("base_model_not_candidate_or_active");
  }
  if (entry.licensing.technicalReview !== "technical_reviewed") {
    blockers.push("base_model_technical_review_missing");
  }
  if (
    /^unverified(?:[-_ ]|$)/i.test(entry.licensing.identifier) ||
    entry.licensing.identifier.toLowerCase().includes("unverified")
  ) {
    blockers.push("base_model_license_unverified");
  }
  if (entry.freshness.providerStatus !== "active") {
    blockers.push("base_model_provider_not_active");
  }
  const freshness = evaluateModelRegistryFreshness(registryInput, now);
  if (
    freshness.findings.some(
      (finding) =>
        finding.entryId === entry.id && finding.code === "stale_observation",
    )
  ) {
    blockers.push("base_model_observation_stale");
  }
  if (
    entry.benchmark.qualityScore === null ||
    entry.benchmark.evidenceDigests.length === 0
  ) {
    blockers.push("base_model_benchmark_evidence_missing");
  }
  if (!entry.modalities.includes("text")) {
    blockers.push("base_model_text_modality_missing");
  }

  return [...new Set(blockers)];
}

export function buildAdapterTrainingPlan(options: {
  planId: string;
  createdAt: string;
  expert: {
    slug: string;
    version: string;
    manifestDigest: string;
  };
  registryInput: unknown;
  baseModelId: string;
  dataset: TrainingDatasetManifest;
  training: unknown;
  adapterVersion: string;
  now?: Date;
}): AdapterTrainingPlan {
  const registry = parseModelRegistry(options.registryInput);
  const entry = registry.entries.find(
    (candidate) => candidate.id === options.baseModelId,
  );
  if (!entry) {
    throw new AdapterTrainingError("unknown_base_model", options.baseModelId);
  }
  const training = AdapterTrainingConfigSchema.parse(options.training);
  const blockers = planBlockers({
    entry,
    registryInput: registry,
    now: options.now ?? new Date(options.createdAt),
  });

  const unsigned = {
    contractVersion: ADAPTER_TRAINING_PLAN_VERSION,
    planId: options.planId,
    createdAt: options.createdAt,
    expert: {
      slug: options.expert.slug,
      version: options.expert.version,
      manifestDigest: options.expert.manifestDigest,
    },
    baseModel: {
      registryVersion: registry.registryVersion,
      registryDigest: modelRegistryDigest(registry),
      entryId: entry.id,
      provider: entry.provider,
      model: entry.model,
      revision: entry.revision,
      licensingIdentifier: entry.licensing.identifier,
    },
    dataset: {
      datasetId: options.dataset.datasetId,
      version: options.dataset.version,
      datasetDigest: options.dataset.datasetDigest,
      trainJsonlSha256: options.dataset.artifacts.trainJsonlSha256,
      evaluationJsonlSha256: options.dataset.artifacts.evaluationJsonlSha256,
      trainRecords: options.dataset.records.train,
      evaluationRecords: options.dataset.records.evaluation,
    },
    training,
    output: {
      adapterVersion: options.adapterVersion,
      format: "peft-adapter" as const,
    },
    engineeringReadiness:
      blockers.length === 0 ? ("ready" as const) : ("blocked" as const),
    blockers,
  };

  return AdapterTrainingPlanSchema.parse({
    ...unsigned,
    planDigest: sha256Bytes(canonicalJson(unsigned)),
  });
}

export function verifyAdapterTrainingEvidence(
  planInput: unknown,
  evidenceInput: unknown,
): {
  evidence: AdapterTrainingEvidence;
  evidenceDigest: string;
} {
  const plan = AdapterTrainingPlanSchema.parse(planInput);
  const evidence = AdapterTrainingEvidenceSchema.parse(evidenceInput);

  if (plan.engineeringReadiness !== "ready") {
    throw new AdapterTrainingError("plan_not_training_ready");
  }
  if (evidence.planDigest !== plan.planDigest) {
    throw new AdapterTrainingError("training_evidence_plan_mismatch");
  }
  if (evidence.datasetDigest !== plan.dataset.datasetDigest) {
    throw new AdapterTrainingError("training_evidence_dataset_mismatch");
  }
  if (
    evidence.baseModel.entryId !== plan.baseModel.entryId ||
    evidence.baseModel.revision !== plan.baseModel.revision
  ) {
    throw new AdapterTrainingError("training_evidence_model_mismatch");
  }
  if (evidence.seed !== plan.training.seed) {
    throw new AdapterTrainingError("training_evidence_seed_mismatch");
  }
  if (
    new Date(evidence.finishedAt).getTime() <=
    new Date(evidence.startedAt).getTime()
  ) {
    throw new AdapterTrainingError("training_evidence_time_invalid");
  }

  return {
    evidence,
    evidenceDigest: sha256Bytes(canonicalJson(evidence)),
  };
}
