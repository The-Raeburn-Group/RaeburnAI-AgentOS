import { NextResponse } from "next/server";
import { listApprovalExceptions } from "@/lib/approval-exceptions";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function limitFromRequest(request: Request): number | undefined {
  const raw = new URL(request.url).searchParams.get("limit");
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("invalid_exception_limit");
  }
  return value;
}

export async function GET(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  let limit: number | undefined;
  try {
    limit = limitFromRequest(request);
  } catch {
    return NextResponse.json({ error: "Invalid exception limit" }, { status: 400 });
  }

  const exceptions = await listApprovalExceptions({
    tenantId: authentication.context.tenantId,
    actorId: authentication.context.actorId,
    requestId: authentication.context.requestId,
    ...(limit !== undefined ? { limit } : {}),
  });

  return NextResponse.json({
    tenantId: authentication.context.tenantId,
    exceptions,
  });
}
