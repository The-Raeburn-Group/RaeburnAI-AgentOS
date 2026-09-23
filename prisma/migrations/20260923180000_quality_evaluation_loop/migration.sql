-- Add a privacy-minimised, tenant-scoped evaluation-candidate pipeline.
CREATE TYPE "EvaluationCandidateStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'PROMOTED');

CREATE TABLE "EvaluationCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "failureKind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reasonLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EvaluationCandidateStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "datasetRecord" JSONB,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EvaluationCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvaluationCandidateOccurrence" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvaluationCandidateOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvaluationCandidate_tenantId_fingerprint_key"
  ON "EvaluationCandidate"("tenantId", "fingerprint");
CREATE INDEX "EvaluationCandidate_tenantId_status_createdAt_idx"
  ON "EvaluationCandidate"("tenantId", "status", "createdAt");
CREATE INDEX "EvaluationCandidate_tenantId_lastSeenAt_idx"
  ON "EvaluationCandidate"("tenantId", "lastSeenAt");
CREATE UNIQUE INDEX "EvaluationCandidateOccurrence_sourceEventId_key"
  ON "EvaluationCandidateOccurrence"("sourceEventId");
CREATE INDEX "EvaluationCandidateOccurrence_candidateId_createdAt_idx"
  ON "EvaluationCandidateOccurrence"("candidateId", "createdAt");

ALTER TABLE "EvaluationCandidate"
  ADD CONSTRAINT "EvaluationCandidate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateOccurrence"
  ADD CONSTRAINT "EvaluationCandidateOccurrence_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "EvaluationCandidate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EvaluationCandidateOccurrence"
  ADD CONSTRAINT "EvaluationCandidateOccurrence_sourceEventId_fkey"
  FOREIGN KEY ("sourceEventId") REFERENCES "AuditEvent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
