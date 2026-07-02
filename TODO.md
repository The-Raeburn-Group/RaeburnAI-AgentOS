# Production TODOs

This project has been hardened into a credible production foundation, but it should not be described as a complete v1 enterprise platform until the following items are finished and verified.

## Must complete before enterprise production launch

- Generate and commit `package-lock.json` from a networked development environment using `npm install`.
- Run and confirm `npm install`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and `docker build -t raeburnai-agentos .`.
- Add authenticated admin access and RBAC before exposing non-read-only dashboard functionality.
- Build approval decision endpoints and dashboard actions for approving/rejecting pending risky actions.
- Implement concrete MCP server invocation with per-server least-privilege policies.
- Add durable background worker/queue support for long-running workflows.
- Replace in-memory rate limiting with Redis or platform edge rate limiting for multi-instance deployments.
- Add database migrations instead of relying on `prisma db push` for production.
- Add integration tests that use an isolated test database in CI.
- Add real dashboard screenshots from a seeded staging environment.

## Commercial credibility improvements

- Add architecture decision records.
- Add example agent marketplace manifests.
- Add demo video or walkthrough.
- Add deployment examples for Vercel, Render, Fly.io and Kubernetes.
- Add cost tracking and provider usage reports.
