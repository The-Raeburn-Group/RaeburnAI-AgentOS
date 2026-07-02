# Screenshots

This project includes a UI dashboard. Production screenshots should be added before public launch.

## Required screenshots

1. Home dashboard showing installed agents, workflow metrics and platform positioning.
2. Agent marketplace with verified agent manifests.
3. Approval queue for risky actions.
4. Monitoring view with workflow runs, approvals and MCP status.

## Placeholder guidance

Until final screenshots are captured, use this file as the screenshot checklist. Do not add mock screenshots that imply unavailable functionality. Capture real screens from a seeded local or staging environment.

## Capture command

```bash
cp .env.example .env
npm install
npm run db:push
npm run db:seed
npm run dev
```

Then open `http://localhost:3000` and capture the dashboard.
