import {
  ApprovalRisk,
  ApprovalStatus,
  RunStatus,
  type Agent,
  type Prisma,
  type Tenant,
  type Workflow,
  type WorkflowRun,
} from "@prisma/client";
import { approvalSlaDueAt, approvalSlaPolicy } from "@/lib/approval-sla";
import {
  adjudicationPrompt,
  buildCollaborationPlan,
  expertStagePrompt,
  parseAdjudicationResult,
  type ExpertContribution,
} from "@/lib/collaboration";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveTenantReference } from "@/lib/human-tenant";
import { executeGovernedModelCall } from "@/lib/model-execution";
import {
  type ProviderGenerationOptions,
  generateWithProvider,
} from "@/lib/providers";
import {
  enforceStructuredOutput,
  outputContractFromManifest,
} from "@/lib/structured-output";
import {
  WorkflowRunRequestSchema,
  type ProviderResponse,
  type WorkflowRunRequest,
  type WorkflowRunRequestInput,
} from "@/lib/types";

export interface WorkflowExecutionContext {
  tenantReference: string;
  actorId: string;
  requestId: string;
}

export type WorkflowModelGenerator = (
  options: ProviderGenerationOptions,
) => Promise<ProviderResponse>;

interface ApprovalPayload {
  agentId: string;
  taskId: string;
  agentIndex: number;
  sharedContext: string;
}

interface AdvanceWorkflowOptions {
  tenant: Tenant;
  workflow: Workflow;
  run: WorkflowRun;
  agents: Agent[];
  startIndex: number;
  sharedContext: string;
  outputs: Record<string, string>;
  actorId: string;
  requestId: string;
  generate: WorkflowModelGenerator;
  approvedTaskId?: string;
}

export async function ensureDefaultTenant(slug = "default") {
  return db.tenant.upsert({
    where: { slug },
    update: {},
    create: { slug, name: slug === "default" ? "Default Workspace" : slug },
  });
}

async function resolveWorkflowTenant(
  request: WorkflowRunRequest,
  executionContext?: WorkflowExecutionContext,
) {
  if (executionContext) {
    const tenant = await resolveTenantReference(
      executionContext.tenantReference,
    );
    if (!tenant) throw new Error("Trusted tenant not found");
    return tenant;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("Trusted tenant context is required");
  }
  return ensureDefaultTenant(request.tenantSlug);
}

function workflowAgentSlugs(graph: Prisma.JsonValue): string[] {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("Invalid workflow graph");
  }
  const agents = (graph as Record<string, unknown>).agents;
  if (
    !Array.isArray(agents) ||
    agents.length === 0 ||
    agents.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("Invalid workflow agent graph");
  }
  return agents as string[];
}

function approvalPayload(payload: Prisma.JsonValue): ApprovalPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid approval payload");
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.agentId !== "string" ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.agentIndex !== "number" ||
    !Number.isInteger(candidate.agentIndex) ||
    candidate.agentIndex < 0 ||
    typeof candidate.sharedContext !== "string"
  ) {
    throw new Error("Invalid approval payload");
  }
  return {
    agentId: candidate.agentId,
    taskId: candidate.taskId,
    agentIndex: candidate.agentIndex,
    sharedContext: candidate.sharedContext,
  };
}

