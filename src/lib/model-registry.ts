import { z } from "zod";
import { sha256 } from "@/lib/raeburnbench";

export const MODEL_REGISTRY_CONTRACT_VERSION =
  "raeburnai.model-registry.v1" as const;

const ModelProviderSchema = z.enum(["openai", "openrouter", "ollama"]);
const ModelLifecycleSchema = z.enum([
  "candidate",
  "active",
  "deprecated",
  "blocked",
]);
const ProviderStatusSchema = z.enum(["active", "deprecated", "unknown"]);
const TechnicalReviewSchema = z.enum([
  "unreviewed",
  "technical_reviewed",
  "blocked",
]);

export const ModelRegistryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,199}$/),
  provider: ModelProviderSchema,
  model: z.string().trim().min(1).max(200),
  revision: z.string().trim().min(1).max(100),
  lifecycle: ModelLifecycleSchema,
  capabilities: z.array(z.string().trim().min(1).max(100)).default([]),
  modalities: z
    .array(z.enum(["text", "image", "audio", "video"]))
    .min(1)
    .default(["text"]),
  contextWindow: z.number().int().positive().nullable().default(null),
  toolSupport: z.enum(["yes", "no", "unknown"]).default("unknown"),
  privacy: z.enum(["local", "third_party"]),
  licensing: z.object({
    identifier: z.string().trim().min(1).max(200),
    technicalReview: TechnicalReviewSchema,
    note: z.string().trim().max(2_000).optional(),
  }),
  benchmark: z
    .object({
      qualityScore: z.number().min(0).max(1).nullable().default(null),
      p95LatencyMs: z.number().finite().min(0).nullable().default(null),
      costPer1kTokensUsd: z.number().finite().min(0).nullable().default(null),
      evidenceDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
    })
    .default({}),
  freshness: z.object({
    observedAt: z.string().datetime({ offset: true }),
    maxAgeDays: z.number().int().min(1).max(365),
    providerStatus: ProviderStatusSchema,
    sourceRef: z.string().trim().min(1).max(2_000),
    deprecationAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .default(null),
  }),
  notes: z.string().trim().max(4_000).optional(),
});

export const ModelRegistrySchema = z
  .object({
    contractVersion: z.literal(MODEL_REGISTRY_CONTRACT_VERSION),
    registryVersion: z.string().trim().min(1).max(64),
    generatedAt: z.string().datetime({ offset: true }),
    entries: z.array(ModelRegistryEntrySchema).min(1),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const providerModelRevisions = new Set<string>();
    value.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "id"],
          message: "duplicate model registry id: " + entry.id,
        });
      }
      ids.add(entry.id);

      const identity = [entry.provider, entry.model, entry.revision].join("\0");
      if (providerModelRevisions.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index],
          message:
            "duplicate provider/model/revision: " +
            entry.provider +
            "/" +
            entry.model +
            "@" +
            entry.revision,
        });
      }
      providerModelRevisions.add(identity);
    });
  });

export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;
export type ModelRegistryEntry = z.infer<typeof ModelRegistryEntrySchema>;

export type ModelFreshnessFinding = {
  entryId: string;
  severity: "warning" | "review" | "block";
  code:
    | "stale_observation"
    | "provider_deprecated"
    | "provider_status_unknown"
    | "deprecation_due"
    | "technical_review_missing"
    | "benchmark_evidence_missing";
  detail: string;
};

function ageDays(now: Date, observedAt: Date): number {
  return (now.getTime() - observedAt.getTime()) / 86_400_000;
}

export function parseModelRegistry(input: unknown): ModelRegistry {
  return ModelRegistrySchema.parse(input);
}

export function modelRegistryDigest(input: unknown): string {
  return sha256(parseModelRegistry(input));
}

export function evaluateModelRegistryFreshness(
  input: unknown,
  now = new Date(),
): {
  registryVersion: string;
  registryDigest: string;
  evaluatedAt: string;
  findings: ModelFreshnessFinding[];
} {
  const registry = parseModelRegistry(input);
  const findings: ModelFreshnessFinding[] = [];

  for (const entry of registry.entries) {
    const observedAt = new Date(entry.freshness.observedAt);
    if (ageDays(now, observedAt) > entry.freshness.maxAgeDays) {
      findings.push({
        entryId: entry.id,
        severity: "review",
        code: "stale_observation",
        detail: `provider observation is older than ${entry.freshness.maxAgeDays} days`,
      });
    }
    if (entry.freshness.providerStatus === "deprecated") {
      findings.push({
        entryId: entry.id,
        severity: "block",
        code: "provider_deprecated",
        detail: "provider snapshot marks this model deprecated",
      });
    } else if (entry.freshness.providerStatus === "unknown") {
      findings.push({
        entryId: entry.id,
        severity: "review",
        code: "provider_status_unknown",
        detail: "provider availability/deprecation status is not verified",
      });
    }
    if (
      entry.freshness.deprecationAt &&
      new Date(entry.freshness.deprecationAt).getTime() <= now.getTime()
    ) {
      findings.push({
        entryId: entry.id,
        severity: "block",
        code: "deprecation_due",
        detail: "declared deprecation date has passed",
      });
    }
    if (entry.licensing.technicalReview !== "technical_reviewed") {
      findings.push({
        entryId: entry.id,
        severity:
          entry.licensing.technicalReview === "blocked" ? "block" : "review",
        code: "technical_review_missing",
        detail:
          entry.licensing.technicalReview === "blocked"
            ? "technical registry review blocks this model"
            : "technical registry review has not been completed",
      });
    }
    if (
      entry.benchmark.evidenceDigests.length === 0 ||
      entry.benchmark.qualityScore === null
    ) {
      findings.push({
        entryId: entry.id,
        severity: "warning",
        code: "benchmark_evidence_missing",
        detail: "no integrity-bound quality benchmark evidence is registered",
      });
    }
  }

  return {
    registryVersion: registry.registryVersion,
    registryDigest: sha256(registry),
    evaluatedAt: now.toISOString(),
    findings,
  };
}

