import { z } from "zod";

export const AgentManifestSchema = z.object({
  schemaVersion: z
    .literal("raeburnai.agent-manifest.v1")
    .default("raeburnai.agent-manifest.v1"),
  name: z.string().min(2),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().default("0.1.0"),
  description: z.string().min(10),
  systemPrompt: z.string().min(10),
  modelProvider: z.enum(["openai", "openrouter", "ollama"]).default("ollama"),
  modelName: z.string().default("llama3.1"),
  marketplaceTags: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  domains: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  retrievalCollections: z.array(z.string().min(1)).default([]),
  evalSuites: z.array(z.string().min(1)).default([]),
  riskTier: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  evidencePolicy: z
    .object({
      requireSources: z.boolean().default(false),
      preferPrimarySources: z.boolean().default(true),
      contradictionSearch: z.boolean().default(false),
    })
    .default({}),
  approvalRequired: z.boolean().default(true),
  outputContract: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("text"),
      }),
      z.object({
        mode: z.literal("json"),
        required: z
          .array(z.string().trim().min(1).max(100))
          .max(100)
          .default([]),
        properties: z
          .record(
            z.enum(["string", "number", "boolean", "array", "object", "null"]),
          )
          .default({}),
        additionalProperties: z.boolean().default(false),
        maxBytes: z.number().int().min(2).max(1_000_000).default(100_000),
      }),
    ])
    .optional(),
  memoryScope: z
    .enum(["agent", "workflow", "workspace", "tenant"])
    .default("workspace"),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const WorkflowRunRequestSchema = z
  .object({
    tenantSlug: z.string().default("default"),
    name: z.string().default("Untitled workflow"),
    goal: z.string().min(5),
    agents: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
    mode: z
      .enum(["sequential", "parallel", "adjudicated", "evidence"])
      .default("sequential"),
    adjudicator: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    strictness: z.enum(["standard", "high", "regulated"]).default("standard"),
    input: z.record(JsonValueSchema).default({}),
  })
  .superRefine((value, context) => {
    if (
      (value.mode === "adjudicated" || value.mode === "evidence") &&
      !value.adjudicator
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjudicator"],
        message: `${value.mode} workflows require an adjudicator`,
      });
    }
    if (value.adjudicator && value.agents.includes(value.adjudicator)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjudicator"],
        message: "Adjudicator must not duplicate a primary expert",
      });
    }
  });

export type WorkflowRunRequestInput = z.input<typeof WorkflowRunRequestSchema>;
export type WorkflowRunRequest = z.output<typeof WorkflowRunRequestSchema>;

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
};

export type ProviderResponse = {
  text: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  tokens?: number;
  toolCalls?: ProviderToolCall[];
  structuredOutput?: JsonValue;
};
