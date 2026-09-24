# Governed Expert Catalog

AgentOS includes a development-only catalog for the 20 expert domains tracked in the RaeburnAI delivery plan.

## Contracts

- `raeburnai.expert-catalog.v1` — catalog envelope.
- `raeburnai.expert-pack.v1` — one expert manifest, task taxonomy, development card and evaluation seed.
- `raeburnai.expert-card.v1` — intended use, exclusions, limitations, oversight and benchmark-promotion requirements.
- `raeburnai.agent-manifest.v1` — the existing executable AgentOS manifest used by routing and marketplace persistence.
- `raeburnai.dataset-record.v1` — the existing provenance-aware dataset record used for each seed case.

## Safety boundary

Catalog packs are deliberately **development assets**, not verified specialists.

Every pack:

1. uses `modelName: catalog-unassigned`; the catalog does not select a production base model or checkpoint;
2. contains five task-taxonomy entries and 100 synthetic development seed records;
3. marks the seed data as synthetic, privacy-minimised and Apache-2.0 for evaluation/training/red-team development use;
4. declares intended uses, out-of-scope behaviour and limitations in a machine-readable expert card;
5. requires evidence and human oversight for high-risk domains;
6. remains subject to the existing AgentOS benchmark, review and promotion controls.

The checked-in seeds are public development scaffolding. They are **not** private held-out evidence and must not be used to claim specialist competence or model superiority.

## Catalog domains

The catalog covers:

- General Reasoning
- Research
- Finance
- Tax
- Legal Research
- Compliance
- Procurement
- Sales
- Recruitment
- Strategy
- Software Engineering
- Cybersecurity
- Data & Analytics
- AI Engineering
- Operations
- Education
- Science
- Health Research
- Creative
- Vision & Document Intelligence

An independent Evidence Verifier manifest is available to routing as an adjudicator but is not counted as one of the 20 customer-facing expert packs.

## Routing

The routing classifier now contains intents for all 20 catalog domains. The catalog benchmark executes one representative routing probe for every expert and fails if a probe routes to the wrong expert or risk tier.

High-risk catalog routes still fail closed if an independent evidence-capable adjudicator is absent.

## Evaluation seeds

Each expert pack contains 100 deterministic records created from:

- five domain task areas; and
- twenty cross-cutting challenge variants such as ambiguity, missing evidence, conflicting evidence, stale inputs, adversarial instructions, calibration, privacy, failure recovery and human hand-off.

This produces 2,000 unique seed records across the catalog. These records are validated through the canonical dataset provenance and evaluation-admissibility contracts.

Run:

```bash
npm run bench:experts
```

The command validates the complete catalog, checks 2,000-case cardinality and exercises routing coverage.

## Operator API

Authenticated users with `agent.read` may inspect catalog summaries:

```http
GET /api/experts/catalog
GET /api/experts/catalog?slug=raeburn-finance
```

The API intentionally returns summaries rather than the 2,000 full seed records.

Users with `agent.write` may install one catalog pack into their tenant:

```http
POST /api/experts/catalog
Content-Type: application/json

{"slug":"raeburn-finance"}
```

Installation is fail closed:

- a new catalog expert is created as `DRAFT`, never `VERIFIED`;
- exact replay is idempotent and never downgrades a verified historical version;
- a locally changed version conflicts instead of being overwritten;
- the operation is tenant-scoped and audited.

## Remaining promotion requirements

A catalog expert must remain development-only until the relevant domain has:

- protected private held-out evaluation data;
- expert-reviewed rubrics and acceptance thresholds;
- an explicitly selected and licence-reviewed base model or adapter;
- live model execution against the governed benchmark;
- safety, evidence, tool-use, latency and cost evidence appropriate to the domain;
- an approved promotion/canary/rollback path;
- any external legal, regulatory or professional review required for the intended use.

The catalog does not satisfy those external or production gates by itself.
