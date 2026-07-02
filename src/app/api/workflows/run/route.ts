import { NextResponse } from 'next/server';
import { runWorkflow } from '@/lib/orchestrator';
import { WorkflowRunRequestSchema } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsed = WorkflowRunRequestSchema.parse(json);
    const run = await runWorkflow(parsed);
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown workflow error' },
      { status: 400 }
    );
  }
}
