# Production TODOs

This project has been hardened into a credible production foundation, but it should not be described as a complete v1 enterprise platform until the following items are finished and verified.

## Verified foundations already completed

- Deterministic `package-lock.json` and `npm ci` workflow.
- Zero-vulnerability npm audit evidence on the hardened dependency graph.
- Versioned Prisma migration deployed against a fresh PostgreSQL database in CI.
- Repository Health, CodeQL, lint, typecheck, unit tests, production Next.js build and Docker build verified on the hardened mainline candidate.
- Fail-closed RaeburnAI-Chain service-token authentication for workflow execution.

## Must complete before enterprise production launch

- Verify the OIDC human-admin/RBAC branch against the selected real identity provider, including provider-specific tenant/role claim mapping, session expiry and revocation behaviour.
- Run adversarial two-tenant authorization tests across dashboard/API/database access; OIDC tenant claims must never fall back to the default tenant.
- Build approval decision endpoints and dashboard actions for approving/rejecting pending risky actions, integrated with the canonical Chain approval IDs.
- Implement concrete MCP server invocation with per-server least-privilege policies.
- Add durable background worker/queue support for long-running workflows.
- Replace in-memory rate limiting with Redis or platform edge rate limiting for multi-instance deployments.
- Re-run the complete CI/CodeQL/build/Docker matrix for each release candidate; do not waive gates when hosted runners are unavailable.
- Add real dashboard screenshots from a seeded staging environment.

## Commercial credibility improvements

- Add architecture decision records.
- Add example agent marketplace manifests.
- Add demo video or walkthrough.
- Add deployment examples for Vercel, Render, Fly.io and Kubernetes.
- Add cost tracking and provider usage reports.
