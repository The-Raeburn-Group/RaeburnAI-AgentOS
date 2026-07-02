# RaeburnAI AgentOS

![Status](https://img.shields.io/badge/status-production--foundation-blue) ![Licence](https://img.shields.io/badge/licence-Apache--2.0-green) ![Platform](https://img.shields.io/badge/RaeburnAI-Platform-purple)

## 1. Project name

RaeburnAI AgentOS

## 2. One-line positioning statement

A production-grade multi-agent orchestration layer for dependable enterprise AI workflows.

## 3. Short product description

RaeburnAI AgentOS helps teams design, run and govern AI agents across local and cloud LLMs. It combines agent marketplace manifests, shared memory, MCP registry support, human approval workflows, observability and audit trails into one open-source platform module.

## 4. Part of the RaeburnAI Platform

RaeburnAI AgentOS is part of the wider **RaeburnAI Platform**: a modular enterprise AI ecosystem for building, governing, operating and scaling practical AI systems across business workflows.

Every RaeburnAI project follows the same product standards:

- Production-first architecture
- Open-source credibility
- Security and governance by default
- Clear deployment path
- Shared documentation structure
- Enterprise-grade extensibility

### RaeburnAI ecosystem map

```txt
RaeburnAI Platform
├─ RaeburnAI AgentOS                 Multi-agent orchestration and governance
├─ RaeburnAI Compliance Engine       AI governance, GDPR, ISO and EU AI Act checks
├─ Universal AI Knowledge Graph      AI-searchable enterprise knowledge layer
├─ RaeburnAI Executive               CEO second brain and executive briefing system
├─ OpenAI Operations Dashboard       AI usage, spend, latency, safety and audit monitoring
├─ RaeburnAI Proposal Generator      Consulting proposal, roadmap and ROI generator
├─ RaeburnAI Enterprise MCP Server   Enterprise tool connector layer
├─ RaeburnAI Meeting Intelligence    Decisions, actions and follow-up automation
└─ RaeburnAI Workflow Auditor        AI adoption audit and workflow opportunity engine
```

### Core project links

- [RaeburnAI Compliance Engine](https://github.com/The-Raeburn-Group/RaeburnAI-Compliance-Engine)
- [Universal AI Knowledge Graph](https://github.com/The-Raeburn-Group/Universal-AI-Knowledge-Graph)
- [RaeburnAI Executive](https://github.com/The-Raeburn-Group/RaeburnAI-Executive)
- [OpenAI Operations Dashboard](https://github.com/The-Raeburn-Group/OpenAI-Operations-Dashboard)
- [RaeburnAI Proposal Generator](https://github.com/The-Raeburn-Group/RaeburnAI-Proposal-Generator)
- [RaeburnAI Enterprise MCP Server](https://github.com/The-Raeburn-Group/RaeburnAI-Enterprise-MCP-Server)
- [RaeburnAI Meeting Intelligence](https://github.com/The-Raeburn-Group/RaeburnAI-Meeting-Intelligence)
- [RaeburnAI Workflow Auditor](https://github.com/The-Raeburn-Group/RaeburnAI-Workflow-Auditor)

## 5. Core features

- Agent marketplace with versioned manifests
- Shared memory model with tenant boundaries
- MCP server registry and policy layer
- Local LLM support through Ollama-compatible endpoints
- Cloud LLM support through OpenAI and OpenRouter-compatible APIs
- Human approval records for risky actions
- Audit events for workflow execution
- Dashboard for agents, workflow runs and approvals
- Health and Prometheus metrics endpoints
- Docker, CI, CodeQL and Dependabot configuration

## 6. Architecture

```txt
Next.js App Router UI/API
  ├─ Dashboard UI
  ├─ Agent Marketplace API
  ├─ Workflow Run API
  ├─ Orchestration Engine
  ├─ Provider Router
  ├─ Shared Memory Schema
  ├─ MCP Registry Schema
  ├─ Approval Queue Schema
  ├─ Audit Event Schema
  ├─ Health and Metrics Endpoints
  └─ Prisma/PostgreSQL Persistence
```

## 7. Quick start

```bash
cp .env.example .env
npm install
npm run db:push
npm run db:seed
npm run dev
```

Open `http://localhost:3000`.

Docker:

```bash
cp .env.example .env
docker compose up --build
```

## 8. Environment variables

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public application URL |
| `NEXTAUTH_URL` | Auth callback base URL |
| `NEXTAUTH_SECRET` | Auth/session secret |
| `ENCRYPTION_KEY` | Application encryption key placeholder |
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENAI_API_KEY` | Optional OpenAI cloud model key |
| `OPENROUTER_API_KEY` | Optional OpenRouter cloud model key |
| `OLLAMA_BASE_URL` | Optional local model endpoint |
| `DEFAULT_MODEL_PROVIDER` | `ollama`, `openai` or `openrouter` |
| `DEFAULT_MODEL` | Default model name |
| `APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS` | Safety gate for risky actions |
| `MAX_AGENT_STEPS` | Workflow step limit |
| `LOG_LEVEL` | Structured logging level |
| `METRICS_ENABLED` | Metrics endpoint toggle placeholder |

## 9. Usage examples

Create a workflow run:

```bash
curl -X POST http://localhost:3000/api/workflows/run \
  -H 'content-type: application/json' \
  -d '{"goal":"Audit onboarding workflow","agents":["workflow-auditor","implementation-planner"]}'
```

Register an agent manifest:

```bash
curl -X POST http://localhost:3000/api/marketplace \
  -H 'content-type: application/json' \
  -d '{"name":"Risk Analyst","slug":"risk-analyst","description":"Reviews workflow risk and controls.","systemPrompt":"You are a risk analyst. Return risks, controls and approvals."}'
```

Health and metrics:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/metrics
```

## 10. Security model

- Secrets are supplied through environment variables and `.env` is ignored.
- API payloads are validated with Zod.
- Workflow execution API has basic in-memory rate limiting.
- Risky agent actions create approval records.
- Workflow execution writes audit events.
- MCP servers are disabled by default until explicitly enabled.
- CodeQL and Dependabot are configured for continuous security review.

## 11. Production readiness

Current status: **production foundation, not yet a fully mature v1 enterprise release**.

Included:

- Pinned dependency versions
- CI pipeline
- CodeQL workflow
- Dependabot configuration
- Dockerfile and Docker Compose
- Health and metrics endpoints
- Unit tests and a basic Playwright e2e smoke test
- Production deployment documentation
- Security policy and hardening notes

Known TODOs are tracked in `TODO.md`, `ROADMAP.md` and `docs/DEPLOYMENT.md`.

## 12. Roadmap

- Approval inbox and decision API
- Auth/RBAC implementation
- Concrete MCP invocation adapter
- Queue-backed workflow execution
- Memory redaction pipeline
- Marketplace manifest signing
- Helm and Terraform deployment assets

## 13. Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions should preserve the RaeburnAI platform structure, include tests, avoid secrets and document any new production assumptions.

## 14. Licence

Apache-2.0. See [LICENSE](LICENSE).
