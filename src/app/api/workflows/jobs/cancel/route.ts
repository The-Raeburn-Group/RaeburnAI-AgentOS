import { NextResponse } from "next/server";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import {
  WorkflowQueueError,
  cancelWorkflowJob,
} from "@/lib/workflow-queue";

function queueError(error: WorkflowQueueError) {
  if (error.code === "job_not_found" || error.code === "tenant_not_found") {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  if (error.code === "job_not_cancellable") {
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  return NextResponse.json({ error: error.code }, { status: 400 });
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const body = (await request.json()) as {
      jobId?: unknown;
      reason?: unknown;
    };
    if (typeof body.jobId !== "string" || !body.jobId.trim()) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }
    if (
      body.reason !== undefined &&
      (typeof body.reason !== "string" || body.reason.length > 500)
    ) {
      return NextResponse.json({ error: "Invalid cancellation reason" }, { status: 400 });
    }

    const job = await cancelWorkflowJob({
      jobId: body.jobId.trim(),
      tenantReference: authentication.context.tenantId,
      actorId: authentication.context.actorId,
      ...(typeof body.reason === "string" && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
    });
    return NextResponse.json({
      job: {
        id: job.id,
        status: job.status,
        lastError: job.lastError,
        updatedAt: job.updatedAt,
      },
    });
  } catch (error) {
    if (error instanceof WorkflowQueueError) return queueError(error);
    return apiError(error, "workflow.jobs.cancel");
  }
}
