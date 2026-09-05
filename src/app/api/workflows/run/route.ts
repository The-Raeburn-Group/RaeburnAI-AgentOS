import { NextResponse } from 'next/server';
import { apiError, rateLimit } from '@/lib/http';
import { runWorkflow } from '@/lib/orchestrator';
import { requireChainServiceToken } from '@/lib/service-auth';
import { WorkflowRunRequestSchema } from '@/lib/types';

export async function POST(request: Request) {
  const unauthorized = requireChainServiceToken(request);
  if (unauthorized) return unauthorized;

  const limited = rateLimit(request, 20, 60000);
  if (limited) return limited;

  try {
    const body = await request.json();
    const payload = WorkflowRunRequestSchema.parse(body);
    const run = await runWorkflow(payload);
    return NextResponse.json({ run });
  } catch (error) {
    return apiError(error, 'workflow.run');
  }
}
