import { describe, expect, it } from "vitest";
import { agentManifestDigest } from "@/lib/collaboration";
import { buildExpertPack } from "@/lib/expert-catalog";
import {
  AdapterTrainingError,
  AdapterTrainingConfigSchema,
  buildAdapterTrainingPlan,
  buildTrainingDataset,
  parseTrainingJsonl,
  verifyAdapterTrainingEvidence,
  type AdapterTrainingEvidence,
} from "@/lib/adapter-training";
import type { ModelRegistry } from "@/lib/model-registry";

function reviewedRegistry(): ModelRegistry {
  return {
    contractVersion: "raeburnai.model-registry.v1",
    registryVersion: "training-test-v1",
    generatedAt: "2026-09-24T10:00:00.000Z",
    entries: [
      {
        id: "ollama.training-base.v1",
        provider: "ollama",
        model: "training-base",
        revision: "rev-1",
        lifecycle: "candidate",
        capabilities: ["general"],
        modalities: ["text"],
        contextWindow: 32768,
        toolSupport: "unknown",
        privacy: "local",
        licensing: {
          identifier: "reviewed-test-license",
          technicalReview: "technical_reviewed",
        },
        benchmark: {
          qualityScore: 0.8,
          p95LatencyMs: 1000,
          costPer1kTokensUsd: 0,
          evidenceDigests: ["a".repeat(64)],
        },
        freshness: {
          observedAt: "2026-09-24T10:00:00.000Z",
          maxAgeDays: 30,
          providerStatus: "active",
          sourceRef: "test-fixture",
          deprecationAt: null,
        },
      },
    ],
  };
}

function blockedRegistry(): ModelRegistry {
  const registry = reviewedRegistry();
  const entry = registry.entries[0]!;
  entry.id = "ollama.blocked.v1";
  entry.licensing.identifier = "unverified-repository-declaration";
  entry.licensing.technicalReview = "unreviewed";
  entry.freshness.providerStatus = "unknown";
  entry.benchmark.qualityScore = null;
  entry.benchmark.evidenceDigests = [];
  return registry;
}

function dataset() {
  const pack = buildExpertPack("raeburn-ai-engineering");
  return {
    pack,
    bundle: buildTrainingDataset(pack.evaluationSeed, {
      datasetId: "raeburn-ai-engineering.dev-training",
      version: "0.1.0",
      generatedAt: "2026-09-24T10:00:00.000Z",
      domains: ["ai_engineering"],
      split: {
        groupBy: "task",
        evaluationRatio: 0.2,
      },
    }),
  };
}

function trainingConfig() {
  return {
    method: "qlora" as const,
    framework: "transformers-peft" as const,
    seed: 1701,
    epochs: 3,
    learningRate: 0.0002,
    rank: 16,
    alpha: 32,
    dropout: 0.05,
    targetModules: ["q_proj", "k_proj", "v_proj", "o_proj"],
    gradientCheckpointing: true,
    maxSequenceLength: 4096,
    quantizationBits: 4 as const,
  };
}

function readyPlan() {
  const { pack, bundle } = dataset();
  return buildAdapterTrainingPlan({
    planId: "raeburn-ai-engineering.qlora.dev.v1",
    createdAt: "2026-09-24T10:00:00.000Z",
    expert: {
      slug: pack.manifest.slug,
      version: pack.manifest.version,
      manifestDigest: agentManifestDigest(pack.manifest),
    },
    registryInput: reviewedRegistry(),
    baseModelId: "ollama.training-base.v1",
    dataset: bundle.manifest,
    training: trainingConfig(),
    adapterVersion: "0.1.0-dev",
    now: new Date("2026-09-24T10:00:00.000Z"),
  });
}

