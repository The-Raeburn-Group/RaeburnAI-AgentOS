import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import {
  EvidenceVerificationError,
  verifyEvidenceBundle,
} from "@/lib/evidence-verification";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function verificationError(error: unknown) {
  if (error instanceof EvidenceVerificationError) {
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status: 422 },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_evidence_verification_request" },
      { status: 400 },
    );
  }
  return null;
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const payload = await request.json();
    const tenantId = authentication.context.tenantId;
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }

    const verification = verifyEvidenceBundle(payload);

    await db.auditEvent.create({
      data: {
        tenantId,
        actor: authentication.context.actorId,
        action: "evidence.verification.completed",
        metadata: {
          requestId: authentication.context.requestId,
          contractVersion: verification.contractVersion,
          bundleDigest: verification.bundleDigest,
          decision: verification.decision,
          strictness: verification.strictness,
          claimCount: verification.claimResults.length,
          calculationCount: verification.calculationResults.length,
          substantiatedCriticFindingCount:
            verification.critic.substantiatedFindingIds.length,
          ignoredCriticFindingCount:
            verification.critic.ignoredFindingIds.length,
          scores: verification.scores,
          reasonCount: verification.reasons.length,
          unresolvedRiskCount: verification.unresolvedRisks.length,
        },
      },
    });

    return NextResponse.json({
      verification,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
      },
    });
  } catch (error) {
    return verificationError(error) ?? apiError(error, "evidence.verification");
  }
}
