# Approval SLA and escalation

AgentOS keeps approval-gated work fail-closed while giving operators an explicit, auditable escalation path for overdue decisions.

## Behaviour

Each new approval records:

- a hard approval expiry (`expiresAt`), after which the waiting workflow is cancelled;
- a decision SLA deadline (`slaDueAt`), calculated from the approval risk;
- an escalation owner label;
- an escalation level and timestamp once the SLA is breached.

An SLA breach does not execute the gated action and does not cancel the workflow by itself. It marks the approval as escalated, records one immutable `approval.escalated` audit event and keeps the workflow waiting for an authorised decision.

A hard expiry is different: the reconciliation sweep changes the approval to `EXPIRED`, cancels the waiting run/workflow/task, records `approval.expired`, and never calls the gated model/action.

Repeated or concurrent sweeps use compare-and-set database updates so the same approval cannot emit duplicate first-level escalation or expiry events.

## Reconciliation entry points

The approval inbox performs tenant-scoped reconciliation before rendering so an operator does not see knowingly stale SLA state.

`POST /api/approvals/sweep` is the service-to-service reconciliation endpoint. It requires the existing RaeburnAI-Chain service token and trusted `x-tenant-id`, `x-actor-id` and `x-request-id` context. The sweep is restricted to that authenticated tenant.

A deployment scheduler may call the endpoint periodically. The endpoint does not accept a tenant from the request body or query string.

## Default policy

Defaults are intentionally stricter as risk increases:

| Risk | Decision SLA | Escalation owner |
| --- | ---: | --- |
| LOW | 480 minutes | operator |
| MEDIUM | 120 minutes | operator |
| HIGH | 30 minutes | approver |
| CRITICAL | 10 minutes | admin |

Override the defaults with the `APPROVAL_SLA_*_MINUTES` and `APPROVAL_ESCALATION_OWNER_*` environment variables documented in `.env.example`.

The hard authorization lifetime remains separately controlled by `APPROVAL_TTL_MINUTES`. The SLA should normally be shorter than the hard TTL for approval classes that are expected to escalate before expiry.

## Evidence and operations

The approval inbox shows escalated requests first and surfaces SLA status, escalation level and escalation owner. Audit events retain the request ID used by the sweep so an escalation or expiry can be correlated with service logs and Chain traces.

Repository-level tests cover SLA escalation without execution, automatic expiry/cancellation, idempotent repeated sweeps, authenticated tenant scoping and service-token failure paths. Live scheduler cadence, paging/notification integrations and cross-service staging remain deployment concerns rather than repository-level claims.