function outputRecord(value: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function orderedAgents(tenantId: string, slugs: string[]) {
  const candidates = await db.agent.findMany({
    where: { tenantId, slug: { in: slugs } },
    orderBy: { updatedAt: "desc" },
  });
  const bySlug = new Map<string, Agent>();
  for (const agent of candidates) {
    if (!bySlug.has(agent.slug)) bySlug.set(agent.slug, agent);
  }
  const agents = slugs.map((slug) => bySlug.get(slug));
  const missing = slugs.filter((_, index) => !agents[index]);
  if (missing.length > 0) {
    throw new Error(`Missing agents: ${missing.join(", ")}`);
  }
  return agents as Agent[];
}

async function requestAgentApproval(options: {
  tenant: Tenant;
  workflow: Workflow;
  run: WorkflowRun;
  agent: Agent;
  taskId: string;
  agentIndex: number;
  sharedContext: string;
  actorId: string;
  requestId: string;
}) {
  const now = new Date();
  const risk = ApprovalRisk.HIGH;
  const slaPolicy = approvalSlaPolicy(risk);
  const expiresAt = new Date(now.getTime() + env.APPROVAL_TTL_MINUTES * 60_000);
  const slaDueAt = approvalSlaDueAt(risk, now);
  const approval = await db.$transaction(async (tx) => {
    const created = await tx.approval.create({
      data: {
        tenantId: options.tenant.id,
        runId: options.run.id,
        actionType: "agent_step",
        summary: `Approve ${options.agent.name} to contribute to workflow: ${options.workflow.goal}`,
        payload: {
          agentId: options.agent.id,
          taskId: options.taskId,
          agentIndex: options.agentIndex,
          sharedContext: options.sharedContext,
        },
        risk,
        expiresAt,
        slaDueAt,
        escalationOwner: slaPolicy.owner,
        requestedBy: options.actorId,
      },
    });

    await tx.agentTask.update({
      where: { id: options.taskId },
      data: { status: RunStatus.WAITING_FOR_APPROVAL },
    });
    await tx.workflowRun.update({
      where: { id: options.run.id },
      data: { status: RunStatus.WAITING_FOR_APPROVAL },
    });
    await tx.workflow.update({
      where: { id: options.workflow.id },
      data: { status: RunStatus.WAITING_FOR_APPROVAL },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenant.id,
        runId: options.run.id,
        actor: options.actorId,
        action: "approval.requested",
        metadata: {
          approvalId: created.id,
          taskId: options.taskId,
          agentId: options.agent.id,
          risk,
          expiresAt: expiresAt.toISOString(),
          slaDueAt: slaDueAt.toISOString(),
          escalationOwner: slaPolicy.owner,
          requestId: options.requestId,
        },
      },
    });
    return created;
  });

  return approval;
}

