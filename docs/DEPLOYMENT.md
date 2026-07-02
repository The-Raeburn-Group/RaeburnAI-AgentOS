# Production Deployment

## Reference stack

- Next.js application container
- Managed PostgreSQL 16+
- Optional Ollama host for local LLMs
- Cloud LLM provider keys supplied through a secret manager
- Reverse proxy or platform edge with TLS, WAF and rate limiting
- Prometheus-compatible metrics collector

## Environment setup

1. Copy `.env.example` into your platform secret manager.
2. Replace all placeholder secrets.
3. Use a managed `DATABASE_URL` with backups enabled.
4. Set `APP_URL` and `NEXTAUTH_URL` to the public HTTPS domain.
5. Configure either `OPENAI_API_KEY`, `OPENROUTER_API_KEY` or `OLLAMA_BASE_URL`.

## Database

```bash
npm run db:generate
npm run db:migrate
npm run db:seed
```

For first local demos, `npm run db:push` is acceptable. Production should use migrations.

## Container deployment

```bash
docker build -t raeburnai-agentos .
docker run --env-file .env -p 3000:3000 raeburnai-agentos
```

## Health and monitoring

- Liveness/readiness: `/api/health`
- Prometheus metrics: `/api/metrics`
- Application logs: JSON via Pino

## Security hardening

- Keep MCP servers disabled by default.
- Require human approval for external writes.
- Restrict environment variables to the app runtime.
- Enable platform secret scanning.
- Enable GitHub branch protection.

## Known deployment TODOs

- Add Helm chart for Kubernetes.
- Add Terraform modules for common cloud providers.
- Add queue worker deployment once async runs are implemented.
