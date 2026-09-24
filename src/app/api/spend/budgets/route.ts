import { NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  HumanAuthError,
  requireHumanPermission,
} from "@/lib/admin-auth";
import {
  requireHumanTenant,
  TenantAccessError,
} from "@/lib/human-tenant";
import {
  createSpendBudget,
  listSpendBudgets,
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

function budgetJson(budget: Awaited<ReturnType<typeof listSpendBudgets>>[number]) {
  return {
    id: budget.id,
    name: budget.name,
    currency: budget.currency,
    periodStart: budget.periodStart.toISOString(),
    periodEnd: budget.periodEnd.toISOString(),
    softLimitMicros: budget.softLimitMicros?.toString() ?? null,
    hardLimitMicros: budget.hardLimitMicros.toString(),
    enabled: budget.enabled,
    createdBy: budget.createdBy,
    createdAt: budget.createdAt.toISOString(),
    updatedAt: budget.updatedAt.toISOString(),
  };
}

export async function GET() {
  try {
    const identity = await requireHumanPermission("metrics.read");
    const tenant = await requireHumanTenant(identity);
    const budgets = await listSpendBudgets(tenant.id);
    return NextResponse.json({
      contractVersion: "raeburnai.spend-governance.v1",
      budgets: budgets.map(budgetJson),
    });
  } catch (error) {
    return (
      authResponse(error) ??
      NextResponse.json({ error: "spend_budgets_unavailable" }, { status: 500 })
    );
  }
}

export async function POST(request: Request) {
  try {
    const identity = await requireHumanPermission("settings.write");
    const tenant = await requireHumanTenant(identity);
    const input: unknown = await request.json();
    const budget = await createSpendBudget({
      tenantId: tenant.id,
      actorId: identity.actorId,
      input,
    });
    return NextResponse.json({ budget: budgetJson(budget) }, { status: 201 });
  } catch (error) {
    const auth = authResponse(error);
    if (auth) return auth;
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "invalid_budget" }, { status: 400 });
    }
    if (error instanceof SpendGovernanceError) {
      const status =
        error.code === "tenant_not_found"
          ? 404
          : error.code === "overlapping_budget"
            ? 409
            : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    return NextResponse.json(
      { error: "spend_budget_write_failed" },
      { status: 500 },
    );
  }
}
