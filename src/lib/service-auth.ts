import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

function secureEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
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
