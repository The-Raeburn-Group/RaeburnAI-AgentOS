-- Add explicit approval risk and SLA/expiry metadata.
CREATE TYPE "ApprovalRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

ALTER TABLE "Approval"
  ADD COLUMN "risk" "ApprovalRisk" NOT NULL DEFAULT 'HIGH',
  ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Give legacy pending approvals a bounded decision window while preserving
-- historical decided records exactly as they were.
UPDATE "Approval"
SET "expiresAt" = "createdAt" + INTERVAL '60 minutes'
WHERE "status" = 'PENDING' AND "expiresAt" IS NULL;

DROP INDEX IF EXISTS "Approval_tenantId_status_createdAt_idx";
CREATE INDEX "Approval_tenantId_status_risk_createdAt_idx"
  ON "Approval"("tenantId", "status", "risk", "createdAt");
CREATE INDEX "Approval_tenantId_status_expiresAt_idx"
  ON "Approval"("tenantId", "status", "expiresAt");
