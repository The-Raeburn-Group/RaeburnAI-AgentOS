# Governed AI Asset and Configuration Control Plane

AgentOS now defines two linked contracts for controlled model/expert evolution:

- `raeburnai.model-registry.v1`
- `raeburnai.optimization-experiment.v1`

The purpose is to make model and expert changes reviewable, measurable and fail-closed rather than allowing a runtime or autonomous process to silently replace production configuration.

## Versioned model registry

`config/model-registry.v1.json` is the repository-controlled model inventory. Every entry declares:

- provider, model identifier and revision;
- lifecycle state;
- capabilities, modalities, context-window information and tool support;
- local versus third-party privacy boundary;
- declared licence identifier and **technical** review state;
- benchmark quality, p95 latency and cost fields plus integrity-bound evidence digests; and
- a freshness observation, source reference, maximum age, provider status and optional deprecation date.

The registry intentionally distinguishes technical registry review from legal/IP approval. A `technical_reviewed` value means only that the entry is complete enough for the software selection policy. It is not a legal conclusion that the model or its weights may be used for every purpose.

The repository currently contains only the configured Ollama `llama3.1` default as a **candidate** bootstrap record with unreviewed technical/licensing metadata and no benchmark evidence. This is deliberate: the governed model-selection API therefore fails closed rather than converting existing configuration into an unsupported production recommendation.

## Governed selection

`selectRegistryModel` filters before scoring. A model is eligible only when it is:

1. lifecycle `active`;
2. fresh enough for its declared observation policy;
3. not deprecated or blocked;
4. technically reviewed;
5. backed by integrity-bound quality benchmark evidence;
6. compatible with required capabilities, modalities, tool use and privacy constraints; and
7. within any requested latency/cost/quality ceilings.

Only after those controls pass does the multi-objective policy combine quality, latency and cost. Missing or stale governed candidates produce `no_eligible_model` rather than silently falling back to an unregistered model.

`GET /api/models/registry` exposes the versioned registry and current findings to authenticated internal services. `POST /api/models/registry` performs governed selection and writes tenant-scoped audit evidence for both successful selection and fail-closed no-candidate outcomes.

This API is a control-plane capability. Existing provider calls remain backward compatible; the current runtime has not yet been switched to require the registry for every generation request.

## Offline expert/prompt optimization

AgentOS already stores expert manifests as versioned `Agent` records. The optimization control plane reuses that architecture rather than creating a second prompt registry.

A challenger must be a new `DRAFT` version of the same expert slug, while the baseline must be the sole current `VERIFIED` version. An optimization experiment binds both exact manifest digests to independently integrity-verified:

- RaeburnBench results;
- tool-use benchmark results; and
- latency/cost benchmark results.

The baseline and challenger must use the same benchmark definitions. Candidate IDs are bound to `agent:<slug>` and exact versions. Default policy allows no quality or tool-use regression and only bounded latency/cost increases.

Experiments are persisted in PostgreSQL and move through:

`EVALUATED -> APPROVED | REJECTED -> PROMOTED`

Approval is required before promotion. Promotion re-checks both stored manifest digests and optimistic database state. If the challenger changed after evaluation, if the baseline is no longer current, or if another operation won the race, promotion fails closed.

A successful promotion atomically:

- marks the challenger `VERIFIED`;
- marks prior verified versions for that slug `DEPRECATED`;
- records the experiment as `PROMOTED`; and
- writes tenant-scoped audit evidence.

Deprecated versions are now immutable too, preserving historical configuration evidence rather than allowing an old promoted prompt to be rewritten after the fact.

The API surface is `/api/optimization/experiments`. Evaluation requires an internal optimization role; approval requires a quality reviewer, admin or trusted human-approver role; promotion requires admin or human-approver authority.

## Recovery evidence

`OptimizationExperiment` rows are included in the PostgreSQL disaster-recovery manifest fingerprints. The deterministic recovery fixture contains a baseline, challenger and approved experiment so the existing backup -> isolated restore -> forward migration -> equality verification path detects lost or mutated optimization state.

## Automated freshness review

`.github/workflows/model-freshness.yml` runs daily and on manual dispatch. It validates the registry, produces JSON and Markdown findings, and creates or updates one GitHub review issue when model observations, provider status, technical review or benchmark evidence need attention. When findings are cleared, it closes the open review issue.

The workflow **does not auto-upgrade models**. A freshness finding enters a review path; model/configuration promotion still has to pass evaluation and governed approval.

The normal CI and scheduled challenger workflow also execute registry validation and the deterministic offline optimization gate.

## Evidence boundaries and remaining work

The following are not claimed by this implementation:

- live provider catalogue discovery has not yet executed;
- the bootstrap model entry is not licence-approved or benchmark-approved;
- no external provider/model challenger is invoked by the repository reference benchmark;
- no private held-out RaeburnBench corpus is present;
- no production prompt/configuration has been promoted by this mechanism;
- no staging/production runtime is forced to use the registry yet; and
- provider pricing, availability and deprecation data are not yet automatically sourced from authoritative provider APIs.

The next material step is to ingest signed/authoritative provider snapshots, complete technical and legal review of candidate models, attach private benchmark evidence, and connect the Router/Chain runtime plus release/canary policy to the governed registry and optimization promotion records.
