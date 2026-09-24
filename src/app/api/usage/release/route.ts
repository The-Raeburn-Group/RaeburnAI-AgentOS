import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { UsageLedgerError, releaseSpend } from "@/lib/usage-ledger";

const RequestSchema = z.object({
  reservationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  try {
    const body = RequestSchema.parse(await request.json());
    const reservation = await releaseSpend({
      tenantId: authentication.context.tenantId,
      actorId: authentication.context.actorId,
      reservationId: body.reservationId,
      reason: body.reason,
    });
    return NextResponse.json({
      reservation: {
        id: reservation.id,
        status: reservation.status,
        requestId: reservation.requestId,
      },
    });
  } catch (error) {
    if (error instanceof UsageLedgerError) {
      return NextResponse.json(
        { error: error.code, detail: error.detail ?? null },
        {
          status:
            error.code === "reservation_not_found"
              ? 404
              : error.code === "reservation_invalid_state"
                ? 409
                : 422,
        },
      );
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_usage_request" },
        { status: 400 },
      );
    }
    return apiError(error, "usage.release");
  }
}
