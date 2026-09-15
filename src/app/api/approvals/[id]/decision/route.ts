import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import { ApprovalDecisionError, decideWorkflowApproval } from "@/lib/approvals";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";

const DecisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2000).optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === "reject" && (!value.note || value.note.length < 3)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["note"],
        message: "A rejection reason is required.",
      });
    }
  });

function authError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json(
      { error: "tenant_access_denied" },
      { status: 403 },
    );
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

function decisionError(error: unknown) {
  if (!(error instanceof ApprovalDecisionError)) return undefined;
  switch (error.code) {
    case "approval_not_found":
      return NextResponse.json({ error: error.code }, { status: 404 });
    case "approval_self_decision_forbidden":
      return NextResponse.json({ error: error.code }, { status: 403 });
    case "approval_expired":
      return NextResponse.json({ error: error.code }, { status: 410 });
    case "approval_already_decided":
      return NextResponse.json({ error: error.code }, { status: 409 });
  }
}

async function parseDecision(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return {
      payload: DecisionSchema.parse(await request.json()),
      formRequest: false,
    };
  }

  const form = await request.formData();
  return {
    payload: DecisionSchema.parse({
      decision: form.get("decision"),
      note: form.get("note") || undefined,
    }),
    formRequest: true,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("approval.decide");
    const tenant = await requireHumanTenant(identity);
    const { id } = await context.params;
    const { payload, formRequest } = await parseDecision(request);
    const requestId =
      request.headers.get("x-request-id")?.trim() || randomUUID();

    const approval = await decideWorkflowApproval({
      approvalId: id,
      tenantId: tenant.id,
      actorId: identity.actorId,
      requestId,
      decision: payload.decision,
      ...(payload.note ? { note: payload.note } : {}),
    });

    if (formRequest) {
      const target = new URL("/approvals", request.url);
      target.searchParams.set("decided", approval.status.toLowerCase());
      return NextResponse.redirect(target, 303);
    }
    return NextResponse.json({ approval, requestId });
  } catch (error) {
    return (
      authError(error) ??
      decisionError(error) ??
      apiError(error, "approval.decision")
    );
  }
}
