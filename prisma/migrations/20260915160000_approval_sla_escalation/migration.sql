-- Add persisted approval service-level targets and escalation ownership.
ALTER TABLE "Approval"
  ADD COLUMN "slaDueAt" TIMESTAMP(3),
  ADD COLUMN "escalationOwner" TEXT,
  ADD COLUMN "escalationLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "escalatedAt" TIMESTAMP(3);

-- Existing pending approvals inherit a conservative 30-minute high-risk SLA
-- because approval risk defaulted to HIGH before explicit SLA policy existed.
UPDATE "Approval"
SET
  "slaDueAt" = LEAST(
    COALESCE("expiresAt", "createdAt" + INTERVAL '30 minutes'),
    "createdAt" + INTERVAL '30 minutes'
  ),
  "escalationOwner" = 'approver'
WHERE "status" = 'PENDING' AND "slaDueAt" IS NULL;

CREATE INDEX "Approval_tenantId_status_slaDueAt_idx"
  ON "Approval"("tenantId", "status", "slaDueAt");
CREATE INDEX "Approval_tenantId_status_escalationLevel_idx"
  ON "Approval"("tenantId", "status", "escalationLevel");
