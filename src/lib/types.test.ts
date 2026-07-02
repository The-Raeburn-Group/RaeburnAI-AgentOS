import { describe, expect, it } from 'vitest';
import { AgentManifestSchema, WorkflowRunRequestSchema } from '@/lib/types';

describe('AgentOS schemas', () => {
  it('validates an agent manifest', () => {
    const manifest = AgentManifestSchema.parse({
      name: 'Audit Agent',
      slug: 'audit-agent',
      description: 'Reviews business workflows for automation opportunities.',
      systemPrompt: 'You audit workflows and return clear recommendations.'
    });

    expect(manifest.modelProvider).toBe('ollama');
    expect(manifest.approvalRequired).toBe(true);
  });

  it('requires at least one workflow agent', () => {
    expect(() => WorkflowRunRequestSchema.parse({ goal: 'Improve operations', agents: [] })).toThrow();
  });
});
