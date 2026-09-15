import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export interface ChainServiceContext {
  tenantId: string;
  actorId: string;
  requestId: string;
  roles: string[];
  approvalId?: string;
  idempotencyKey?: string;
  executionId?: string;
}

export type ChainServiceAuthResult =
  | { ok: true; context: ChainServiceContext }
  | { ok: false; response: NextResponse };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function requiredHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value || undefined;
}

function invalidContext(error: string) {
  return {
    ok: false as const,
    response: NextResponse.json({ error }, { status: 400 }),
  };
}

export function requireChainServiceToken(request: Request) {
  const expectedToken = process.env.RAEBURN_CHAIN_SERVICE_TOKEN?.trim();
  if (!expectedToken) {
    return NextResponse.json(
      { error: "Chain service authentication is not configured" },
      { status: 503 },
    );
  }

  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  const suppliedToken = authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : "";

  if (!suppliedToken || !secureEqual(suppliedToken, expectedToken)) {
    return NextResponse.json(
      { error: "Unauthorized service request" },
      { status: 401 },
    );
  }

  return null;
}

export function authenticateChainServiceRequest(
  request: Request,
): ChainServiceAuthResult {
  const tokenFailure = requireChainServiceToken(request);
  if (tokenFailure) return { ok: false, response: tokenFailure };

  const tenantId = requiredHeader(request, "x-tenant-id");
  const actorId = requiredHeader(request, "x-actor-id");
  const requestId = requiredHeader(request, "x-request-id");
  if (!tenantId || !actorId || !requestId) {
    return invalidContext("Invalid Chain service context");
  }

  const approvalId = requiredHeader(request, "x-raeburn-approval-id");
  const idempotencyKey = requiredHeader(request, "idempotency-key");
  const executionId = requiredHeader(request, "x-raeburn-execution-id");
  const governedHeaders = [approvalId, idempotencyKey, executionId].filter(
    Boolean,
  ).length;

  if (governedHeaders !== 0 && governedHeaders !== 3) {
    return invalidContext("Incomplete governed Chain execution context");
  }
  if (approvalId && !UUID_PATTERN.test(approvalId)) {
    return invalidContext("Invalid Chain approval ID");
  }
  if (executionId && !UUID_PATTERN.test(executionId)) {
    return invalidContext("Invalid Chain execution ID");
  }
  if (idempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return invalidContext("Invalid Chain idempotency key");
  }

  const roles = (request.headers.get("x-roles") ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);

  return {
    ok: true,
    context: {
      tenantId,
      actorId,
      requestId,
      roles,
      ...(approvalId ? { approvalId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(executionId ? { executionId } : {}),
    },
  };
}
