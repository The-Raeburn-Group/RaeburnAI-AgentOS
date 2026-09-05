import { NextResponse } from "next/server";
import { humanAuthConfigured } from "@/lib/admin-auth";
import { db } from "@/lib/db";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const authConfigured = humanAuthConfigured();
    const productionAuthMissing =
      process.env.NODE_ENV === "production" && !authConfigured;
    return NextResponse.json(
      {
        status: productionAuthMissing ? "degraded" : "ok",
        database: "ok",
        humanAuth: authConfigured ? "configured" : "unconfigured",
        timestamp: new Date().toISOString(),
      },
      { status: productionAuthMissing ? 503 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        database: "error",
        humanAuth: humanAuthConfigured() ? "configured" : "unconfigured",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 },
    );
  }
}
