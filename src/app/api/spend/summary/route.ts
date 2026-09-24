import { NextResponse } from "next/server";

import {
  HumanAuthError,
  requireHumanPermission,
} from "@/lib/admin-auth";
import {
  requireHumanTenant,
  TenantAccessError,
} from "@/lib/human-tenant";
import {
  getSpendSummary,
  SpendGovernanceError,
} from "@/lib/spend-governance";

function authResponse(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: "tenant_access_denied" }, { status: 403 });
  }
  if (!(error instanceof HumanAuthError)) return undefined;
  if (error.code === "auth_unconfigured") {
    return NextResponse.json(
      { error: "human_auth_unconfigured" },
      { status: 503 },
    );
  }
  if (error.code === "unauthenticated") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function GET(request: Request) {
  try {
    const identity = await requireHumanPermission("metrics.read");
    const tenant = await requireHumanTenant(identity);
    const url = new URL(request.url);
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    if (!fromRaw || !toRaw) {
      return NextResponse.json(
        { error: "from_and_to_are_required" },
        { status: 400 },
      );
    }
    const summary = await getSpendSummary({
      tenantId: tenant.id,
      from: new Date(fromRaw),
      to: new Date(toRaw),
    });
    return NextResponse.json(summary, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const auth = authResponse(error);
    if (auth) return auth;
    if (error instanceof SpendGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return NextResponse.json(
      { error: "spend_summary_unavailable" },
      { status: 500 },
    );
  }
}
