import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { UsageLedgerError, reserveSpend } from "@/lib/usage-ledger";

const RequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  estimatedCostMicrousd: z.number().int().safe().min(0),
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});

function ledgerError(error: unknown) {
  if (error instanceof UsageLedgerError) {
    const status =
      error.code === "budget_exceeded" || error.code === "idempotency_conflict"
        ? 409
        : error.code === "budget_policy_missing"
          ? 422
          : 400;
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_usage_request" },
      { status: 400 },
    );
  }
  return null;
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  try {
    const body = RequestSchema.parse(await request.json());
    const result = await reserveSpend({
      tenantId: authentication.context.tenantId,
      actorId: authentication.context.actorId,
      requestId: authentication.context.requestId,
      idempotencyKey: body.idempotencyKey,
      estimatedCostMicrousd: body.estimatedCostMicrousd,
      ...(body.ttlSeconds ? { ttlSeconds: body.ttlSeconds } : {}),
    });

    return NextResponse.json({
      reservation: {
        id: result.reservation.id,
        status: result.reservation.status,
        requestId: result.reservation.requestId,
        estimatedCostMicrousd:
          result.reservation.estimatedCostMicrousd.toString(),
        policyVersion: result.reservation.policyVersion,
        expiresAt: result.reservation.expiresAt.toISOString(),
      },
      idempotent: result.idempotent,
      warning: result.warning,
      reasons: result.reasons,
    });
  } catch (error) {
    return ledgerError(error) ?? apiError(error, "usage.reserve");
  }
}
