import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  HumanAuthError,
  requireHumanPermission,
} from "@/lib/admin-auth";
import {
  TenantAccessError,
  requireHumanTenant,
} from "@/lib/human-tenant";
import {
  BudgetPolicyInputSchema,
  UsageLedgerError,
  getBudgetSnapshot,
  serializeBudgetSnapshot,
  setBudgetPolicy,
} from "@/lib/usage-ledger";

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

export async function GET() {
  try {
    const identity = await requireHumanPermission("metrics.read");
    const tenant = await requireHumanTenant(identity);
    const snapshot = await getBudgetSnapshot(tenant.id);
    return NextResponse.json(serializeBudgetSnapshot(snapshot));
  } catch (error) {
    const auth = authError(error);
    if (auth) return auth;
    if (
      error instanceof UsageLedgerError &&
      error.code === "budget_policy_missing"
    ) {
      return NextResponse.json({ error: error.code }, { status: 404 });
    }
    return NextResponse.json({ error: "budget_unavailable" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const identity = await requireHumanPermission("settings.write");
    const tenant = await requireHumanTenant(identity);
    const policyInput = BudgetPolicyInputSchema.parse(await request.json());
    const policy = await setBudgetPolicy({
      tenantId: tenant.id,
      actorId: identity.actorId,
      policy: policyInput,
    });
    const snapshot = await getBudgetSnapshot(tenant.id);
    return NextResponse.json({
      policy: {
        id: policy.id,
        version: policy.version,
      },
      snapshot: serializeBudgetSnapshot(snapshot),
    });
  } catch (error) {
    const auth = authError(error);
    if (auth) return auth;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "invalid_budget_policy" },
        { status: 400 },
      );
    }
    if (error instanceof UsageLedgerError) {
      return NextResponse.json({ error: error.code }, { status: 422 });
    }
    return NextResponse.json({ error: "budget_update_failed" }, { status: 500 });
  }
}
