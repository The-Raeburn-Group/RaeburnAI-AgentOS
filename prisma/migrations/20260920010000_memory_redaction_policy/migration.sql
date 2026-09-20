-- Make durable memory keys deterministic per tenant/scope and support expiry sweeps.
CREATE UNIQUE INDEX "Memory_tenantId_scope_key_key"
  ON "Memory"("tenantId", "scope", "key");

DROP INDEX IF EXISTS "Memory_tenantId_scope_key_idx";

CREATE INDEX "Memory_tenantId_expiresAt_idx"
  ON "Memory"("tenantId", "expiresAt");
