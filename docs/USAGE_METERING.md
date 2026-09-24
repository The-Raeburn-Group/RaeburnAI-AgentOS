# Usage Metering and Budget Control

AgentOS implements two versioned financial-control contracts:

- \`raeburnai.usage-ledger.v1\`
- \`raeburnai.budget-policy.v1\`

The design separates **pre-spend control** from **post-spend accounting truth**.

## Durable usage events

Every committed usage event is tenant-scoped and idempotent. The ledger records:

- authenticated request/actor identity;
- optional workflow run;
- category: model, tool, retrieval, workflow or other;
- provider/model/model-registry identity;
- expert and tool attribution;
- input/output tokens;
- latency;
- exact integer micro-USD cost;
- billable metric and integer billable units;
- bounded metadata;
- occurrence timestamp; and
- a canonical SHA-256 event digest.

The database enforces uniqueness for tenant + idempotency key and for the reservation-to-event relationship.

Usage summaries are aggregated in PostgreSQL rather than loading the complete event history into application memory. Summary output includes total cost, cost per 1K tokens, token counts, billable units and breakdowns by category, provider/model, expert, tool and billable metric.

## Budget policy

A tenant can have one explicit v1 budget policy with:

- monthly micro-USD limit;
- per-request micro-USD limit;
- warning ratio;
- enforcement mode: \`hard\` or \`monitor\`; and
- fallback policy: \`block\`, \`cheapest_eligible\` or \`local_only\`.

v1 is deliberately USD-only because the persistent amount unit is micro-USD.

No policy means spend reservation fails closed.

## Reservation before dispatch

Before a provider/tool call incurs controlled cost, the trusted caller creates a spend reservation.

Reservations are:

- tenant-bound;
- request-bound;
- idempotent;
- time limited;
- bound to the budget-policy version used for the decision; and
- serialized against the tenant's policy row so concurrent requests cannot independently consume the same remaining budget.

Hard policies reject requests that exceed per-request or remaining monthly capacity. Monitor policies permit the reservation but persist the warning/reasons.

Reservation replays return the original persisted decision. Reusing an idempotency key with a different payload fails.

Unused reservations can be explicitly released. Expired reservations cannot be committed.

## Commit after usage

After execution, the caller commits the real provider/tool usage.

The actual cost is always recorded truthfully, even when it exceeds the original estimate. The result therefore distinguishes:

- \`overReservation\` — actual cost exceeded reserved cost; and
- \`budgetBreached\` — the real monthly committed spend exceeded the policy limit.

Recording an overage is not blocked after the spend has happened; hiding an incurred cost would make the ledger untrustworthy. Subsequent reservations remain governed by the now-breached snapshot.

A repeated identical commit is idempotent. A conflicting replay fails.

## APIs

Trusted Chain/service endpoints:

- \`POST /api/usage/reserve\`
- \`POST /api/usage/commit\`
- \`POST /api/usage/release\`

Tenant, actor and request identity come from the authenticated service context, not request JSON.

Human-admin endpoints:

- \`GET /api/usage/budget\` — requires metrics-read permission;
- \`PUT /api/usage/budget\` — requires settings-write permission;
- \`GET /api/usage/summary\` — requires metrics-read permission.

## Audit and disaster recovery

Budget-policy changes, reservation creation/denial/release and usage commits emit tenant-bound audit events. Financial amounts are stored as integer micro-USD values; audit JSON serializes those values as decimal strings.

BudgetPolicy, SpendReservation and UsageEvent are included in the existing manifest-verified PostgreSQL backup/restore snapshot. The DR fixture contains a committed reservation and usage event so recovery cannot pass while silently omitting the financial ledger.

## Explicit limits

This implementation establishes auditable metering and spend control. It does not yet claim:

- live Router/Chain integration for every provider/tool call;
- provider invoice reconciliation;
- taxes, credits, refunds or foreign-exchange handling;
- Stripe/invoice generation;
- product entitlement enforcement;
- production pricing or gross-margin targets;
- production SLO alerting for budget breaches.

Those remain separate delivery gates. Billing providers should consume the immutable usage ledger rather than becoming the source of usage truth.
