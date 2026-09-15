import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import { runWorkflow } from "@/lib/orchestrator";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { WorkflowRunRequestSchema } from "@/lib/types";

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request, {
    requireGovernedExecution: true,
  });
  if (!authentication.ok) return authentication.response;

  const { approvalId, idempotencyKey, executionId } = authentication.context;
  if (!approvalId || !idempotencyKey || !executionId) {
    return NextResponse.json(
      { error: "Governed Chain execution context required" },
      { status: 400 },
    );
  }

  const limited = rateLimit(request, 20, 60000);
  if (limited) return limited;

  try {
    const body = await request.json();
    const payload = WorkflowRunRequestSchema.parse(body);
    const run = await runWorkflow(payload, {
      tenantReference: authentication.context.tenantId,
      actorId: authentication.context.actorId,
      requestId: authentication.context.requestId,
    });

    await db.auditEvent.create({
      data: {
        tenantId: run.tenantId,
        runId: run.id,
        actor: authentication.context.actorId,
        action: "chain.governed_execution.received",
        metadata: {
          chainApprovalId: approvalId,
          chainExecutionId: executionId,
          idempotencyKey,
          requestId: authentication.context.requestId,
          runStatus: run.status,
        },
      },
    });

    return NextResponse.json({ run });
  } catch (error) {
    return apiError(error, "workflow.run");
  }
}
