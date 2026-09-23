-- Durable, tenant-scoped quarantine for production failures and counterexamples.
CREATE TYPE "EvaluationCandidateStatus" AS ENUM (
  'QUARANTINED',
  'APPROVED_EVALUATION',
  'APPROVED_TRAINING',
  'REJECTED'
);

CREATE TYPE "EvaluationCandidateTrigger" AS ENUM (
  'BENCHMARK_FAILURE',
  'HUMAN_CORRECTION',
  'TOOL_FAILURE',
  'LOW_CONFIDENCE',
  'SECURITY_EVENT',
  'MANUAL'
);

CREATE TYPE "EvaluationReviewDecision" AS ENUM (
  'APPROVE_EVALUATION',
  'APPROVE_TRAINING',
  'REJECT'
);

CREATE TABLE "EvaluationCandidate" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "trigger" "EvaluationCandidateTrigger" NOT NULL,
  "task" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "observedOutput" TEXT,
  "correction" TEXT,
  "confidence" DOUBLE PRECISION,
  "reasonLabels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "toolTrace" JSONB NOT NULL,
  "metadata" JSONB NOT NULL,
  "provenance" JSONB NOT NULL,
  "classification" TEXT NOT NULL,
  "findingTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "redactionCount" INTEGER NOT NULL DEFAULT 0,
  "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  "status" "EvaluationCandidateStatus" NOT NULL DEFAULT 'QUARANTINED',
  "approvedRecord" JSONB,
  "approvedRecordDigest" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvaluationCandidate_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "EvaluationCandidate_redaction_count_check"
    CHECK ("redactionCount" >= 0),
  CONSTRAINT "EvaluationCandidate_occurrence_count_check"
    CHECK ("occurrenceCount" >= 1),
  CONSTRAINT "EvaluationCandidate_classification_check"
    CHECK ("classification" IN ('general', 'personal', 'sensitive')),
  CONSTRAINT "EvaluationCandidate_human_correction_check"
    CHECK (
      "trigger" <> 'HUMAN_CORRECTION'
      OR ("correction" IS NOT NULL AND length(btrim("correction")) > 0)
    ),
  CONSTRAINT "EvaluationCandidate_low_confidence_check"
    CHECK (
      "trigger" <> 'LOW_CONFIDENCE'
      OR ("confidence" IS NOT NULL AND "confidence" <= 0.5)
    ),
  CONSTRAINT "EvaluationCandidate_review_state_check"
    CHECK (
      (
        "status" = 'QUARANTINED'
        AND "approvedRecord" IS NULL
        AND "approvedRecordDigest" IS NULL
        AND "reviewedBy" IS NULL
        AND "reviewedAt" IS NULL
      )
      OR
      (
        "status" IN ('APPROVED_EVALUATION', 'APPROVED_TRAINING')
        AND "approvedRecord" IS NOT NULL
        AND "approvedRecordDigest" IS NOT NULL
        AND "reviewedBy" IS NOT NULL
        AND "reviewedAt" IS NOT NULL
      )
      OR
      (
        "status" = 'REJECTED'
        AND "approvedRecord" IS NULL
        AND "approvedRecordDigest" IS NULL
        AND "reviewedBy" IS NOT NULL
        AND "reviewedAt" IS NOT NULL
      )
    )
);

CREATE TABLE "EvaluationCandidateOccurrence" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "sourceRefHash" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationCandidateOccurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvaluationCandidateOccurrence_source_ref_hash_check"
    CHECK ("sourceRefHash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "EvaluationCandidateReview" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "reviewer" TEXT NOT NULL,
  "decision" "EvaluationReviewDecision" NOT NULL,
  "note" TEXT NOT NULL,
  "datasetRecord" JSONB,
  "recordDigest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvaluationCandidateReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvaluationCandidateReview_payload_check"
    CHECK (
      (
        "decision" = 'REJECT'
        AND "datasetRecord" IS NULL
        AND "recordDigest" IS NULL
      )
      OR
      (
        "decision" IN ('APPROVE_EVALUATION', 'APPROVE_TRAINING')
        AND "datasetRecord" IS NOT NULL
        AND "recordDigest" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "EvaluationCandidate_tenantId_fingerprint_key"
  ON "EvaluationCandidate"("tenantId", "fingerprint");
CREATE UNIQUE INDEX "EvaluationCandidate_id_tenantId_key"
  ON "EvaluationCandidate"("id", "tenantId");
CREATE INDEX "EvaluationCandidate_tenantId_status_lastSeenAt_idx"
  ON "EvaluationCandidate"("tenantId", "status", "lastSeenAt");
CREATE INDEX "EvaluationCandidate_tenantId_trigger_lastSeenAt_idx"
  ON "EvaluationCandidate"("tenantId", "trigger", "lastSeenAt");

CREATE INDEX "EvaluationCandidateOccurrence_tenantId_candidateId_createdAt_idx"
  ON "EvaluationCandidateOccurrence"("tenantId", "candidateId", "createdAt");
CREATE INDEX "EvaluationCandidateOccurrence_tenantId_sourceRefHash_idx"
  ON "EvaluationCandidateOccurrence"("tenantId", "sourceRefHash");

CREATE UNIQUE INDEX "EvaluationCandidateReview_candidateId_key"
  ON "EvaluationCandidateReview"("candidateId");
CREATE INDEX "EvaluationCandidateReview_tenantId_createdAt_idx"
  ON "EvaluationCandidateReview"("tenantId", "createdAt");

ALTER TABLE "EvaluationCandidate"
  ADD CONSTRAINT "EvaluationCandidate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateOccurrence"
  ADD CONSTRAINT "EvaluationCandidateOccurrence_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateOccurrence"
  ADD CONSTRAINT "EvaluationCandidateOccurrence_candidateId_tenantId_fkey"
  FOREIGN KEY ("candidateId", "tenantId")
  REFERENCES "EvaluationCandidate"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateReview"
  ADD CONSTRAINT "EvaluationCandidateReview_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateReview"
  ADD CONSTRAINT "EvaluationCandidateReview_candidateId_tenantId_fkey"
  FOREIGN KEY ("candidateId", "tenantId")
  REFERENCES "EvaluationCandidate"("id", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;
