import { NextResponse } from 'next/server';
import { Registry, collectDefaultMetrics, Gauge } from 'prom-client';
import { db } from '@/lib/db';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const workflowRuns = new Gauge({
  name: 'agentos_workflow_runs_total',
  help: 'Total workflow runs by status',
  labelNames: ['status'],
  registers: [registry]
});

const approvals = new Gauge({
  name: 'agentos_approvals_total',
  help: 'Total approvals by status',
  labelNames: ['status'],
  registers: [registry]
});

export async function GET() {
  const runCounts = await db.workflowRun.groupBy({ by: ['status'], _count: true });
  const approvalCounts = await db.approval.groupBy({ by: ['status'], _count: true });

  workflowRuns.reset();
  approvals.reset();
  runCounts.forEach((row) => workflowRuns.set({ status: row.status }, row._count));
  approvalCounts.forEach((row) => approvals.set({ status: row.status }, row._count));

  return new NextResponse(await registry.metrics(), {
    headers: { 'content-type': registry.contentType }
  });
}
