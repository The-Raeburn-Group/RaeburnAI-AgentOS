# Durable Memory Policy

AgentOS durable memory is a tenant-bound, policy-enforced persistence layer. Callers do not write
directly to the Prisma `Memory` table in normal application flows.

## Memory kinds

| Kind | Intended scope | Required control |
| --- | --- | --- |
| `session_state` | `session` | Provenance + expiry |
| `user_preference` | `user` | Explicit consent + self ownership |
| `tenant_context` | `tenant` | Tenant boundary + expiry |
| `episode` | `workflow` or other non-user scope | Provenance + expiry |
| `context` | agent/workspace/tenant | Tenant boundary + expiry |

Subject-owned memory is permitted only in `user` scope. Deterministic keys include an internal
owner key, so two users can both have `preference:timezone` without overwriting one another.

## Write boundary

`POST /api/memory` requires the authenticated Chain service credential plus trusted
`x-tenant-id`, `x-actor-id` and `x-request-id` context. Before persistence AgentOS:

1. validates scope/kind/ownership/consent/provenance;
2. denies private-key material;
3. denies explicitly labelled special-category/high-risk personal data;
4. denies structured metadata fields that clearly indicate special-category/high-risk data;
5. redacts recognised credentials, payment-card numbers, national identifiers, email addresses and
   phone numbers from content and nested metadata;
6. records only redaction classes/counts in audit evidence, never the original matched value;
7. applies an explicit bounded TTL; and
8. resets embeddings on content updates so stale vectors are never retained across edited content.

The deterministic policy version is `raeburnai.memory-policy.v1`.

Detectors are intentionally conservative. They are not a substitute for upstream data
classification. Unstructured high-risk semantic content must be labelled by the caller and is
rejected by default.

## User preference controls

`user_preference` writes require `explicitConsent: true`, `scope: user` and a `subjectId`
equal to the authenticated actor. Administrative roles may inspect or erase a subject's memory for
privacy operations, but cannot create consented preferences on that subject's behalf.

`GET /api/memory` and `DELETE /api/memory` support correction/removal by deterministic scoped
key. `GET /api/memory/subject?subjectId=...` and `DELETE /api/memory/subject` are the memory-domain
export/erasure hooks for subject privacy workflows.

## Retention and operations

- `MEMORY_DEFAULT_TTL_SECONDS` defaults to 30 days.
- `MEMORY_MAX_TTL_SECONDS` defaults to 365 days.
- `npm run memory:purge` removes expired memory tenant-by-tenant and writes aggregate audit events.
- `/api/metrics` exposes tenant memory counts by kind/sensitivity and the expired-row backlog.
- The PostgreSQL disaster-recovery fixture includes policy version, provenance, kind, sensitivity
  and expiry fields; the normal backup/restore equality check therefore covers memory policy state.

A production scheduler still needs to invoke the retention worker at the chosen operational
cadence. Cross-module DSAR orchestration and backup-expiry/re-deletion handling remain separate
platform responsibilities.
