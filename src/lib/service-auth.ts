import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export interface ChainServiceContext {
  tenantId: string;
  actorId: string;
  requestId: string;
  roles: string[];
}

export type ChainServiceAuthResult =
  | { ok: true; context: ChainServiceContext }
  | { ok: false; response: NextResponse };

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
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Invalid Chain service context" },
        { status: 400 },
      ),
    };
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
    },
  };
}
