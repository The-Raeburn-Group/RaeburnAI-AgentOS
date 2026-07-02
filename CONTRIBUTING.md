# Contributing

Thank you for helping improve RaeburnAI AgentOS.

## Local development

```bash
cp .env.example .env
npm install
npm run db:push
npm run db:seed
npm run dev
```

## Quality bar

Before opening a pull request, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull requests

- Keep PRs focused.
- Add tests for new behaviour.
- Update docs when behaviour changes.
- Do not commit secrets, local databases or generated build output.

## Agent manifests

Agent contributions should include:

- Name, slug and version
- Clear description
- System prompt
- Tool requirements
- Approval policy
- Memory scope
- Example workflow use case

## Code of conduct

Be constructive, respectful and practical. This project is intended to be useful for businesses, consultants and open-source builders.
