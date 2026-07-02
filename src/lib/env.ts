import { z } from 'zod';

const envSchema = z.object({
  APP_NAME: z.string().default('RaeburnAI AgentOS'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(16).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  DEFAULT_MODEL_PROVIDER: z.enum(['openai', 'openrouter', 'ollama']).default('ollama'),
  DEFAULT_MODEL: z.string().default('llama3.1'),
  APPROVAL_REQUIRED_FOR_EXTERNAL_ACTIONS: z.coerce.boolean().default(true),
  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(12),
  MAX_WORKFLOW_RUNTIME_SECONDS: z.coerce.number().int().positive().default(900),
  METRICS_ENABLED: z.coerce.boolean().default(true),
  LOG_LEVEL: z.string().default('info')
});

export const env = envSchema.parse(process.env);
