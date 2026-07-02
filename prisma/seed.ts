import { PrismaClient, AgentStatus } from '@prisma/client';

const prisma = new PrismaClient();

const agents = [
  {
    name: 'Workflow Auditor',
    slug: 'workflow-auditor',
    description: 'Audits workflows, identifies automation opportunities and flags risk.',
    systemPrompt: 'You are a senior AI workflow auditor. Analyse the supplied goal and context. Return automation opportunities, risk notes, required data, estimated impact and recommended next actions.',
    marketplaceTags: ['audit', 'automation', 'operations'],
    requiredTools: ['memory.search', 'documents.read']
  },
  {
    name: 'Implementation Planner',
    slug: 'implementation-planner',
    description: 'Turns agent findings into practical delivery roadmaps with approvals.',
    systemPrompt: 'You are a pragmatic implementation planner. Convert findings into phases, owners, dependencies, acceptance criteria and controls. Always include a human approval stage for risky external changes.',
    marketplaceTags: ['delivery', 'roadmap', 'governance'],
    requiredTools: ['approvals.request']
  },
  {
    name: 'MCP Tool Analyst',
    slug: 'mcp-tool-analyst',
    description: 'Evaluates MCP servers, permissions and safe tool boundaries.',
    systemPrompt: 'You are an MCP security and integration analyst. Review tool capability requests, least-privilege permissions, data risks and safe rollout steps.',
    marketplaceTags: ['mcp', 'security', 'tools'],
    requiredTools: ['mcp.registry']
  }
];

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Workspace' }
  });

  for (const agent of agents) {
    await prisma.agent.upsert({
      where: { tenantId_slug_version: { tenantId: tenant.id, slug: agent.slug, version: '0.1.0' } },
      update: {},
      create: {
        tenantId: tenant.id,
        version: '0.1.0',
        status: AgentStatus.VERIFIED,
        modelProvider: process.env.DEFAULT_MODEL_PROVIDER ?? 'ollama',
        modelName: process.env.DEFAULT_MODEL ?? 'llama3.1',
        approvalRequired: true,
        memoryScope: 'workspace',
        manifest: agent,
        ...agent
      }
    });
  }
}

main().finally(async () => prisma.$disconnect());
