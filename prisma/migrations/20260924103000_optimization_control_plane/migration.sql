CREATE TYPE "OptimizationExperimentStatus" AS ENUM ('EVALUATED', 'APPROVED', 'REJECTED', 'PROMOTED');

CREATE TABLE "OptimizationExperiment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "baselineAgentId" TEXT NOT NULL,
    "challengerAgentId" TEXT NOT NULL,
    "baselineManifestDigest" TEXT NOT NULL,
    "challengerManifestDigest" TEXT NOT NULL,
    "artifactDigest" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "status" "OptimizationExperimentStatus" NOT NULL DEFAULT 'EVALUATED',
    "createdBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OptimizationExperiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OptimizationExperiment_distinct_agents_check"
      CHECK ("baselineAgentId" <> "challengerAgentId")
);

CREATE UNIQUE INDEX "OptimizationExperiment_tenantId_artifactDigest_key"
  ON "OptimizationExperiment"("tenantId", "artifactDigest");
CREATE INDEX "OptimizationExperiment_tenantId_status_createdAt_idx"
  ON "OptimizationExperiment"("tenantId", "status", "createdAt");
CREATE INDEX "OptimizationExperiment_baselineAgentId_idx"
  ON "OptimizationExperiment"("baselineAgentId");
CREATE INDEX "OptimizationExperiment_challengerAgentId_idx"
  ON "OptimizationExperiment"("challengerAgentId");

ALTER TABLE "OptimizationExperiment"
  ADD CONSTRAINT "OptimizationExperiment_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OptimizationExperiment"
  ADD CONSTRAINT "OptimizationExperiment_baselineAgentId_fkey"
  FOREIGN KEY ("baselineAgentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OptimizationExperiment"
  ADD CONSTRAINT "OptimizationExperiment_challengerAgentId_fkey"
  FOREIGN KEY ("challengerAgentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE OR REPLACE FUNCTION "enforce_optimization_experiment_tenant"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Agent"
    WHERE "id" = NEW."baselineAgentId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'optimization_baseline_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Agent"
    WHERE "id" = NEW."challengerAgentId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'optimization_challenger_tenant_mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OptimizationExperiment_tenant_guard"
BEFORE INSERT OR UPDATE OF "tenantId", "baselineAgentId", "challengerAgentId"
ON "OptimizationExperiment"
FOR EACH ROW
EXECUTE FUNCTION "enforce_optimization_experiment_tenant"();
