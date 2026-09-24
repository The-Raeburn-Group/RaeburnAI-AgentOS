CREATE TYPE "SpendReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');
CREATE TYPE "UsageCostBasis" AS ENUM (
  'REGISTRY_ACTUAL_TOKENS',
  'REGISTRY_RESERVED_ESTIMATE',
  'REGISTRY_ESTIMATE_ONLY',
  'UNKNOWN'
);
CREATE TYPE "UsageOutcome" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "SpendBudget" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "softLimitMicros" BIGINT,
  "hardLimitMicros" BIGINT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SpendBudget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendBudget_positive_hard_limit_check"
    CHECK ("hardLimitMicros" > 0),
  CONSTRAINT "SpendBudget_soft_limit_check"
    CHECK ("softLimitMicros" IS NULL OR ("softLimitMicros" > 0 AND "softLimitMicros" <= "hardLimitMicros")),
  CONSTRAINT "SpendBudget_period_check"
    CHECK ("periodEnd" > "periodStart"),
  CONSTRAINT "SpendBudget_currency_check"
    CHECK ("currency" = 'USD')
);

CREATE UNIQUE INDEX "SpendBudget_id_tenantId_key"
  ON "SpendBudget"("id", "tenantId");
CREATE UNIQUE INDEX "SpendBudget_tenantId_name_periodStart_periodEnd_key"
  ON "SpendBudget"("tenantId", "name", "periodStart", "periodEnd");
CREATE INDEX "SpendBudget_tenantId_enabled_periodStart_periodEnd_idx"
  ON "SpendBudget"("tenantId", "enabled", "periodStart", "periodEnd");

ALTER TABLE "SpendBudget"
  ADD CONSTRAINT "SpendBudget_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SpendReservation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "budgetId" TEXT NOT NULL,
  "runId" TEXT,
  "taskId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "estimatedTokens" INTEGER NOT NULL,
  "unitCostMicrosPer1k" BIGINT NOT NULL,
  "reservedMicros" BIGINT NOT NULL,
  "settledMicros" BIGINT,
  "actualTokens" INTEGER,
  "status" "SpendReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpendReservation_estimated_tokens_check"
    CHECK ("estimatedTokens" > 0),
  CONSTRAINT "SpendReservation_unit_cost_check"
    CHECK ("unitCostMicrosPer1k" >= 0),
  CONSTRAINT "SpendReservation_reserved_cost_check"
    CHECK ("reservedMicros" >= 0),
  CONSTRAINT "SpendReservation_settled_cost_check"
    CHECK ("settledMicros" IS NULL OR "settledMicros" >= 0),
  CONSTRAINT "SpendReservation_actual_tokens_check"
    CHECK ("actualTokens" IS NULL OR "actualTokens" >= 0),
  CONSTRAINT "SpendReservation_terminal_fields_check"
    CHECK (
      ("status" = 'RESERVED' AND "settledMicros" IS NULL AND "settledAt" IS NULL)
      OR
      ("status" IN ('SETTLED', 'RELEASED') AND "settledAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "SpendReservation_id_tenantId_key"
  ON "SpendReservation"("id", "tenantId");
CREATE UNIQUE INDEX "SpendReservation_tenantId_idempotencyKey_key"
  ON "SpendReservation"("tenantId", "idempotencyKey");
CREATE INDEX "SpendReservation_budgetId_status_idx"
  ON "SpendReservation"("budgetId", "status");
CREATE INDEX "SpendReservation_tenantId_createdAt_idx"
  ON "SpendReservation"("tenantId", "createdAt");
CREATE INDEX "SpendReservation_tenantId_runId_idx"
  ON "SpendReservation"("tenantId", "runId");
CREATE INDEX "SpendReservation_tenantId_taskId_idx"
  ON "SpendReservation"("tenantId", "taskId");

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_budgetId_tenantId_fkey"
  FOREIGN KEY ("budgetId", "tenantId") REFERENCES "SpendBudget"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UsageLedgerEntry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "reservationId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "runId" TEXT,
  "taskId" TEXT,
  "requestId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "estimatedTokens" INTEGER NOT NULL,
  "totalTokens" INTEGER,
  "latencyMs" INTEGER NOT NULL,
  "unitCostMicrosPer1k" BIGINT,
  "estimatedCostMicros" BIGINT,
  "actualCostMicros" BIGINT,
  "costBasis" "UsageCostBasis" NOT NULL,
  "outcome" "UsageOutcome" NOT NULL,
  "billableUnit" TEXT NOT NULL DEFAULT 'model_call',
  "billableQuantity" INTEGER NOT NULL DEFAULT 1,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UsageLedgerEntry_estimated_tokens_check"
    CHECK ("estimatedTokens" > 0),
  CONSTRAINT "UsageLedgerEntry_total_tokens_check"
    CHECK ("totalTokens" IS NULL OR "totalTokens" >= 0),
  CONSTRAINT "UsageLedgerEntry_latency_check"
    CHECK ("latencyMs" >= 0),
  CONSTRAINT "UsageLedgerEntry_unit_cost_check"
    CHECK ("unitCostMicrosPer1k" IS NULL OR "unitCostMicrosPer1k" >= 0),
  CONSTRAINT "UsageLedgerEntry_estimated_cost_check"
    CHECK ("estimatedCostMicros" IS NULL OR "estimatedCostMicros" >= 0),
  CONSTRAINT "UsageLedgerEntry_actual_cost_check"
    CHECK ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0),
  CONSTRAINT "UsageLedgerEntry_billable_quantity_check"
    CHECK ("billableQuantity" > 0)
);

