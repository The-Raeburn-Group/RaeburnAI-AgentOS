# Continuous Evaluation Quality Loop

AgentOS implements `raeburnai.quality-loop.v1` as a fail-closed bridge from durable operational failures into reviewed evaluation candidates.

## Failure capture

The sweep consumes only explicit failure audit actions:

- `workflow.job.dead_lettered`
- `agent.failed`
- `workflow.adjudication.rejected`

It deliberately does not copy workflow prompts, raw model output or arbitrary audit payloads into the evaluation store. A bounded metadata allow-list is sanitised through the existing memory redaction policy before persistence. Private-key/high-risk structured content is rejected and replaced by a redacted marker.

Each candidate is tenant-scoped and content-addressed. Repeated equivalent failures increase an occurrence counter and retain individual source-event links. A unique source-event constraint makes the projection idempotent under retries and concurrent workers.

Run a sweep with:

```
npm run quality:sweep
```

`QUALITY_SWEEP_BATCH` may be set from 1 to 500. Scheduling this command against a real environment remains an operations/deployment responsibility; repository CI does not represent production failure capture.

## Human review and counterexample promotion

Candidates start as `PENDING_REVIEW`. Only authenticated service callers with an `admin`, `operator` or `quality-reviewer` role may list or change candidates through `/api/quality/candidates`.

A candidate must be explicitly accepted before promotion. Review transitions are conditional on the expected database state so conflicting reviewers cannot overwrite an earlier terminal decision. Accepted candidates remain discoverable with `GET /api/quality/candidates?status=ACCEPTED`. Promotion requires a complete `raeburnai.dataset-record.v1` counterexample with both `badAnswer` and `critique`, and provenance must bind the record to the exact candidate using:

```
evaluation-candidate:<candidate-id>
```

Evaluation admissibility is always enforced and expected admissibility failures are returned as client errors rather than false server outages. If the record declares a training purpose, training admissibility is enforced independently. Legal/licensing approval for real training sources is not inferred from this mechanism.

The quality-loop candidate and occurrence tables are included in the PostgreSQL disaster-recovery snapshot fingerprints and deterministic restore fixture, so recovery verification fails if this durable review state is lost or changed.

## Tool-use benchmark

`raeburnai.tool-benchmark.v1` compares an observed tool trace with an exact expected trace, enforces a maximum call budget and rejects forbidden tools. Unknown or duplicate case identifiers fail closed. The seed contains five deterministic cases.

This is a contract and regression benchmark. It is not evidence that live MCP/provider tools have been exercised in production.

## Latency and cost benchmark

`raeburnai.performance-benchmark.v1` applies per-case latency and cost ceilings and emits an integrity digest covering the benchmark definition and result. Missing, duplicate and unknown measurements fail the benchmark path.

The checked-in measurements are deterministic seed/reference data. Real provider latency and cost measurements still require live candidate execution.

## Challenger promotion gate

`raeburnai.challenger-gate.v1` allows a candidate to be marked promotable only when:

1. RaeburnBench passes;
2. the tool-use benchmark passes;
3. the latency/cost benchmark passes; and
4. every artifact identifies the exact same candidate and version.

The challenger gate independently verifies the integrity digests of the complete RaeburnBench, tool-use and performance result artifacts before trusting their gate states. It rejects mixed candidate identities and cannot be bypassed by changing a stored `gate` field while retaining a syntactically valid hash.

The daily GitHub workflow runs this gate against the versioned repository reference artifacts. That proves the promotion-control logic remains executable. It does not claim that an external or newly trained model challenger has been invoked.

## Current limits

The repository now contains the durable capture/review/promotion data model, operational sweep, governed review API and deterministic benchmark gates. Remaining work includes real production/staging failure ingestion, a private held-out counterexample corpus, live tool traces, live provider cost/latency telemetry, a challenger registry backed by real candidate artifacts, human labelling operations and release/promotion integration for production model versions.
