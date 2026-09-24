import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { UsageLedgerError, commitSpend } from "@/lib/usage-ledger";

const RequestSchema = z.object({
  reservationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(200),
  runId: z.string().min(1).max(256).optional(),
  category: z.enum(["model", "tool", "retrieval", "workflow", "other"]),
  provider: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(256).optional(),
  modelRegistryId: z.string().min(1).max(256).optional(),
  expertSlug: z.string().min(1).max(256).optional(),
  toolName: z.string().min(1).max(256).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  latencyMs: z.number().int().min(0).optional(),
  actualCostMicrousd: z.number().int().safe().min(0),
  billableMetric: z.string().min(1).max(128).optional(),
  billableUnits: z.number().int().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime({ offset: true }),
});

function ledgerError(error: unknown) {
  if (error instanceof UsageLedgerError) {
    const status =
      error.code === "idempotency_conflict"
        ? 409
        : error.code === "reservation_not_found"
          ? 404
          : 422;
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json({ error: "invalid_usage_request" }, { status: 400 });
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
    const result = await commitSpend({
      ...body,
      tenantId: authentication.context.tenantId,
      actorId: authentication.context.actorId,
    });

    return NextResponse.json({
      event: {
        id: result.event.id,
        requestId: result.event.requestId,
        category: result.event.category,
        costMicrousd: result.event.costMicrousd.toString(),
        billableMetric: result.event.billableMetric,
        billableUnits: result.event.billableUnits,
        eventDigest: result.event.eventDigest,
        occurredAt: result.event.occurredAt.toISOString(),
      },
      reservation: {
        id: result.reservation.id,
        status: result.reservation.status,
        committedCostMicrousd:
          result.reservation.committedCostMicrousd?.toString() ?? null,
      },
      idempotent: result.idempotent,
      budgetBreached: result.budgetBreached,
      overReservation: result.overReservation,
    });
  } catch (error) {
    return ledgerError(error) ?? apiError(error, "usage.commit");
  }
}
