import { NextResponse } from "next/server";
import { sweepApprovalEscalations } from "@/lib/approval-sla";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

export async function POST(request: Request) {
  const auth = authenticateChainServiceRequest(request);
  if (!auth.ok) return auth.response;

  const result = await sweepApprovalEscalations({
    tenantId: auth.context.tenantId,
    actorId: auth.context.actorId,
    requestId: auth.context.requestId,
  });

  return NextResponse.json({
    tenantId: auth.context.tenantId,
    ...result,
  });
}
