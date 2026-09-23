import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import {
  EvaluationCandidateError,
  exportApprovedEvaluationRecordsJsonl,
} from "@/lib/evaluation-candidates";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";

const QuerySchema = z.object({
  purpose: z.enum(["evaluation", "training"]),
});

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

export async function GET(request: Request) {
  const limited = rateLimit(request, 20, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("evaluation.review");
    const tenant = await requireHumanTenant(identity);
    const purpose = QuerySchema.parse({
      purpose: new URL(request.url).searchParams.get("purpose"),
    }).purpose;
    const requestId =
      request.headers.get("x-request-id")?.trim() || randomUUID();
    const jsonl = await exportApprovedEvaluationRecordsJsonl(
      {
        tenantReference: tenant.id,
        actorId: identity.actorId,
        requestId,
      },
      purpose,
    );
    return new Response(jsonl, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="raeburnai-${purpose}-records.jsonl"`,
      },
    });
  } catch (error) {
    if (error instanceof EvaluationCandidateError) {
      return NextResponse.json(
        { error: error.code, detail: error.detail ?? null },
        { status: error.code === "tenant_not_found" ? 404 : 409 },
      );
    }
    return authError(error) ?? apiError(error, "evaluation.candidates.export");
  }
}
