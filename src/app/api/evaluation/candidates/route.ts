import { randomUUID } from "node:crypto";
import {
  EvaluationCandidateStatus,
  EvaluationCandidateTrigger,
} from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import {
  EvaluationCandidateError,
  captureEvaluationCandidate,
  listEvaluationCandidates,
} from "@/lib/evaluation-candidates";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";

const ListQuerySchema = z.object({
  status: z
    .enum([\n      "quarantined",\n      "approved_evaluation",\n      "approved_training",\n      "rejected",\n    ])
    .optional(),
  trigger: z
    .enum([
      "benchmark_failure",
      "human_correction",
      "tool_failure",
      "low_confidence",
      "security_event",
      "manual",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const statusMap = {
  quarantined: EvaluationCandidateStatus.QUARANTINED,
  approved_evaluation: EvaluationCandidateStatus.APPROVED_EVALUATION,
  approved_training: EvaluationCandidateStatus.APPROVED_TRAINING,
  rejected: EvaluationCandidateStatus.REJECTED,
} as const;

const triggerMap = {
  benchmark_failure: EvaluationCandidateTrigger.BENCHMARK_FAILURE,
  human_correction: EvaluationCandidateTrigger.HUMAN_CORRECTION,
  tool_failure: EvaluationCandidateTrigger.TOOL_FAILURE,
  low_confidence: EvaluationCandidateTrigger.LOW_CONFIDENCE,
  security_event: EvaluationCandidateTrigger.SECURITY_EVENT,
  manual: EvaluationCandidateTrigger.MANUAL,
} as const;

function authError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json(\n      { error: "tenant_access_denied" },\n      { status: 403 },\n    );
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
  if (error.code === "tenant_not_found") {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  return NextResponse.json(
    { error: error.code, detail: error.detail ?? null },
    { status: 422 },
  );
}

export async function GET(request: Request) {
  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("evaluation.read");
    const tenant = await requireHumanTenant(identity);
    const url = new URL(request.url);
    const query = ListQuerySchema.parse({
      status: url.searchParams.get("status") || undefined,
      trigger: url.searchParams.get("trigger") || undefined,
      limit: url.searchParams.get("limit") || undefined,
    });
    const candidates = await listEvaluationCandidates(
      {
        tenantReference: tenant.id,
        actorId: identity.actorId,
        requestId: request.headers.get("x-request-id")?.trim() || randomUUID(),
      },
      {
        ...(query.status ? { status: statusMap[query.status] } : {}),
        ...(query.trigger ? { trigger: triggerMap[query.trigger] } : {}),
        limit: query.limit,
      },
    );
    return NextResponse.json({ tenantId: tenant.id, candidates });
  } catch (error) {
    return (\n      authError(error) ??\n      candidateError(error) ??\n      apiError(error, "evaluation.candidates.list")\n    );
  }
}

export async function POST(request: Request) {
  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  if (\n    !(request.headers.get("content-type") ?? "").includes("application/json")\n  ) {
    return NextResponse.json(
      { error: "application_json_required" },
      { status: 415 },
    );
  }

  try {
    const identity = await requireHumanPermission("evaluation.capture");
    const tenant = await requireHumanTenant(identity);
    const requestId =
      request.headers.get("x-request-id")?.trim() || randomUUID();
    const result = await captureEvaluationCandidate(await request.json(), {
      tenantReference: tenant.id,
      actorId: identity.actorId,
      requestId,
    });
    return NextResponse.json(
      { ...result, requestId },
      { status: result.deduplicated ? 200 : 201 },
    );
  } catch (error) {
    return (\n      authError(error) ??\n      candidateError(error) ??\n      apiError(error, "evaluation.candidates.capture")\n    );
  }
}
