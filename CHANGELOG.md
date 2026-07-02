# Changelog

All notable changes to RaeburnAI AgentOS will be documented in this file.

## 0.1.0 - 2026-07-02

### Added

- Production Next.js application scaffold.
- Multi-agent orchestration foundation.
- Agent marketplace API.
- Shared memory, MCP registry, approval and audit database models.
- Local/cloud model provider router.
- Dashboard UI.
- Health and Prometheus metrics endpoints.
- Dockerfile and Docker Compose stack.
- Seed agents for demos.
- CI, CodeQL and Dependabot configuration.
- Unit, integration-style schema tests and basic Playwright e2e test.
- Security, roadmap and contribution documentation.

### Changed

- Replaced `latest` dependency ranges with pinned versions.
- Added structured logging, input validation and rate limiting helpers.

### Known limitations

- A full generated `package-lock.json` still needs to be produced by running `npm install` in a networked development environment.
- Approval decision endpoints are documented as next work and are not yet a full dashboard workflow.
- MCP execution adapters are represented by registry schema and policy docs; concrete server invocation is planned for v0.2.