async function executeAgentTask(options: {
  tenant: Tenant;
  workflow: Workflow;
  run: WorkflowRun;
  taskId: string;
  agent: Agent;
  sharedContext: string;
  actorId: string;
  requestId: string;
  generate: WorkflowModelGenerator;
}) {
  await db.agentTask.update({
    where: { id: options.taskId },
    data: { status: RunStatus.RUNNING },
  });

  const outputContract = outputContractFromManifest(options.agent.manifest);
  const messages = [
    { role: "system" as const, content: options.agent.systemPrompt },
    { role: "user" as const, content: options.sharedContext },
  ];

  try {
    const execution = await executeGovernedModelCall({
      tenantId: options.tenant.id,
      actorId: options.actorId,
      requestId: options.requestId,
      runId: options.run.id,
      taskId: options.taskId,
      expertSlug: options.agent.slug,
      provider: options.agent.modelProvider,
      model: options.agent.modelName,
      messages,
      responseFormat: outputContract.mode,
      generate: options.generate,
    });
    enforceStructuredOutput(execution.response.text, outputContract);

    await db.agentTask.update({
      where: { id: options.taskId },
      data: { status: RunStatus.SUCCEEDED, output: execution.response },
    });
    await db.auditEvent.create({
      data: {
        tenantId: options.tenant.id,
        runId: options.run.id,
        actor: options.agent.slug,
        action: "agent.completed",
        metadata: {
          provider: execution.response.provider,
          model: execution.response.model,
          promptTokens: execution.response.promptTokens ?? null,
          completionTokens: execution.response.completionTokens ?? null,
          tokens: execution.response.tokens ?? null,
          usageEventId: execution.usageEventId,
          costMicrousd: execution.costMicrousd,
          budgetBreached: execution.budgetBreached,
          overReservation: execution.overReservation,
          outputContract: outputContract.mode,
          requestId: options.requestId,
          initiatedBy: options.actorId,
          taskId: options.taskId,
        },
      },
    });
    return execution.response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await db.$transaction([
      db.agentTask.update({
        where: { id: options.taskId },
        data: { status: RunStatus.FAILED, error: message },
      }),
      db.workflowRun.update({
        where: { id: options.run.id },
        data: {
          status: RunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      }),
      db.workflow.update({
        where: { id: options.workflow.id },
        data: { status: RunStatus.FAILED },
      }),
      db.auditEvent.create({
        data: {
          tenantId: options.tenant.id,
          runId: options.run.id,
          actor: options.agent.slug,
          action: "agent.failed",
          metadata: {
            requestId: options.requestId,
            initiatedBy: options.actorId,
            taskId: options.taskId,
            error: message,
          },
        },
      }),
    ]);
    throw error;
  }
}

async function executeCollaborativeWorkflow(options: {
  tenant: Tenant;
  workflow: Workflow;
  run: WorkflowRun;
  primaryAgents: Agent[];
  adjudicator?: Agent;
  request: WorkflowRunRequest;
  actorId: string;
  requestId: string;
  generate: WorkflowModelGenerator;
}) {
  const controlledAgents = [
    ...options.primaryAgents,
    ...(options.adjudicator ? [options.adjudicator] : []),
  ];
  const approvalBound = controlledAgents.filter(
    (agent) =>
      agent.approvalRequired && env.APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS,
  );
  if (approvalBound.length > 0) {
    throw new Error(
      `Collaborative execution cannot bypass approval-required agents: ${approvalBound
        .map((agent) => agent.slug)
        .join(", ")}`,
    );
  }

  if (options.primaryAgents.length > env.MAX_AGENT_STEPS) {
    throw new Error("Collaborative workflow exceeds MAX_AGENT_STEPS");
  }

  const stagePrompt = expertStagePrompt(options.request);
  const tasks = await Promise.all(
    options.primaryAgents.map((agent) =>
      db.agentTask.create({
        data: {
          tenantId: options.tenant.id,
          runId: options.run.id,
          agentId: agent.id,
          name: `${agent.name} independent expert step`,
          status: RunStatus.QUEUED,
          input: {
            collaborationMode: options.request.mode,
            strictness: options.request.strictness,
            sharedContext: stagePrompt,
          },
        },
      }),
    ),
  );

  const responses = await Promise.all(
    options.primaryAgents.map((agent, index) => {
      const task = tasks[index];
      if (!task) throw new Error("Collaborative task is missing");
      return executeAgentTask({
        tenant: options.tenant,
        workflow: options.workflow,
        run: options.run,
        taskId: task.id,
        agent,
        sharedContext: stagePrompt,
        actorId: options.actorId,
        requestId: options.requestId,
        generate: options.generate,
      });
    }),
  );

  const contributions: ExpertContribution[] = options.primaryAgents.map(
    (agent, index) => ({
      agent: agent.slug,
      text: responses[index]?.text ?? "",
    }),
  );
  const outputs = Object.fromEntries(
    contributions.map((contribution) => [
      contribution.agent,
      contribution.text,
    ]),
  );

  if (options.request.mode === "parallel") {
    const completed = await db.$transaction(async (tx) => {
      const completedRun = await tx.workflowRun.update({
        where: { id: options.run.id },
        data: {
          status: RunStatus.SUCCEEDED,
          output: outputs,
          finishedAt: new Date(),
        },
      });
      await tx.workflow.update({
        where: { id: options.workflow.id },
        data: { status: RunStatus.SUCCEEDED },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: options.tenant.id,
          runId: options.run.id,
          actor: options.actorId,
          action: "workflow.collaboration.completed",
          metadata: {
            requestId: options.requestId,
            mode: options.request.mode,
            primaryAgents: options.primaryAgents.map((agent) => agent.slug),
          },
        },
      });
      return completedRun;
    });
    return completed;
  }

  const adjudicator = options.adjudicator;
  if (!adjudicator) {
    throw new Error("Collaborative workflow adjudicator is missing");
  }

  const adjudicatorTask = await db.agentTask.create({
    data: {
      tenantId: options.tenant.id,
      runId: options.run.id,
      agentId: adjudicator.id,
      name: `${adjudicator.name} adjudication step`,
      status: RunStatus.QUEUED,
      input: {
        collaborationMode: options.request.mode,
        strictness: options.request.strictness,
        contributions,
      },
    },
  });
  const adjudicatorResponse = await executeAgentTask({
    tenant: options.tenant,
    workflow: options.workflow,
    run: options.run,
    taskId: adjudicatorTask.id,
    agent: adjudicator,
    sharedContext: adjudicationPrompt({
      request: options.request,
      contributions,
    }),
    actorId: options.actorId,
    requestId: options.requestId,
    generate: options.generate,
  });
  let adjudication;
  try {
    adjudication = parseAdjudicationResult(
      adjudicatorResponse.text,
      options.request.mode,
      options.request.strictness,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid adjudication result";
    await db.$transaction([
      db.workflowRun.update({
        where: { id: options.run.id },
        data: {
          status: RunStatus.FAILED,
          error: message,
          finishedAt: new Date(),
        },
      }),
      db.workflow.update({
        where: { id: options.workflow.id },
        data: { status: RunStatus.FAILED },
      }),
      db.auditEvent.create({
        data: {
          tenantId: options.tenant.id,
          runId: options.run.id,
          actor: options.actorId,
          action: "workflow.adjudication.rejected",
          metadata: {
            requestId: options.requestId,
            mode: options.request.mode,
            strictness: options.request.strictness,
            adjudicator: adjudicator.slug,
            error: message,
          },
        },
      }),
    ]);
    throw error;
  }

  const finalOutputs = {
    ...outputs,
    [adjudicator.slug]: adjudicatorResponse.text,
  };
  const completed = await db.$transaction(async (tx) => {
    const completedRun = await tx.workflowRun.update({
      where: { id: options.run.id },
      data: {
        status: RunStatus.SUCCEEDED,
        output: finalOutputs,
        finishedAt: new Date(),
      },
    });
    await tx.workflow.update({
      where: { id: options.workflow.id },
      data: { status: RunStatus.SUCCEEDED },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenant.id,
        runId: options.run.id,
        actor: options.actorId,
        action: "workflow.adjudication.completed",
        metadata: {
          requestId: options.requestId,
          mode: options.request.mode,
          strictness: options.request.strictness,
          adjudicator: adjudicator.slug,
          confidence: adjudication.confidence,
          conflicts: adjudication.conflicts.length,
          claims: adjudication.claims.length,
          sources: adjudication.sources.length,
          contradictionSearchPerformed:
            adjudication.contradictionSearchPerformed,
        },
      },
    });
    return completedRun;
  });

  return completed;
}

