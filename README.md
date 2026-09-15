# RaeburnAI AgentOS

> Maintained by **Raeburn Technologies**, part of **The Raeburn Group**.
>
> Group: https://theraeburngroup.com · Technology: https://technology.theraeburngroup.com · Trust: https://trust.theraeburngroup.com

## Overview

RaeburnAI AgentOS is an open-source multi-agent orchestration project for controlled enterprise AI workflows. It provides shared workflow structures, agent manifests, memory models, Model Context Protocol integration points, approval records, audit events and deployment tooling.

The project is part of the RaeburnAI technology initiative within the wider Raeburn Technologies portfolio.

## Current maturity

**Status: foundation / active development.**

The repository includes a deployable application foundation, CI, tests, Docker assets, health and metrics endpoints, and documented security controls. It should not be interpreted as a fully mature enterprise v1 release. Production adoption requires environment-specific review, authentication and authorisation configuration, secret management, infrastructure controls and operational monitoring.

## Core capabilities

- Multi-agent orchestration
- Agent marketplace manifests
- Shared memory model with tenant boundaries
- MCP server registry support
- Local and cloud model-provider integration
- Human approval records for higher-risk actions
- Audit events for workflow execution
- Health and Prometheus-compatible metrics endpoints
- Docker and Docker Compose deployment assets
- CI, CodeQL and Dependabot configuration

## Architecture

```text
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

## Quick start

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

## Configuration

Key environment variables include:

| Variable                                 | Purpose                               |
| ---------------------------------------- | ------------------------------------- |
| `APP_URL`                                | Public application URL                |
| `NEXTAUTH_URL`                           | Authentication callback base URL      |
| `NEXTAUTH_SECRET`                        | Authentication/session secret         |
| `ENCRYPTION_KEY`                         | Application encryption key placeholder |
| `DATABASE_URL`                           | PostgreSQL connection string           |
| `OPENAI_API_KEY`                         | Optional OpenAI model key               |
| `OPENROUTER_API_KEY`                     | Optional OpenRouter model key           |
| `OLLAMA_BASE_URL`                        | Optional local model endpoint           |
| `DEFAULT_MODEL_PROVIDER`                 | Default model provider                  |
| `DEFAULT_MODEL`                          | Default model name                      |
| `APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS` | Approval control for external actions   |
| `MAX_AGENT_STEPS`                        | Workflow step limit                     |
| `LOG_LEVEL`                              | Logging level                           |
| `METRICS_ENABLED`                        | Metrics endpoint control                |

See `.env.example` for the complete current configuration.

## Security model

Current controls include environment-based secret handling, validated API payloads, workflow rate limiting, approval records for higher-risk actions, audit events and disabled-by-default MCP servers.

Before production deployment, review the repository's `SECURITY.md`, deployment documentation and environment-specific access controls. Repository controls do not constitute independent security certification or assurance.

## Related published projects

- [RaeburnAI Enterprise MCP Server](https://github.com/The-Raeburn-Group/RaeburnAI-Enterprise-MCP-Server)
- [Universal AI Knowledge Graph](https://github.com/The-Raeburn-Group/Universal-AI-Knowledge-Graph)
- [RaeburnAI Business Twin](https://github.com/The-Raeburn-Group/RaeburnAI-Business-Twin)
- [RaeburnAI Workflow Auditor](https://github.com/The-Raeburn-Group/RaeburnAI-Workflow-Auditor)

Only currently published repositories are listed here.

## Development

Before opening a pull request, run the repository's documented lint, typecheck, test and build commands. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Licence

Apache-2.0. See [LICENSE](LICENSE).

---

**Raeburn Technologies · The Raeburn Group**
