# Security guide

RaeburnAI AgentOS is designed for production use, but every deployment must be configured carefully.

## Secrets

- Never commit `.env` files.
- Rotate `NEXTAUTH_SECRET`, provider API keys and database credentials before production launch.
- Store secrets in Vercel, Doppler, 1Password, AWS Secrets Manager, GCP Secret Manager or equivalent.

## Human approval boundaries

Keep approval required for:

- External API writes
- Email sending
- Payment actions
- File writes/deletes
- Deployment actions
- CRM/customer updates
- Legal, financial or HR recommendations

## MCP server safety

Before enabling any MCP server:

1. Document its capabilities.
2. Apply least-privilege credentials.
3. Restrict tools by workspace and agent.
4. Require human approval for write actions.
5. Log every call into the audit trail.
6. Disable unknown community servers until reviewed.

## Multi-tenant memory

- Memory must always be scoped by tenant.
- Avoid storing raw secrets, passwords or unnecessary personal data.
- Use retention windows for sensitive workflows.
- Add redaction before memory writes where appropriate.

## Production controls

- Use TLS everywhere.
- Put the app behind a WAF or platform rate limiter.
- Enable database backups and point-in-time recovery.
- Monitor `/api/health` and `/api/metrics`.
- Turn on GitHub branch protection and required CI checks.

## Responsible disclosure

Please report security issues privately to the maintainers before public disclosure.