async function advanceWorkflow(options: AdvanceWorkflowOptions) {
  let sharedContext = options.sharedContext;
  const outputs = { ...options.outputs };

  await db.$transaction([
    db.workflow.update({
      where: { id: options.workflow.id },
      data: { status: RunStatus.RUNNING },
    }),
    db.workflowRun.update({
      where: { id: options.run.id },
      data: { status: RunStatus.RUNNING, error: null },
    }),
  ]);

  for (
    let index = options.startIndex;
    index < options.agents.length;
    index += 1
  ) {
    if (index >= env.MAX_AGENT_STEPS) break;
    const agent = options.agents[index];
    if (!agent) throw new Error("Workflow agent is missing");

    const isApprovedResume =
      index === options.startIndex && Boolean(options.approvedTaskId);
    const task = isApprovedResume
      ? await db.agentTask.findFirstOrThrow({
          where: {
            id: options.approvedTaskId,
            tenantId: options.tenant.id,
            runId: options.run.id,
            agentId: agent.id,
          },
        })
      : await db.agentTask.create({
          data: {
            tenantId: options.tenant.id,
            runId: options.run.id,
            agentId: agent.id,
            name: `${agent.name} step`,
            status: RunStatus.QUEUED,
            input: { sharedContext },
          },
        });

    if (
      !isApprovedResume &&
      agent.approvalRequired &&
      env.APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS
    ) {
      await requestAgentApproval({
        tenant: options.tenant,
        workflow: options.workflow,
        run: options.run,
        agent,
        taskId: task.id,
        agentIndex: index,
        sharedContext,
        actorId: options.actorId,
        requestId: options.requestId,
      });
      return db.workflowRun.findUniqueOrThrow({
        where: { id: options.run.id },
      });
    }

    const response = await executeAgentTask({
      tenant: options.tenant,
      workflow: options.workflow,
      run: options.run,
      taskId: task.id,
      agent,
      sharedContext,
      actorId: options.actorId,
      requestId: options.requestId,
      generate: options.generate,
    });

    outputs[agent.slug] = response.text;
    sharedContext += `\n\n${agent.name} output:\n${response.text}`;
    await db.workflowRun.update({
      where: { id: options.run.id },
      data: { output: outputs },
    });
  }

  const completed = await db.$transaction(async (tx) => {
    const completedRun = await tx.workflowRun.update({
      where: { id: options.run.id },
      data: {
        status: RunStatus.SUCCEEDED,
        output: outputs,
        finishedAt: new Date(),
      },
    });
    await tx.workflow.update({
      where: { id: options.workflow.id },
      data: { status: RunStatus.SUCCEEDED },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenant.id,
        runId: options.run.id,
        actor: options.actorId,
        action: "workflow.completed",
        metadata: { requestId: options.requestId },
      },
    });
    return completedRun;
  });

  return completed;
}

