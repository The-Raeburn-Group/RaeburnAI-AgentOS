import { NextResponse } from "next/server";
import {
  HumanAuthError,
  requireHumanPermission,
} from "@/lib/admin-auth";
import {
  TenantAccessError,
  requireHumanTenant,
} from "@/lib/human-tenant";
import { getUsageSummary } from "@/lib/usage-ledger";

function authError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json({ error: "tenant_access_denied" }, { status: 403 });
  }
  if (!(error instanceof HumanAuthError)) return null;
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

function defaultPeriod(now: Date) {
  return {
    from: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    ),
    to: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    ),
  };
}

export async function GET(request: Request) {
  try {
    const identity = await requireHumanPermission("metrics.read");
    const tenant = await requireHumanTenant(identity);
    const url = new URL(request.url);
    const defaults = defaultPeriod(new Date());
    const from = url.searchParams.get("from")
      ? new Date(String(url.searchParams.get("from")))
      : defaults.from;
    const to = url.searchParams.get("to")
      ? new Date(String(url.searchParams.get("to")))
      : defaults.to;
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from.getTime() >= to.getTime()
    ) {
      return NextResponse.json(
        { error: "invalid_summary_period" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      await getUsageSummary({
        tenantId: tenant.id,
        from,
        to,
      }),
    );
  } catch (error) {
    return authError(error) ??
      NextResponse.json({ error: "usage_summary_unavailable" }, { status: 500 });
  }
}