export const ModelSelectionRequestSchema = z.object({
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  requiredModalities: z
    .array(z.enum(["text", "image", "audio", "video"]))
    .default(["text"]),
  requireTools: z.boolean().default(false),
  privacy: z.enum(["any", "local_only"]).default("any"),
  minQualityScore: z.number().min(0).max(1).default(0),
  maxP95LatencyMs: z.number().finite().positive().optional(),
  maxCostPer1kTokensUsd: z.number().finite().min(0).optional(),
  weights: z
    .object({
      quality: z.number().min(0).default(0.6),
      latency: z.number().min(0).default(0.2),
      cost: z.number().min(0).default(0.2),
    })
    .default({}),
});

export class ModelRegistryError extends Error {
  constructor(
    public readonly code: "no_eligible_model" | "invalid_selection_weights",
  ) {
    super(code);
    this.name = "ModelRegistryError";
  }
}

function allIncluded(required: string[], actual: string[]): boolean {
  const available = new Set(actual);
  return required.every((value) => available.has(value));
}

function normalizedInverse(value: number, ceiling?: number): number {
  if (ceiling === undefined || ceiling <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - value / ceiling));
}

export function selectRegistryModel(
  registryInput: unknown,
  requestInput: unknown,
  now = new Date(),
): {
  entry: ModelRegistryEntry;
  score: number;
  registryDigest: string;
} {
  const registry = parseModelRegistry(registryInput);
  const request = ModelSelectionRequestSchema.parse(requestInput);
  const weightTotal =
    request.weights.quality + request.weights.latency + request.weights.cost;
  if (weightTotal <= 0) {
    throw new ModelRegistryError("invalid_selection_weights");
  }

  const freshness = evaluateModelRegistryFreshness(registry, now);
  const blocked = new Set(
    freshness.findings
      .filter((finding) => finding.severity === "block")
      .map((finding) => finding.entryId),
  );
  const stale = new Set(
    freshness.findings
      .filter((finding) => finding.code === "stale_observation")
      .map((finding) => finding.entryId),
  );

  const candidates = registry.entries.filter((entry) => {
    if (entry.lifecycle !== "active") return false;
    if (blocked.has(entry.id) || stale.has(entry.id)) return false;
    if (entry.freshness.providerStatus !== "active") return false;
    if (entry.licensing.technicalReview !== "technical_reviewed") return false;
    if (!allIncluded(request.requiredCapabilities, entry.capabilities)) {
      return false;
    }
    if (!allIncluded(request.requiredModalities, entry.modalities))
      return false;
    if (request.requireTools && entry.toolSupport !== "yes") return false;
    if (request.privacy === "local_only" && entry.privacy !== "local") {
      return false;
    }
    if (
      entry.benchmark.qualityScore === null ||
      entry.benchmark.qualityScore < request.minQualityScore
    ) {
      return false;
    }
    if (
      request.maxP95LatencyMs !== undefined &&
      (entry.benchmark.p95LatencyMs === null ||
        entry.benchmark.p95LatencyMs > request.maxP95LatencyMs)
    ) {
      return false;
    }
    if (
      request.maxCostPer1kTokensUsd !== undefined &&
      (entry.benchmark.costPer1kTokensUsd === null ||
        entry.benchmark.costPer1kTokensUsd > request.maxCostPer1kTokensUsd)
    ) {
      return false;
    }
    return entry.benchmark.evidenceDigests.length > 0;
  });

  if (candidates.length === 0) {
    throw new ModelRegistryError("no_eligible_model");
  }

  const measuredLatencies = candidates
    .map((entry) => entry.benchmark.p95LatencyMs)
    .filter((value): value is number => value !== null);
  const measuredCosts = candidates
    .map((entry) => entry.benchmark.costPer1kTokensUsd)
    .filter((value): value is number => value !== null);
  const latencyCeiling =
    request.maxP95LatencyMs ??
    (measuredLatencies.length > 0
      ? Math.max(...measuredLatencies) * 1.01
      : undefined);
  const costCeiling =
    request.maxCostPer1kTokensUsd ??
    (measuredCosts.length > 0 ? Math.max(...measuredCosts) * 1.01 : undefined);

  const ranked = candidates
    .map((entry) => {
      const quality = entry.benchmark.qualityScore ?? 0;
      const latency =
        entry.benchmark.p95LatencyMs === null
          ? 0
          : normalizedInverse(entry.benchmark.p95LatencyMs, latencyCeiling);
      const cost =
        entry.benchmark.costPer1kTokensUsd === null
          ? 0
          : normalizedInverse(entry.benchmark.costPer1kTokensUsd, costCeiling);
      const score =
        (quality * request.weights.quality +
          latency * request.weights.latency +
          cost * request.weights.cost) /
        weightTotal;
      return { entry, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.id.localeCompare(right.entry.id),
    );

  const winner = ranked[0];
  if (!winner) throw new ModelRegistryError("no_eligible_model");
  return {
    entry: winner.entry,
    score: Math.round(winner.score * 1_000_000) / 1_000_000,
    registryDigest: freshness.registryDigest,
  };
}
