import { NextResponse } from "next/server";
import { apiError, rateLimit } from "@/lib/http";
import { runWorkflow } from "@/lib/orchestrator";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { WorkflowRunRequestSchema } from "@/lib/types";

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

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
    return NextResponse.json({ run });
  } catch (error) {
    return apiError(error, "workflow.run");
  }
}
