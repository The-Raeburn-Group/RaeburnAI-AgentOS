# RaeburnAI AgentOS

**RaeburnAI AgentOS** is an open-source, production-ready multi-agent orchestration platform for teams that want to run dependable AI workflows across local and cloud models.

It provides:

- Agent marketplace and verified agent manifests
- Shared long-term memory with tenancy boundaries
- MCP-ready tool/server registry
- Local LLM and cloud LLM routing
- Human approval workflows for sensitive actions
- Monitoring dashboard, metrics endpoint and audit trails
- Secure-by-default deployment structure
- Apache-2.0 open-source licence

## Architecture

```txt
Next.js App Router UI/API
  ├─ Agent Marketplace
  ├─ Orchestration Engine
  ├─ Shared Memory Layer
  ├─ MCP Tool Registry
  ├─ Human Approval Queue
  ├─ Provider Router: OpenAI / OpenRouter / Ollama
  ├─ Monitoring + Prometheus Metrics
  └─ Prisma/PostgreSQL Persistence
```

## Quick start

```bash
cp .env.example .env
npm install
npm run db:push
npm run dev
```

Open `http://localhost:3000`.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

## Production checklist

1. Set strong `NEXTAUTH_SECRET` and `ENCRYPTION_KEY` values.
2. Use managed PostgreSQL with backups enabled.
3. Set `APP_URL` to your production domain.
4. Configure at least one model provider key or Ollama endpoint.
5. Put the app behind TLS and a WAF/rate limiter.
6. Review `docs/SECURITY.md` before adding external MCP servers.
7. Enable GitHub Actions branch protection.

## Core concepts

### Agents

Agents are versioned, installable manifests that declare role, tools, approval policy, memory scope and model preference.

### Workflows

A workflow is a DAG-style orchestration run where multiple agents collaborate through typed tasks, shared memory and approval checkpoints.

### Shared memory

Memory is scoped by tenant, workspace, workflow and agent. Sensitive memory can be marked approval-gated or retention-limited.

### MCP support

AgentOS includes an MCP registry abstraction so MCP servers can be registered, permissioned and exposed safely to agents.

### Human approval

Actions such as sending emails, writing files, triggering deployments, charging customers or calling external APIs can be paused until a human approves them.

## Repository layout

```txt
src/app                 Next.js UI and API routes
src/components          Reusable dashboard components
src/lib                 Core orchestration, providers, memory and monitoring
prisma/schema.prisma    Database model
docs                    Production, security and contribution docs
```

## API examples

Create a workflow run:

```bash
curl -X POST http://localhost:3000/api/workflows/run \
  -H 'content-type: application/json' \
  -d '{"goal":"Audit onboarding workflow","agents":["workflow-auditor","implementation-planner"]}'
```

Check health:

```bash
curl http://localhost:3000/api/health
```

Prometheus metrics:

```bash
curl http://localhost:3000/api/metrics
```

## Open source

RaeburnAI AgentOS is released under the Apache-2.0 licence so businesses, consultants and the wider community can build on it confidently while preserving patent protections and attribution.