export async function runWorkflow(
  requestInput: WorkflowRunRequestInput,
  executionContext?: WorkflowExecutionContext,
  generate: WorkflowModelGenerator = generateWithProvider,
) {
  const request = WorkflowRunRequestSchema.parse(requestInput);
  const tenant = await resolveWorkflowTenant(request, executionContext);
  const plan = buildCollaborationPlan(request);
  const agentSlugs = [
    ...plan.primaryAgents,
    ...(plan.adjudicator ? [plan.adjudicator] : []),
  ];
  const agents = await orderedAgents(tenant.id, agentSlugs);
  const primaryAgents = agents.slice(0, plan.primaryAgents.length);
  const adjudicator = plan.adjudicator ? agents.at(-1) : undefined;

  if (plan.mode !== "sequential") {
    const controlledAgents = [
      ...primaryAgents,
      ...(adjudicator ? [adjudicator] : []),
    ];
    const approvalBound = controlledAgents.filter(
      (agent) =>
        agent.approvalRequired && env.APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS,
    );
    if (approvalBound.length > 0) {
      throw new Error(
        `Collaborative execution cannot bypass approval-required agents: ${approvalBound
          .map((agent) => agent.slug)
          .join(", ")}`,
      );
    }
    if (primaryAgents.length > env.MAX_AGENT_STEPS) {
      throw new Error("Collaborative workflow exceeds MAX_AGENT_STEPS");
    }
  }

  const workflow = await db.workflow.create({
    data: {
      tenantId: tenant.id,
      name: request.name,
      goal: request.goal,
      status: RunStatus.RUNNING,
      graph: {
        contractVersion: plan.contractVersion,
        agents: plan.primaryAgents,
        mode: plan.mode,
        strictness: plan.strictness,
        ...(plan.adjudicator ? { adjudicator: plan.adjudicator } : {}),
      },
    },
  });

  const run = await db.workflowRun.create({
    data: {
      tenantId: tenant.id,
      workflowId: workflow.id,
      status: RunStatus.RUNNING,
      startedAt: new Date(),
      input: request.input,
    },
  });

  const actorId = executionContext?.actorId ?? "local-development";
  const requestId = executionContext?.requestId ?? `local-${run.id}`;

  await db.auditEvent.create({
    data: {
      tenantId: tenant.id,
      runId: run.id,
      actor: actorId,
      action: "workflow.started",
      metadata: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        requestId,
      },
    },
  });

  if (plan.mode !== "sequential") {
    return executeCollaborativeWorkflow({
      tenant,
      workflow,
      run,
      primaryAgents,
      ...(adjudicator ? { adjudicator } : {}),
      request,
      actorId,
      requestId,
      generate,
    });
  }

  return advanceWorkflow({
    tenant,
    workflow,
    run,
    agents: primaryAgents,
    startIndex: 0,
    sharedContext: `Goal: ${request.goal}\nInput: ${JSON.stringify(request.input)}`,
    outputs: {},
    actorId,
    requestId,
    generate,
  });
}

export async function resumeApprovedWorkflow(
  approvalId: string,
  actorId: string,
  requestId: string,
  generate: WorkflowModelGenerator = generateWithProvider,
) {
  const approval = await db.approval.findUnique({
    where: { id: approvalId },
    include: { run: { include: { workflow: true } }, tenant: true },
  });
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== ApprovalStatus.APPROVED) {
    throw new Error("Approval is not approved");
  }
  if (approval.run.status !== RunStatus.WAITING_FOR_APPROVAL) {
    throw new Error("Workflow is not waiting for approval");
  }

  const payload = approvalPayload(approval.payload);
  const slugs = workflowAgentSlugs(approval.run.workflow.graph);
  const agents = await orderedAgents(approval.tenantId, slugs);
  const agent = agents[payload.agentIndex];
  if (!agent || agent.id !== payload.agentId) {
    throw new Error("Approval agent does not match workflow graph");
  }

  await db.auditEvent.create({
    data: {
      tenantId: approval.tenantId,
      runId: approval.runId,
      actor: actorId,
      action: "workflow.resumed",
      metadata: { approvalId, requestId, taskId: payload.taskId },
    },
  });

  return advanceWorkflow({
    tenant: approval.tenant,
    workflow: approval.run.workflow,
    run: approval.run,
    agents,
    startIndex: payload.agentIndex,
    sharedContext: payload.sharedContext,
    outputs: outputRecord(approval.run.output),
    actorId,
    requestId,
    generate,
    approvedTaskId: payload.taskId,
  });
}
