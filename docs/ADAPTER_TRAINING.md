# Governed Adapter Training Pipeline

AgentOS defines a reproducible preparation and evidence boundary for future LoRA/QLoRA expert adapters.

The implementation deliberately separates three states:

1. **training dataset prepared**;
2. **adapter training plan engineering-ready**; and
3. **training actually executed with integrity-bound runtime evidence**.

A deterministic plan is not a trained adapter, and CI must never claim otherwise.

## Contracts

- \`raeburnai.training-dataset.v1\`
- \`raeburnai.adapter-training-plan.v1\`
- \`raeburnai.adapter-training-evidence.v1\`

These contracts reuse:

- \`raeburnai.dataset-record.v1\`;
- \`raeburnai.dataset-provenance.v1\`;
- \`raeburnai.agent-manifest.v1\`; and
- \`raeburnai.model-registry.v1\`.

## Dataset materialisation

\`buildTrainingDataset()\` accepts canonical dataset records and re-runs the existing training-admissibility policy for every record.

It fails closed when:

- training is not an allowed purpose;
- the declared licence does not permit training;
- prohibited special-category data is present;
- required personal-data governance is missing;
- record IDs are duplicated;
- a record belongs to an undeclared domain; or
- the requested split cannot isolate at least two groups.

The output contains deterministic train/evaluation JSONL, exact SHA-256 byte digests, a record-set digest and a machine-readable dataset manifest.

The current pilot groups by **task** before splitting. All variants of the same task therefore remain on one side of the train/evaluation boundary instead of leaking near-duplicate task templates into both sets.

The manifest summarizes:

- domains;
- train/evaluation counts;
- task and source counts;
- source kinds;
- declared licence identifiers;
- jurisdictions;
- synthetic-record count; and
- personal/special-category record counts.

The JSONL parser is strict. Empty interior lines and malformed/non-admissible records are rejected rather than silently skipped.

## LoRA / QLoRA plan

The training plan binds:

- exact expert slug/version and manifest digest;
- exact model-registry version/digest and model entry/revision;
- exact dataset digest plus train/evaluation JSONL digests;
- method (\`lora\` or \`qlora\`);
- framework (\`transformers-peft\`);
- seed;
- epochs;
- learning rate;
- rank/alpha/dropout;
- target modules;
- sequence length;
- gradient-checkpointing policy;
- QLoRA quantization bits; and
- intended adapter version.

QLoRA requires explicit 4-bit or 8-bit quantization. Ordinary LoRA must not silently carry a QLoRA quantization setting.

## Engineering-readiness gate

A plan can be \`ready\` or \`blocked\`.

The current v1 gate blocks training when the selected base-model record is:

- not candidate/active;
- not technically reviewed;
- marked with an unverified licence declaration;
- not observed active at the provider/runtime boundary;
- stale;
- missing integrity-bound benchmark evidence; or
- missing text modality.

This is an engineering gate, not legal advice or legal approval.

The checked-in model registry currently contains only the repository bootstrap model and intentionally records it as candidate, unreviewed, provider-status unknown and unbenchmarked. The AI Engineering pilot therefore **must remain blocked**.

That is the expected CI result.

## Runtime training evidence

A future successful GPU training run must provide \`raeburnai.adapter-training-evidence.v1\` containing:

- the exact plan digest;
- exact dataset digest;
- exact base model entry/revision;
- source commit;
- the same seed;
- framework/PEFT/Transformers versions;
- accelerator/device and peak VRAM;
- start/finish timestamps;
- adapter artifact SHA-256 and size; and
- training/evaluation loss plus duration.

Evidence is rejected when it belongs to another plan, dataset, base model or seed, when chronology is invalid, or when the underlying plan was not engineering-ready.

CI does not fabricate this runtime evidence.

## Current pilot

\`npm run training:verify\` prepares a deterministic QLoRA pilot for the \`raeburn-ai-engineering\` development pack from the governed 20-expert catalogue.

The pack contributes 100 synthetic, privacy-minimised, training-admissible development records. The current task-group split produces 80 training and 20 evaluation records without sharing a task group across the split.

The command verifies exact JSONL round-trip and then builds the plan against the repository model registry.

Expected outcome:

- dataset: valid and deterministic;
- plan: deterministic;
- engineering readiness: **blocked**;
- training executed: **false**;
- adapter artifact produced: **false**.

If the bootstrap model is accidentally treated as reviewed/benchmarked/active without the registry evidence changing, the CI command fails.

## What this does not prove

This work does not claim:

- a GPU training job occurred;
- a LoRA/QLoRA adapter exists;
- any base-model licence is legally approved;
- the 100 public synthetic records are a sufficient training corpus;
- specialist quality improved;
- a prompt/RAG baseline was beaten;
- private held-out benchmarks were passed;
- dynamic adapter serving works; or
- a trained adapter is safe for staging/production.

Those remain separate delivery gates. The next legitimate milestone is to approve a real base-model candidate, add a reviewed private training/held-out dataset, execute one controlled adapter run, produce the required runtime artifact evidence, and compare it against the governed prompt/RAG incumbent through RaeburnBench before any promotion.
