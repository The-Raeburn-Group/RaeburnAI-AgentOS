import { db } from '@/lib/db';
import { ensureDefaultTenant } from '@/lib/orchestrator';

export default async function HomePage() {
  const tenant = await ensureDefaultTenant();
  const [agents, runs, approvals, mcpServers, memories] = await Promise.all([
    db.agent.findMany({ where: { tenantId: tenant.id }, orderBy: { updatedAt: 'desc' }, take: 6 }),
    db.workflowRun.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { workflow: true } }),
    db.approval.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
    db.mcpServer.count({ where: { tenantId: tenant.id } }),
    db.memory.count({ where: { tenantId: tenant.id } })
  ]);

  return (
    <main className="shell">
      <section className="hero">
        <div className="card">
          <div className="eyebrow">RaeburnAI AgentOS</div>
          <h1>The operating system for dependable AI agents.</h1>
          <p>
            Orchestrate specialist agents, route work across local and cloud LLMs, persist shared memory,
            expose MCP tools safely, and keep humans in control with approval checkpoints.
          </p>
          <a className="button" href="/api/health">Check platform health</a>
        </div>
        <div className="card">
          <h2>Production capabilities</h2>
          <span className="pill">Agent marketplace</span>
          <span className="pill">Shared memory</span>
          <span className="pill">MCP registry</span>
          <span className="pill">Local LLMs</span>
          <span className="pill">Cloud LLMs</span>
          <span className="pill">Human approvals</span>
          <span className="pill">Monitoring</span>
          <span className="pill">Audit trails</span>
        </div>
      </section>

      <section className="grid">
        <div className="metric"><strong>{agents.length}</strong><span>Installed agents</span></div>
        <div className="metric"><strong>{runs.length}</strong><span>Recent workflow runs</span></div>
        <div className="metric"><strong>{approvals.length}</strong><span>Approval requests</span></div>
        <div className="metric"><strong>{mcpServers}</strong><span>MCP servers</span></div>
        <div className="metric"><strong>{memories}</strong><span>Shared memories</span></div>
        <div className="metric"><strong>Apache-2.0</strong><span>Open-source licence</span></div>
      </section>

      <section className="section card">
        <h2>Agent marketplace</h2>
        <div className="agent-list">
          {agents.length === 0 ? <p>No agents installed yet. Seed defaults with <code>npm run db:seed</code> or POST manifests to <code>/api/marketplace</code>.</p> : null}
          {agents.map((agent) => (
            <div className="agent" key={agent.id}>
              <div>
                <strong>{agent.name}</strong>
                <p>{agent.description}</p>
              </div>
              <span>{agent.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section card">
        <h2>Recent workflow runs</h2>
        <div className="agent-list">
          {runs.length === 0 ? <p>No workflow runs yet. POST to <code>/api/workflows/run</code> to start one.</p> : null}
          {runs.map((run) => (
            <div className="agent" key={run.id}>
              <div>
                <strong>{run.workflow.name}</strong>
                <p>{run.workflow.goal}</p>
              </div>
              <span>{run.status}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
