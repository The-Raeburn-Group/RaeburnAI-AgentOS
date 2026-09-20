-- Add durable PostgreSQL-backed workflow queue with tenant-scoped idempotency,
-- retry/dead-letter state and leased worker ownership.
CREATE TYPE "WorkflowJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "WorkflowJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "context" JSONB NOT NULL,
    "status" "WorkflowJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkflowJob_runId_key" ON "WorkflowJob"("runId");
CREATE UNIQUE INDEX "WorkflowJob_tenantId_idempotencyKey_key" ON "WorkflowJob"("tenantId", "idempotencyKey");
CREATE INDEX "WorkflowJob_status_availableAt_idx" ON "WorkflowJob"("status", "availableAt");
CREATE INDEX "WorkflowJob_tenantId_status_idx" ON "WorkflowJob"("tenantId", "status");
CREATE INDEX "WorkflowJob_status_leaseExpiresAt_idx" ON "WorkflowJob"("status", "leaseExpiresAt");

ALTER TABLE "WorkflowJob"
  ADD CONSTRAINT "WorkflowJob_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowJob"
  ADD CONSTRAINT "WorkflowJob_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
