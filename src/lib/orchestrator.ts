import { RunStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { generateWithProvider } from '@/lib/providers';
import type { WorkflowRunRequest } from '@/lib/types';

export async function ensureDefaultTenant(slug = 'default') {
  return db.tenant.upsert({
    where: { slug },
    update: {},
    create: { slug, name: slug === 'default' ? 'Default Workspace' : slug }
  });
}

export async function runWorkflow(request: WorkflowRunRequest) {
  const tenant = await ensureDefaultTenant(request.tenantSlug);
  const agents = await db.agent.findMany({
    where: { tenantId: tenant.id, slug: { in: request.agents } }
  });

  if (agents.length !== request.agents.length) {
    const found = new Set(agents.map((agent) => agent.slug));
    const missing = request.agents.filter((slug) => !found.has(slug));
    throw new Error(`Missing agents: ${missing.join(', ')}`);
  }

  const workflow = await db.workflow.create({
    data: {
      tenantId: tenant.id,
      name: request.name,
      goal: request.goal,
      status: RunStatus.RUNNING,
      graph: { agents: request.agents, mode: 'sequential' }
    }
  });

  const run = await db.workflowRun.create({
    data: {
      workflowId: workflow.id,
      status: RunStatus.RUNNING,
      startedAt: new Date(),
      input: request.input
    }
  });

  let sharedContext = `Goal: ${request.goal}\nInput: ${JSON.stringify(request.input)}`;
  const outputs: Record<string, string> = {};

  for (const [index, agent] of agents.entries()) {
    if (index >= env.MAX_AGENT_STEPS) break;

    const task = await db.agentTask.create({
      data: {
        runId: run.id,
        agentId: agent.id,
        name: `${agent.name} step`,
        status: RunStatus.RUNNING,
        input: { sharedContext }
      }
    });

    if (agent.approvalRequired && env.APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS) {
      await db.approval.create({
        data: {
          runId: run.id,
          actionType: 'agent_step',
          summary: `Approve ${agent.name} to contribute to workflow: ${request.goal}`,
          payload: { agentId: agent.id, taskId: task.id, sharedContext },
          requestedBy: 'system'
        }
      });
    }

    try {
      const response = await generateWithProvider({
        provider: agent.modelProvider,
        model: agent.modelName,
        messages: [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: sharedContext }
        ]
      });

      outputs[agent.slug] = response.text;
      sharedContext += `\n\n${agent.name} output:\n${response.text}`;

      await db.agentTask.update({
        where: { id: task.id },
        data: { status: RunStatus.SUCCEEDED, output: response }
      });
      await db.auditEvent.create({
        data: {
          runId: run.id,
          actor: agent.slug,
          action: 'agent.completed',
          metadata: { provider: response.provider, model: response.model, tokens: response.tokens ?? null }
        }
      });
    } catch (error) {
      await db.agentTask.update({
        where: { id: task.id },
        data: { status: RunStatus.FAILED, error: error instanceof Error ? error.message : 'Unknown error' }
      });
      await db.workflowRun.update({
        where: { id: run.id },
        data: { status: RunStatus.FAILED, error: error instanceof Error ? error.message : 'Unknown error', finishedAt: new Date() }
      });
      throw error;
    }
  }

  const completed = await db.workflowRun.update({
    where: { id: run.id },
    data: { status: RunStatus.SUCCEEDED, output: outputs, finishedAt: new Date() }
  });

  await db.workflow.update({ where: { id: workflow.id }, data: { status: RunStatus.SUCCEEDED } });

  return completed;
}
