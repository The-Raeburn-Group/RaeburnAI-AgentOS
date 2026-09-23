# Continuous learning and evaluation-candidate quarantine

AgentOS implements the first governed continuous-learning intake contract as
`raeburnai.evaluation-candidate.v1`.

This is **not online learning**. Captured failures, corrections and security
signals are quarantined until a human reviewer makes a terminal decision.
Production policies, prompts, experts and model weights are never changed by
candidate capture.

## What can be captured

The candidate service accepts six trigger classes:

- benchmark failure;
- human correction;
- tool failure;
- low confidence;
- security event;
- manual quality report.

Each candidate carries a task/domain, sanitized prompt, optional observed
output/correction, reason labels, optional tool trace, metadata and
`raeburnai.dataset-provenance.v1`.

Trigger invariants fail closed. Human-correction captures require a correction,
low-confidence captures require confidence <= 0.5, and tool-failure captures
must contain at least one failed tool trace. PostgreSQL repeats these critical
invariants so direct writes cannot bypass the application policy.

## Privacy and data handling

Capture reuses the durable-memory sanitizer before persistence. Recognized
credentials, email addresses, phone numbers, payment-card numbers and national
identifiers are redacted. Private keys and labelled/structured high-risk
special-category data are rejected.

If personal identifiers are detected but provenance says the source does not
contain personal data, capture is rejected as a declaration mismatch.
Special-category provenance is rejected from this v1 automated path.

Raw source references are not persisted. AgentOS stores a SHA-256 source
reference hash in an append-only occurrence record. Audit events contain
candidate IDs, hashes, trigger/reason labels and redaction metadata, never the
raw prompt or model output.

The sanitizer is a technical control, not a claim that every possible form of
personal data can be detected. Production callers remain responsible for
correct provenance/privacy declarations and upstream minimisation.

## Deduplication and recurrence

A deterministic SHA-256 fingerprint is computed from the sanitized candidate
content plus the material provenance/permission envelope. The source reference
itself is deliberately excluded so the same failure observed in multiple
runs deduplicates into one candidate.

Every observation still creates an append-only
`EvaluationCandidateOccurrence`. The parent candidate maintains
`occurrenceCount` and `lastSeenAt`, so recurrence is visible without
duplicating training/evaluation content.

## Human review

Only identities with `evaluation.review` may make a terminal decision:

- `approve_evaluation`;
- `approve_training`;
- `reject`.

Approved candidates require a complete
`raeburnai.dataset-record.v1`. The existing evaluation/training admissibility
gates are rerun at review time. A reviewer cannot silently change source
provenance, licence permissions or privacy flags; the reviewed record's
provenance must match the quarantined candidate.

The approved record must also preserve the candidate task, domain and sanitized
prompt. When an observed bad answer exists it must remain the dataset
`badAnswer`; a human-correction candidate must use the reviewed correction as
the `idealAnswer`.

Reviewed dataset records are scanned again and must already be explicitly
redacted. Detected direct identifiers, credentials, private keys or prohibited
sensitive data block promotion.

Terminal review uses optimistic `updatedAt` plus status guards. Two reviewers
cannot both win the same decision race, and the database allows only one review
record for a candidate.

## Permissions

Human RBAC separates duties:

- admin: read, capture and review;
- operator: read and capture;
- approver: read and review;
- auditor: read only;
- viewer: no evaluation-candidate access.

The list/capture endpoints are under `/api/evaluation/candidates`; review is
`/api/evaluation/candidates/{id}/review`. Reviewed records can be exported as
canonical JSONL from
`/api/evaluation/candidates/export?purpose=evaluation|training`. Export
requires review-level permission and is `no-store`.

## Dataset interoperability

`DatasetRecord` now has canonical JSONL serialization and parsing helpers.
Every record is revalidated for its requested purpose on export and import,
duplicate IDs are rejected, and canonical ordering makes a round-trip stable.

The export path validates the stored approved-record digest before emitting a
record. A corrupted or mismatched persisted record fails closed.

## Durability and recovery

The candidate, occurrence and review tables are included in the existing
manifest-verified PostgreSQL disaster-recovery snapshot. CI seeds deterministic
two-tenant evaluation state, creates a logical backup, restores it into an
isolated database, reapplies migrations and compares complete table
fingerprints.

## Explicit limits

This implementation does not:

- capture arbitrary raw production traffic;
- automatically create ground truth;
- automatically add a candidate to a release benchmark;
- automatically train/fine-tune a model;
- automatically promote prompts, routes, models or experts;
- provide legal approval for a source licence;
- replace private held-out evaluation governance.

Telemetry/Router/Chain integrations still need to call the capture service at
the relevant failure boundaries. A future candidate-to-benchmark registry can
consume only human-approved records from this quarantine.
