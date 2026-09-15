# PostgreSQL backup and recovery

RaeburnAI AgentOS stores tenant, agent, workflow, run, task, memory, MCP configuration, approval and audit state in PostgreSQL through versioned Prisma migrations. This document defines the repository-level recovery contract and the remaining production gates.

## Repository recovery contract

`npm run dr:backup` creates a PostgreSQL custom-format logical dump and a JSON manifest. The manifest contains no database credentials or row contents. It records:

- a SHA-256 digest of the dump;
- applied Prisma migration fingerprints;
- row counts and SHA-256 fingerprints for Tenant, Agent, Workflow, WorkflowRun, AgentTask, Memory, McpServer, Approval and AuditEvent.

The backup tool snapshots database state before and after `pg_dump`. If the fingerprints change during the dump window, the dump is deleted and the backup fails. Production logical backups therefore require a quiesced/read-only window or a provider snapshot/PITR mechanism that provides an equivalent consistent recovery point.

Database passwords are extracted from `DATABASE_URL` and supplied to PostgreSQL client tools through the child-process environment rather than command-line arguments.

## Restore safety

`npm run dr:restore` is intentionally destructive and requires the explicit `--allow-destructive-restore` flag embedded in that operator command. The tool verifies the dump SHA-256 against its manifest before running `pg_restore`.

The restore command uses:

- `--clean --if-exists`;
- `--exit-on-error`;
- `--single-transaction`;
- `--no-owner --no-acl` for portable service restores.

Restore into a separate database first. Do not point `DATABASE_URL` at a production database until the recovery owner has completed the incident/change procedure.

## Automated restore rehearsal

CI now performs a recovery rehearsal against PostgreSQL 16:

1. apply all committed Prisma migrations to a fresh source database;
2. run normal formatting, lint, type, test and security gates;
3. seed two deterministic tenant fixtures;
4. persist an agent, workflow, workflow run, task, memory record, MCP server configuration, approved action and audit event for each tenant;
5. create the logical backup and integrity manifest;
6. create a separate restore database;
7. restore the backup into that isolated target;
8. run `prisma migrate deploy` against the restored target to prove the migration state remains forward-safe;
9. recompute fingerprints and require the restored tenant/operational/approval/audit state to match the source manifest exactly.

The drill deliberately includes two tenants so recovery evidence covers tenant-scoped operational data rather than only an empty schema.

## Operator example

```sh
export DATABASE_URL='postgresql://.../agentos?schema=public'
npm run dr:seed       # test/staging fixtures only; never run against production
npm run dr:backup

export DATABASE_URL='postgresql://.../agentos_restore?schema=public'
npm run dr:restore
npm run db:migrate
npm run dr:verify
```

The default artifacts are written beneath `build/backups/`, which is ignored by Git. Backup files contain customer and operational data and must be stored only in encrypted, access-controlled backup storage.

## Production gates that remain

This repository recovery rehearsal is not a production RPO/RTO commitment. Before a hosted AgentOS deployment can be considered recovery-ready, the deployment owner must verify and document:

- managed PostgreSQL point-in-time recovery and backup frequency;
- encryption at rest/in transit and backup-region/data-residency controls;
- retention, legal hold and secure deletion requirements;
- backup and restore credentials separated from normal application credentials;
- scheduled restore drills with measured recovery duration;
- failed/stale backup monitoring and alerting;
- an incident runbook covering traffic freeze, restore, Prisma migration, tenant/isolation checks and traffic re-enable;
- recovery ordering with Chain, Knowledge Graph, governed approvals and any external audit/telemetry stores.

A platform-wide disaster recovery claim requires those deployment controls plus integrated recovery across all persistent RaeburnAI services.
