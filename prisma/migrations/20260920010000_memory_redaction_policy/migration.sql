-- Add explicit durable-memory classification, ownership, provenance and bounded lookup indexes.
ALTER TABLE "Memory"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'context',
  ADD COLUMN "ownerKey" TEXT NOT NULL DEFAULT '__shared__',
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
    GROUP BY "tenantId", "scope", "ownerKey", "key"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'memory migration blocked: duplicate tenant/scope/owner/key rows exist';
  END IF;
END $$;

ALTER TABLE "Memory"
  ADD CONSTRAINT "Memory_scope_check"
    CHECK ("scope" IN ('session', 'workflow', 'agent', 'workspace', 'tenant', 'user')),
  ADD CONSTRAINT "Memory_kind_check"
    CHECK ("kind" IN ('context', 'session_state', 'user_preference', 'tenant_context', 'episode')),
  ADD CONSTRAINT "Memory_sensitivity_check"
    CHECK ("sensitivity" IN ('general', 'personal', 'sensitive')),
  ADD CONSTRAINT "Memory_owner_subject_check"
    CHECK (
      ("subjectId" IS NULL AND "ownerKey" = '__shared__')
      OR
      ("subjectId" IS NOT NULL AND "scope" = 'user' AND "ownerKey" = "subjectId")
    ),
  ADD CONSTRAINT "Memory_user_preference_check"
    CHECK (
      "kind" <> 'user_preference'
      OR ("scope" = 'user' AND "subjectId" IS NOT NULL)
    ),
  ADD CONSTRAINT "Memory_tenant_context_check"
    CHECK ("kind" <> 'tenant_context' OR "scope" = 'tenant');

CREATE UNIQUE INDEX "Memory_tenantId_scope_ownerKey_key_key"
  ON "Memory"("tenantId", "scope", "ownerKey", "key");

DROP INDEX IF EXISTS "Memory_tenantId_scope_key_idx";

CREATE INDEX "Memory_tenantId_subjectId_kind_idx"
  ON "Memory"("tenantId", "subjectId", "kind");

CREATE INDEX "Memory_tenantId_expiresAt_idx"
  ON "Memory"("tenantId", "expiresAt");