CREATE UNIQUE INDEX "UsageLedgerEntry_reservationId_key"
  ON "UsageLedgerEntry"("reservationId");
CREATE UNIQUE INDEX "UsageLedgerEntry_tenantId_idempotencyKey_key"
  ON "UsageLedgerEntry"("tenantId", "idempotencyKey");
CREATE INDEX "UsageLedgerEntry_tenantId_occurredAt_idx"
  ON "UsageLedgerEntry"("tenantId", "occurredAt");
CREATE INDEX "UsageLedgerEntry_tenantId_provider_model_occurredAt_idx"
  ON "UsageLedgerEntry"("tenantId", "provider", "model", "occurredAt");
CREATE INDEX "UsageLedgerEntry_tenantId_runId_idx"
  ON "UsageLedgerEntry"("tenantId", "runId");
CREATE INDEX "UsageLedgerEntry_tenantId_taskId_idx"
  ON "UsageLedgerEntry"("tenantId", "taskId");

ALTER TABLE "UsageLedgerEntry"
  ADD CONSTRAINT "UsageLedgerEntry_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "enforce_spend_reservation_tenant"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."runId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkflowRun"
    WHERE "id" = NEW."runId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'spend_reservation_run_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."taskId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AgentTask"
    WHERE "id" = NEW."taskId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'spend_reservation_task_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."runId" IS NOT NULL AND NEW."taskId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AgentTask"
    WHERE "id" = NEW."taskId"
      AND "runId" = NEW."runId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'spend_reservation_task_run_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SpendReservation_tenant_guard"
BEFORE INSERT OR UPDATE OF "tenantId", "runId", "taskId"
ON "SpendReservation"
FOR EACH ROW
EXECUTE FUNCTION "enforce_spend_reservation_tenant"();

CREATE OR REPLACE FUNCTION "enforce_usage_ledger_tenant"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."reservationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "SpendReservation"
    WHERE "id" = NEW."reservationId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'usage_reservation_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."runId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "WorkflowRun"
    WHERE "id" = NEW."runId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'usage_run_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."taskId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AgentTask"
    WHERE "id" = NEW."taskId" AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'usage_task_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."runId" IS NOT NULL AND NEW."taskId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AgentTask"
    WHERE "id" = NEW."taskId"
      AND "runId" = NEW."runId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'usage_task_run_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UsageLedgerEntry_tenant_guard"
BEFORE INSERT OR UPDATE OF "tenantId", "reservationId", "runId", "taskId"
ON "UsageLedgerEntry"
FOR EACH ROW
EXECUTE FUNCTION "enforce_usage_ledger_tenant"();
