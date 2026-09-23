import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import {
  EvaluationCandidateError,
  reviewEvaluationCandidate,
} from "@/lib/evaluation-candidates";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";

function authError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: "tenant_access_denied" }, { status: 403 });
  }
  if (!(error instanceof HumanAuthError)) return undefined;
  if (error.code === "auth_unconfigured") {
    return NextResponse.json(
      { error: "human_auth_unconfigured" },
      { status: 503 },
    );
  }
  if (error.code === "unauthenticated") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

function candidateError(error: unknown) {
  if (!(error instanceof EvaluationCandidateError)) return undefined;
  if (
    error.code === "candidate_already_reviewed" ||
    error.code === "candidate_review_conflict"
  ) {
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status: 409 },
    );
  }
  if (
    error.code === "candidate_not_found" ||
    error.code === "tenant_not_found"
  ) {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  return NextResponse.json(
    { error: error.code, detail: error.detail ?? null },
    { status: 422 },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("evaluation.review");
    const tenant = await requireHumanTenant(identity);
    const { id } = await context.params;
    const requestId =
      request.headers.get("x-request-id")?.trim() || randomUUID();
    const candidate = await reviewEvaluationCandidate(
      id,
      await request.json(),
      {
        tenantReference: tenant.id,
        actorId: identity.actorId,
        requestId,
      },
    );
    return NextResponse.json({ candidate, requestId });
  } catch (error) {
    return authError(error) ?? candidateError(error) ?? apiError(error, "evaluation.candidates.review");
  }
}
