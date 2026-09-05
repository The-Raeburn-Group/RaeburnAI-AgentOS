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

    const [runCounts, approvalCounts] = await Promise.all([
      db.workflowRun.groupBy({
        by: ["status"],
        where: { workflow: { tenantId: tenant.id } },
        _count: true,
      }),
      db.approval.groupBy({
        by: ["status"],
        where: { run: { workflow: { tenantId: tenant.id } } },
        _count: true,
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

    runCounts.forEach((row) =>
      workflowRuns.set({ status: row.status }, row._count),
    );
    approvalCounts.forEach((row) =>
      approvals.set({ status: row.status }, row._count),
    );

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
