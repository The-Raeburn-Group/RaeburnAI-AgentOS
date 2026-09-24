import { RunStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { runWorkflow, type WorkflowModelGenerator } from "@/lib/orchestrator";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "governed-workflow-tenant";
const agentId = "governed-workflow-agent";

async function clean() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

async function seed() {
  await clean();
  await db.tenant.create({
    data: { id: tenantId, slug: tenantId, name: "Governed workflow tenant" },
  });
  await db.agent.create({
    data: {
      id: agentId,
      tenantId,
      name: "Structured expert",
      slug: "structured-expert",
      description: "Structured workflow integration test expert.",
      systemPrompt: "Return a bounded JSON object.",
      modelProvider: "ollama",
      modelName: "test-model",
      approvalRequired: false,
      manifest: {
        schemaVersion: "raeburnai.agent-manifest.v1",
        outputContract: {
          mode: "json",
          required: ["decision", "confidence"],
          properties: {
            decision: "string",
            confidence: "number",
          },
          additionalProperties: false,
          maxBytes: 1000,
        },
      },
    },
  });
}

function generator(text: string): WorkflowModelGenerator {
  return vi.fn(async ({ responseFormat }) => {
    expect(responseFormat).toBe("json");
    return {
      text,
      provider: "ollama",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      tokens: 15,
    };
  });
}

describeWithDatabase("governed workflow request lifecycle", () => {
  beforeEach(seed);
  afterAll(clean);

  it("runs request -> model -> structured validation -> usage ledger -> audit -> persisted output", async () => {
    const generate = generator('{"decision":"continue","confidence":0.91}');
    const run = await runWorkflow(
      {
        tenantSlug: "ignored",
        name: "Governed lifecycle",
        goal: "Produce a structured governed answer",
        agents: ["structured-expert"],
        input: { caseId: "life-1" },
      },
      {
        tenantReference: tenantId,
        actorId: "requester",
        requestId: "governed-lifecycle-1",
      },
      generate,
    );

    expect(run.status).toBe(RunStatus.SUCCEEDED);
    expect(run.output).toMatchObject({
      "structured-expert": '{"decision":"continue","confidence":0.91}',
    });

    const [task, usage, completed] = await Promise.all([
      db.agentTask.findFirstOrThrow({
        where: { tenantId, runId: run.id },
      }),
      db.usageEvent.findFirstOrThrow({
        where: { tenantId, runId: run.id, expertSlug: "structured-expert" },
      }),
      db.auditEvent.findFirstOrThrow({
        where: { tenantId, runId: run.id, action: "agent.completed" },
      }),
    ]);
    expect(task.status).toBe(RunStatus.SUCCEEDED);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.costMicrousd).toBe(0n);
    expect(completed.metadata).toMatchObject({
      usageEventId: usage.id,
      outputContract: "json",
    });
  });

  it("keeps the provider usage event when structured validation fails after a billed call", async () => {
    const generate = generator('{"decision":"missing confidence"}');

    await expect(
      runWorkflow(
        {
          tenantSlug: "ignored",
          name: "Governed lifecycle failure",
          goal: "Reject malformed structured model output",
          agents: ["structured-expert"],
        },
        {
          tenantReference: tenantId,
          actorId: "requester",
          requestId: "governed-lifecycle-2",
        },
        generate,
      ),
    ).rejects.toThrow("required_property_missing");

    const run = await db.workflowRun.findFirstOrThrow({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    const task = await db.agentTask.findFirstOrThrow({
      where: { tenantId, runId: run.id },
    });
    expect(run.status).toBe(RunStatus.FAILED);
    expect(task.status).toBe(RunStatus.FAILED);
    expect(
      await db.usageEvent.count({
        where: { tenantId, runId: run.id, expertSlug: "structured-expert" },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { tenantId, runId: run.id, action: "agent.failed" },
      }),
    ).toBe(1);
  });
});
