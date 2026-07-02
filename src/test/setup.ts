process.env.DATABASE_URL ??= 'postgresql://agentos:agentos@localhost:5432/agentos?schema=public';
process.env.APP_URL ??= 'http://localhost:3000';
process.env.NEXTAUTH_SECRET ??= 'test-secret-for-local-tests';
process.env.OLLAMA_BASE_URL ??= 'http://localhost:11434';
process.env.DEFAULT_MODEL_PROVIDER ??= 'ollama';
process.env.DEFAULT_MODEL ??= 'llama3.1';
