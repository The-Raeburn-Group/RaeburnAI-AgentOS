-- Add explicit durable-memory classification, ownership, provenance and bounded lookup indexes.
ALTER TABLE "Memory"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'context',
  ADD COLUMN "subjectId" TEXT,
  ADD COLUMN "provenance" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "sensitivity" TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT 'raeburnai.memory-policy.v1',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Deterministic upserts require one key per tenant/scope. Fail closed instead of
-- silently deleting ambiguous legacy rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Memory"
    GROUP BY "tenantId", "scope", "key"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'memory migration blocked: duplicate tenant/scope/key rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "Memory_tenantId_scope_key_key"
  ON "Memory"("tenantId", "scope", "key");

DROP INDEX IF EXISTS "Memory_tenantId_scope_key_idx";

CREATE INDEX "Memory_tenantId_subjectId_kind_idx"
  ON "Memory"("tenantId", "subjectId", "kind");

CREATE INDEX "Memory_tenantId_expiresAt_idx"
  ON "Memory"("tenantId", "expiresAt");
