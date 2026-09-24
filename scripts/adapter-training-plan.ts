import modelRegistry from "../config/model-registry.v1.json";
import { agentManifestDigest } from "../src/lib/collaboration";
import { buildExpertPack } from "../src/lib/expert-catalog";
import {
  buildAdapterTrainingPlan,
  buildTrainingDataset,
  parseTrainingJsonl,
} from "../src/lib/adapter-training";

const pack = buildExpertPack("raeburn-ai-engineering");
const dataset = buildTrainingDataset(pack.evaluationSeed, {
  datasetId: "raeburn-ai-engineering.dev-training",
  version: "0.1.0",
  generatedAt: "2026-09-24T10:00:00.000Z",
  domains: ["ai_engineering"],
  split: {
    groupBy: "task",
    evaluationRatio: 0.2,
  },
});

const plan = buildAdapterTrainingPlan({
  planId: "raeburn-ai-engineering.qlora.dev.v1",
  createdAt: "2026-09-24T10:00:00.000Z",
  expert: {
    slug: pack.manifest.slug,
    version: pack.manifest.version,
    manifestDigest: agentManifestDigest(pack.manifest),
  },
  registryInput: modelRegistry,
  baseModelId: "ollama.llama3_1.configured",
  dataset: dataset.manifest,
  training: {
    method: "qlora",
    framework: "transformers-peft",
    seed: 1701,
    epochs: 3,
    learningRate: 0.0002,
    rank: 16,
    alpha: 32,
    dropout: 0.05,
    targetModules: ["q_proj", "k_proj", "v_proj", "o_proj"],
    gradientCheckpointing: true,
    maxSequenceLength: 4096,
    quantizationBits: 4,
  },
  adapterVersion: "0.1.0-dev",
  now: new Date("2026-09-24T10:00:00.000Z"),
});

const trainRoundTrip = parseTrainingJsonl(dataset.trainJsonl);
const evaluationRoundTrip = parseTrainingJsonl(dataset.evaluationJsonl);

if (
  trainRoundTrip.length !== dataset.manifest.records.train ||
  evaluationRoundTrip.length !== dataset.manifest.records.evaluation
) {
  throw new Error("training_dataset_round_trip_mismatch");
}

const expectedBlockers = new Set([
  "base_model_technical_review_missing",
  "base_model_license_unverified",
  "base_model_provider_not_active",
  "base_model_benchmark_evidence_missing",
]);
for (const blocker of expectedBlockers) {
  if (!plan.blockers.includes(blocker as (typeof plan.blockers)[number])) {
    throw new Error("training_plan_expected_blocker_missing: " + blocker);
  }
}
if (plan.engineeringReadiness !== "blocked") {
  throw new Error("unreviewed_bootstrap_model_must_not_be_training_ready");
}

process.stdout.write(
  JSON.stringify(
    {
      contracts: {
        dataset: dataset.manifest.contractVersion,
        trainingPlan: plan.contractVersion,
      },
      expert: {
        slug: pack.manifest.slug,
        version: pack.manifest.version,
        manifestDigest: plan.expert.manifestDigest,
      },
      dataset: {
        id: dataset.manifest.datasetId,
        version: dataset.manifest.version,
        digest: dataset.manifest.datasetDigest,
        totalRecords: dataset.manifest.records.total,
        trainRecords: dataset.manifest.records.train,
        evaluationRecords: dataset.manifest.records.evaluation,
        groupBy: dataset.manifest.split.groupBy,
        trainJsonlSha256: dataset.manifest.artifacts.trainJsonlSha256,
        evaluationJsonlSha256: dataset.manifest.artifacts.evaluationJsonlSha256,
        provenance: dataset.manifest.provenance,
      },
      plan: {
        id: plan.planId,
        digest: plan.planDigest,
        method: plan.training.method,
        framework: plan.training.framework,
        seed: plan.training.seed,
        baseModel: plan.baseModel,
        engineeringReadiness: plan.engineeringReadiness,
        blockers: plan.blockers,
      },
      execution: {
        trainingExecuted: false,
        adapterArtifactProduced: false,
        reason:
          "CI validates reproducible training inputs and governance only; the configured base model is not reviewed/benchmarked/active for training.",
      },
    },
    null,
    2,
  ) + "\n",
);
