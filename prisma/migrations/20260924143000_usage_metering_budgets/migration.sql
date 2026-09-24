-- Durable tenant-scoped usage ledger and budget reservations.

CREATE TABLE "BudgetPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "monthlyLimitMicrousd" BIGINT,
    "perRequestLimitMicrousd" BIGINT,
    "warningRatio" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "enforcementMode" TEXT NOT NULL DEFAULT 'hard',
    "fallbackMode" TEXT NOT NULL DEFAULT 'block',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BudgetPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SpendReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "estimatedCostMicrousd" BIGINT NOT NULL,
    "committedCostMicrousd" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "policyVersion" INTEGER NOT NULL,
    "warning" BOOLEAN NOT NULL DEFAULT false,
    "decisionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reservationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "runId" TEXT,
    "actorId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "modelRegistryId" TEXT,
    "expertSlug" TEXT,
    "toolName" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "costMicrousd" BIGINT NOT NULL DEFAULT 0,
    "billableMetric" TEXT NOT NULL DEFAULT 'request',
    "billableUnits" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL,
    "eventDigest" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BudgetPolicy_tenantId_key" ON "BudgetPolicy"("tenantId");
CREATE INDEX "BudgetPolicy_updatedAt_idx" ON "BudgetPolicy"("updatedAt");

CREATE UNIQUE INDEX "SpendReservation_tenantId_idempotencyKey_key"
  ON "SpendReservation"("tenantId", "idempotencyKey");
CREATE INDEX "SpendReservation_tenantId_status_expiresAt_idx"
  ON "SpendReservation"("tenantId", "status", "expiresAt");
CREATE INDEX "SpendReservation_tenantId_requestId_idx"
  ON "SpendReservation"("tenantId", "requestId");

CREATE UNIQUE INDEX "UsageEvent_reservationId_key" ON "UsageEvent"("reservationId");
CREATE UNIQUE INDEX "UsageEvent_tenantId_idempotencyKey_key"
  ON "UsageEvent"("tenantId", "idempotencyKey");
CREATE INDEX "UsageEvent_tenantId_occurredAt_idx"
  ON "UsageEvent"("tenantId", "occurredAt");
CREATE INDEX "UsageEvent_tenantId_category_occurredAt_idx"
  ON "UsageEvent"("tenantId", "category", "occurredAt");
CREATE INDEX "UsageEvent_tenantId_requestId_idx"
  ON "UsageEvent"("tenantId", "requestId");
CREATE INDEX "UsageEvent_tenantId_billableMetric_occurredAt_idx"
  ON "UsageEvent"("tenantId", "billableMetric", "occurredAt");

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "SpendReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_monthlyLimitMicrousd_nonnegative"
  CHECK ("monthlyLimitMicrousd" IS NULL OR "monthlyLimitMicrousd" >= 0);

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_perRequestLimitMicrousd_nonnegative"
  CHECK ("perRequestLimitMicrousd" IS NULL OR "perRequestLimitMicrousd" >= 0);

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_warningRatio_range"
  CHECK ("warningRatio" > 0 AND "warningRatio" <= 1);

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_enforcementMode_allowed"
  CHECK ("enforcementMode" IN ('hard', 'monitor'));

ALTER TABLE "BudgetPolicy"
  ADD CONSTRAINT "BudgetPolicy_fallbackMode_allowed"
  CHECK ("fallbackMode" IN ('block', 'cheapest_eligible', 'local_only'));

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_estimatedCostMicrousd_nonnegative"
  CHECK ("estimatedCostMicrousd" >= 0);

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_committedCostMicrousd_nonnegative"
  CHECK ("committedCostMicrousd" IS NULL OR "committedCostMicrousd" >= 0);

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_status_allowed"
  CHECK ("status" IN ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED'));

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_costMicrousd_nonnegative"
  CHECK ("costMicrousd" >= 0);

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_token_counts_nonnegative"
  CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0);

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_latencyMs_nonnegative"
  CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0);

ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_billableUnits_positive"
  CHECK ("billableUnits" > 0);
