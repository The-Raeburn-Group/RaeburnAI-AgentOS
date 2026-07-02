import { z } from 'zod';

export const AgentManifestSchema = z.object({
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().default('0.1.0'),
  description: z.string().min(10),
  systemPrompt: z.string().min(10),
  modelProvider: z.enum(['openai', 'openrouter', 'ollama']).default('ollama'),
  modelName: z.string().default('llama3.1'),
  marketplaceTags: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  approvalRequired: z.boolean().default(true),
  memoryScope: z.enum(['agent', 'workflow', 'workspace', 'tenant']).default('workspace')
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const WorkflowRunRequestSchema = z.object({
  tenantSlug: z.string().default('default'),
  name: z.string().default('Untitled workflow'),
  goal: z.string().min(5),
  agents: z.array(z.string()).min(1),
  input: z.record(z.unknown()).default({})
});

export type WorkflowRunRequest = z.infer<typeof WorkflowRunRequestSchema>;

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ProviderResponse = {
  text: string;
  provider: string;
  model: string;
  tokens?: number;
};
