# Security Policy

## Supported versions

RaeburnAI AgentOS is pre-1.0. Security fixes are applied to the main branch until tagged releases begin.

## Reporting a vulnerability

Please do not open public issues for security vulnerabilities. Report privately to the maintainers with:

- Affected component
- Reproduction steps
- Potential impact
- Suggested fix, if known

## Security model

AgentOS is designed around least privilege, approval gates and auditability:

- Human approval is required for risky write actions.
- MCP servers should be disabled until reviewed.
- Secrets must be supplied through environment variables or a secret manager.
- Tenant-scoped memory is required for multi-workspace operation.
- Audit events should be retained for sensitive workflow execution.

## Production recommendations

- Enable GitHub branch protection and required CI checks.
- Enable CodeQL, Dependabot and secret scanning.
- Deploy behind TLS, WAF/rate limiting and monitored infrastructure.
- Use managed PostgreSQL with backups and point-in-time recovery.
