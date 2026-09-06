-- Add direct tenant ownership to all tenant-owned operational records.
ALTER TABLE "WorkflowRun" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "Approval" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "AuditEvent" ADD COLUMN "tenantId" TEXT;

-- Backfill from the existing trusted ownership graph.
UPDATE "WorkflowRun" r
SET "tenantId" = w."tenantId"
FROM "Workflow" w
WHERE r."workflowId" = w."id";

UPDATE "AgentTask" t
SET "tenantId" = r."tenantId"
FROM "WorkflowRun" r
WHERE t."runId" = r."id";

UPDATE "Approval" a
SET "tenantId" = r."tenantId"
FROM "WorkflowRun" r
WHERE a."runId" = r."id";

UPDATE "AuditEvent" e
SET "tenantId" = COALESCE(r."tenantId", e."metadata" ->> 'tenantId')
FROM "WorkflowRun" r
WHERE e."runId" = r."id";

UPDATE "AuditEvent"
SET "tenantId" = "metadata" ->> 'tenantId'
WHERE "tenantId" IS NULL
  AND "metadata" ? 'tenantId';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "WorkflowRun" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'tenant_isolation_backfill_failed:WorkflowRun';
  END IF;
  IF EXISTS (SELECT 1 FROM "AgentTask" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'tenant_isolation_backfill_failed:AgentTask';
  END IF;
  IF EXISTS (SELECT 1 FROM "Approval" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'tenant_isolation_backfill_failed:Approval';
  END IF;
  IF EXISTS (SELECT 1 FROM "AuditEvent" WHERE "tenantId" IS NULL) THEN
    RAISE EXCEPTION 'tenant_isolation_backfill_failed:AuditEvent';
  END IF;
END $$;

ALTER TABLE "WorkflowRun" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AgentTask" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "Approval" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "AuditEvent" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "WorkflowRun"
  ADD CONSTRAINT "WorkflowRun_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentTask"
  ADD CONSTRAINT "AgentTask_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval"
  ADD CONSTRAINT "Approval_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "WorkflowRun_tenantId_createdAt_idx" ON "WorkflowRun"("tenantId", "createdAt");
CREATE INDEX "WorkflowRun_tenantId_status_idx" ON "WorkflowRun"("tenantId", "status");
CREATE INDEX "AgentTask_tenantId_status_idx" ON "AgentTask"("tenantId", "status");
CREATE INDEX "Approval_tenantId_status_createdAt_idx" ON "Approval"("tenantId", "status", "createdAt");
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- Database-level consistency guards prevent a tenant key from disagreeing
-- with the existing workflow/run/agent ownership graph.
CREATE OR REPLACE FUNCTION enforce_workflow_run_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Workflow" w
    WHERE w."id" = NEW."workflowId" AND w."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'workflow_run_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WorkflowRun_tenant_guard"
BEFORE INSERT OR UPDATE OF "workflowId", "tenantId" ON "WorkflowRun"
FOR EACH ROW EXECUTE FUNCTION enforce_workflow_run_tenant();

CREATE OR REPLACE FUNCTION enforce_agent_task_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "WorkflowRun" r
    WHERE r."id" = NEW."runId" AND r."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'agent_task_run_tenant_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Agent" a
    WHERE a."id" = NEW."agentId" AND a."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'agent_task_agent_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AgentTask_tenant_guard"
BEFORE INSERT OR UPDATE OF "runId", "agentId", "tenantId" ON "AgentTask"
FOR EACH ROW EXECUTE FUNCTION enforce_agent_task_tenant();

CREATE OR REPLACE FUNCTION enforce_approval_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "WorkflowRun" r
    WHERE r."id" = NEW."runId" AND r."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'approval_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Approval_tenant_guard"
BEFORE INSERT OR UPDATE OF "runId", "tenantId" ON "Approval"
FOR EACH ROW EXECUTE FUNCTION enforce_approval_tenant();

CREATE OR REPLACE FUNCTION enforce_audit_event_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW."runId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkflowRun" r
    WHERE r."id" = NEW."runId" AND r."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'audit_event_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_tenant_guard"
BEFORE INSERT OR UPDATE OF "runId", "tenantId" ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION enforce_audit_event_tenant();