function evidenceForPlan(plan = readyPlan()): AdapterTrainingEvidence {
  return {
    contractVersion: "raeburnai.adapter-training-evidence.v1",
    planDigest: plan.planDigest,
    datasetDigest: plan.dataset.datasetDigest,
    baseModel: {
      entryId: plan.baseModel.entryId,
      revision: plan.baseModel.revision,
    },
    sourceCommit: "b".repeat(40),
    seed: plan.training.seed,
    runtime: {
      frameworkVersion: "1.0.0",
      peftVersion: "0.18.0",
      transformersVersion: "5.0.0",
      accelerator: "cuda",
      deviceName: "test-gpu",
      peakVramGb: 12.5,
    },
    startedAt: "2026-09-24T10:05:00.000Z",
    finishedAt: "2026-09-24T10:35:00.000Z",
    outputArtifact: {
      sha256: "c".repeat(64),
      sizeBytes: 123456,
    },
    metrics: {
      trainLoss: 0.42,
      evaluationLoss: 0.51,
      durationSeconds: 1800,
    },
  };
}

describe("adapter training pipeline", () => {
  it("materialises a deterministic leakage-resistant JSONL split and round-trips it", () => {
    const first = dataset().bundle;
    const second = dataset().bundle;

    expect(first.manifest).toEqual(second.manifest);
    expect(first.trainJsonl).toBe(second.trainJsonl);
    expect(first.evaluationJsonl).toBe(second.evaluationJsonl);
    expect(first.manifest.records).toMatchObject({
      total: 100,
      train: 80,
      evaluation: 20,
      taskCount: 5,
      sourceCount: 100,
    });
    expect(first.manifest.split).toMatchObject({
      groupBy: "task",
      groupCount: 5,
      evaluationGroupCount: 1,
    });
    expect(parseTrainingJsonl(first.trainJsonl)).toEqual(first.trainRecords);
    expect(parseTrainingJsonl(first.evaluationJsonl)).toEqual(
      first.evaluationRecords,
    );

    const trainTasks = new Set(first.trainRecords.map((record) => record.task));
    const evaluationTasks = new Set(
      first.evaluationRecords.map((record) => record.task),
    );
    expect([...trainTasks].some((task) => evaluationTasks.has(task))).toBe(
      false,
    );
  });

  it("refuses duplicate records, undeclared domains and non-training-admissible data", () => {
    const pack = buildExpertPack("raeburn-ai-engineering");
    const config = {
      datasetId: "raeburn-ai-engineering.dev-training",
      version: "0.1.0",
      generatedAt: "2026-09-24T10:00:00.000Z",
      domains: ["ai_engineering"],
      split: { groupBy: "task" as const, evaluationRatio: 0.2 },
    };

    expect(() =>
      buildTrainingDataset(
        [...pack.evaluationSeed, structuredClone(pack.evaluationSeed[0]!)],
        config,
      ),
    ).toThrow("duplicate_training_record");

    const wrongDomain = structuredClone(pack.evaluationSeed);
    wrongDomain[0]!.domain = "finance";
    expect(() => buildTrainingDataset(wrongDomain, config)).toThrow(
      "undeclared_training_domain",
    );

    const blocked = structuredClone(pack.evaluationSeed);
    blocked[0]!.provenance.license.trainingAllowed = false;
    expect(() => buildTrainingDataset(blocked, config)).toThrow(
      "license_not_permitted",
    );
  });

  it("fails closed when a deterministic split cannot isolate at least two groups", () => {
    const pack = buildExpertPack("raeburn-ai-engineering");
    expect(() =>
      buildTrainingDataset(pack.evaluationSeed.slice(0, 20), {
        datasetId: "single-task",
        version: "0.1.0",
        generatedAt: "2026-09-24T10:00:00.000Z",
        domains: ["ai_engineering"],
        split: { groupBy: "task", evaluationRatio: 0.2 },
      }),
    ).toThrow("insufficient_split_groups");
  });

  it("enforces LoRA and QLoRA configuration invariants", () => {
    expect(() =>
      AdapterTrainingConfigSchema.parse({
        ...trainingConfig(),
        method: "qlora",
        quantizationBits: null,
      }),
    ).toThrow("QLoRA requires explicit");

    expect(() =>
      AdapterTrainingConfigSchema.parse({
        ...trainingConfig(),
        method: "lora",
        quantizationBits: 4,
      }),
    ).toThrow("LoRA plan must not declare");
  });

  it("creates a deterministic ready plan only for a governed reviewed model", () => {
    const first = readyPlan();
    const second = readyPlan();
    expect(first).toEqual(second);
    expect(first.engineeringReadiness).toBe("ready");
    expect(first.blockers).toEqual([]);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the repository-style unreviewed bootstrap model explicitly blocked", () => {
    const { pack, bundle } = dataset();
    const plan = buildAdapterTrainingPlan({
      planId: "blocked-pilot",
      createdAt: "2026-09-24T10:00:00.000Z",
      expert: {
        slug: pack.manifest.slug,
        version: pack.manifest.version,
        manifestDigest: agentManifestDigest(pack.manifest),
      },
      registryInput: blockedRegistry(),
      baseModelId: "ollama.blocked.v1",
      dataset: bundle.manifest,
      training: trainingConfig(),
      adapterVersion: "0.1.0-dev",
      now: new Date("2026-09-24T10:00:00.000Z"),
    });

    expect(plan.engineeringReadiness).toBe("blocked");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        "base_model_technical_review_missing",
        "base_model_license_unverified",
        "base_model_provider_not_active",
        "base_model_benchmark_evidence_missing",
      ]),
    );
  });

  it("will not accept runtime evidence for a blocked plan", () => {
    const { pack, bundle } = dataset();
    const plan = buildAdapterTrainingPlan({
      planId: "blocked-pilot",
      createdAt: "2026-09-24T10:00:00.000Z",
      expert: {
        slug: pack.manifest.slug,
        version: pack.manifest.version,
        manifestDigest: agentManifestDigest(pack.manifest),
      },
      registryInput: blockedRegistry(),
      baseModelId: "ollama.blocked.v1",
      dataset: bundle.manifest,
      training: trainingConfig(),
      adapterVersion: "0.1.0-dev",
      now: new Date("2026-09-24T10:00:00.000Z"),
    });
    const evidence = {
      ...evidenceForPlan(readyPlan()),
      planDigest: plan.planDigest,
      datasetDigest: plan.dataset.datasetDigest,
      baseModel: {
        entryId: plan.baseModel.entryId,
        revision: plan.baseModel.revision,
      },
      seed: plan.training.seed,
    };

    expect(() => verifyAdapterTrainingEvidence(plan, evidence)).toThrow(
      "plan_not_training_ready",
    );
  });

  it("accepts only runtime evidence bound to the exact plan, dataset, model and seed", () => {
    const plan = readyPlan();
    const evidence = evidenceForPlan(plan);
    const verified = verifyAdapterTrainingEvidence(plan, evidence);
    expect(verified.evidence).toEqual(evidence);
    expect(verified.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);

    expect(() =>
      verifyAdapterTrainingEvidence(plan, {
        ...evidence,
        planDigest: "d".repeat(64),
      }),
    ).toThrow("training_evidence_plan_mismatch");
    expect(() =>
      verifyAdapterTrainingEvidence(plan, {
        ...evidence,
        datasetDigest: "e".repeat(64),
      }),
    ).toThrow("training_evidence_dataset_mismatch");
    expect(() =>
      verifyAdapterTrainingEvidence(plan, {
        ...evidence,
        seed: plan.training.seed + 1,
      }),
    ).toThrow("training_evidence_seed_mismatch");
  });

  it("rejects impossible runtime chronology", () => {
    const plan = readyPlan();
    const evidence = evidenceForPlan(plan);
    evidence.finishedAt = evidence.startedAt;
    expect(() => verifyAdapterTrainingEvidence(plan, evidence)).toThrow(
      "training_evidence_time_invalid",
    );
  });

  it("rejects malformed JSONL instead of silently skipping lines", () => {
    expect(() => parseTrainingJsonl('{"id":"x"}\n\n{"id":"y"}\n')).toThrow(
      "invalid_jsonl",
    );
  });

  it("requires the configured base model to exist exactly", () => {
    const { pack, bundle } = dataset();
    expect(() =>
      buildAdapterTrainingPlan({
        planId: "missing-model",
        createdAt: "2026-09-24T10:00:00.000Z",
        expert: {
          slug: pack.manifest.slug,
          version: pack.manifest.version,
          manifestDigest: agentManifestDigest(pack.manifest),
        },
        registryInput: reviewedRegistry(),
        baseModelId: "missing.model",
        dataset: bundle.manifest,
        training: trainingConfig(),
        adapterVersion: "0.1.0-dev",
      }),
    ).toThrow(AdapterTrainingError);
  });
});
