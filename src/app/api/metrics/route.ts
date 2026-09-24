import { NextResponse } from "next/server";
import { Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";

function metricsAuthError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json(
      { error: "tenant_access_denied" },
      { status: 403 },
    );
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

export async function GET() {
  try {
    const identity = await requireHumanPermission("metrics.read");
    const tenant = await requireHumanTenant(identity);

    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const monthEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );

    const [
      runCounts,
      approvalCounts,
      memoryCounts,
      expiredMemories,
      monthlyUsage,
      activeReservations,
      budgetPolicy,
    ] = await Promise.all([
      db.workflowRun.groupBy({
        by: ["status"],
        where: { tenantId: tenant.id },
        _count: true,
      }),
      db.approval.groupBy({
        by: ["status"],
        where: { tenantId: tenant.id },
        _count: true,
      }),
      db.memory.groupBy({
        by: ["kind", "sensitivity"],
        where: { tenantId: tenant.id },
        _count: true,
      }),
      db.memory.count({
        where: {
          tenantId: tenant.id,
          expiresAt: { lte: now },
        },
      }),
      db.usageEvent.aggregate({
        where: {
          tenantId: tenant.id,
          occurredAt: { gte: monthStart, lt: monthEnd },
        },
        _count: { _all: true },
        _sum: { costMicrousd: true },
      }),
      db.spendReservation.aggregate({
        where: {
          tenantId: tenant.id,
          status: "RESERVED",
          expiresAt: { gt: now },
        },
        _sum: { estimatedCostMicrousd: true },
      }),
      db.budgetPolicy.findUnique({
        where: { tenantId: tenant.id },
      }),
    ]);

    const registry = new Registry();
    collectDefaultMetrics({ register: registry });
    const workflowRuns = new Gauge({
      name: "agentos_workflow_runs_total",
      help: "Tenant workflow runs by status",
      labelNames: ["status"],
      registers: [registry],
    });
    const approvals = new Gauge({
      name: "agentos_approvals_total",
      help: "Tenant approvals by status",
      labelNames: ["status"],
      registers: [registry],
    });
    const memories = new Gauge({
      name: "agentos_memory_records_total",
      help: "Tenant durable memory records by kind and sensitivity",
      labelNames: ["kind", "sensitivity"],
      registers: [registry],
    });
    const memoryExpired = new Gauge({
      name: "agentos_memory_expired_total",
      help: "Tenant durable memory records awaiting expiry purge",
      registers: [registry],
    });
    const monthlyUsageCost = new Gauge({
      name: "agentos_usage_monthly_cost_microusd",
      help: "Tenant committed usage cost in the current UTC month",
      registers: [registry],
    });
    const monthlyUsageEvents = new Gauge({
      name: "agentos_usage_monthly_events_total",
      help: "Tenant committed usage events in the current UTC month",
      registers: [registry],
    });
    const activeReservedCost = new Gauge({
      name: "agentos_usage_reserved_cost_microusd",
      help: "Tenant active pre-spend reservations in micro-USD",
      registers: [registry],
    });
    const monthlyBudgetLimit = new Gauge({
      name: "agentos_budget_monthly_limit_microusd",
      help: "Configured tenant monthly budget limit in micro-USD",
      registers: [registry],
    });
    const budgetUtilization = new Gauge({
      name: "agentos_budget_utilization_ratio",
      help: "Committed plus reserved cost divided by monthly budget limit",
      registers: [registry],
    });

    runCounts.forEach((row) =>
      workflowRuns.set({ status: row.status }, row._count),
    );
    approvalCounts.forEach((row) =>
      approvals.set({ status: row.status }, row._count),
    );
    memoryCounts.forEach((row) =>
      memories.set(
        { kind: row.kind, sensitivity: row.sensitivity },
        row._count,
      ),
    );
    memoryExpired.set(expiredMemories);

    const spentMicrousd = monthlyUsage._sum.costMicrousd ?? 0n;
    const reservedMicrousd =
      activeReservations._sum.estimatedCostMicrousd ?? 0n;
    monthlyUsageCost.set(Number(spentMicrousd));
    monthlyUsageEvents.set(monthlyUsage._count._all);
    activeReservedCost.set(Number(reservedMicrousd));
    if (
      budgetPolicy?.monthlyLimitMicrousd !== null &&
      budgetPolicy?.monthlyLimitMicrousd !== undefined
    ) {
      monthlyBudgetLimit.set(Number(budgetPolicy.monthlyLimitMicrousd));
      if (budgetPolicy.monthlyLimitMicrousd > 0n) {
        budgetUtilization.set(
          Number(spentMicrousd + reservedMicrousd) /
            Number(budgetPolicy.monthlyLimitMicrousd),
        );
      }
    }

    return new NextResponse(await registry.metrics(), {
      headers: {
        "cache-control": "private, no-store",
        "content-type": registry.contentType,
        "x-raeburn-tenant-id": tenant.id,
      },
    });
  } catch (error) {
    return (
      metricsAuthError(error) ??
      NextResponse.json({ error: "metrics_unavailable" }, { status: 500 })
    );
  }
}
