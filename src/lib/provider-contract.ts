import type { JsonValue } from "@/lib/types";

export const PROVIDER_EXECUTION_CONTRACT_VERSION =
  "raeburnai.provider-execution.v1" as const;

export type StructuredOutputSchema =
  | {
      type: "object";
      properties: Record<string, StructuredOutputSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | {
      type: "array";
      items: StructuredOutputSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "string";
      enum?: string[];
      minLength?: number;
      maxLength?: number;
    }
  | {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean" }
  | { type: "null" };

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: StructuredOutputSchema;
}

export interface ProviderToolCall {
  id?: string;
  name: string;
  arguments: JsonValue;
}

export type ProviderExecutionErrorCode =
  | "unsupported_provider"
  | "provider_not_configured"
  | "invalid_output_schema"
  | "invalid_structured_output"
  | "invalid_tool_definition"
  | "unexpected_tool_call"
  | "invalid_tool_arguments"
  | "provider_timeout"
  | "provider_cancelled"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "provider_malformed_response"
  | "provider_response_too_large"
  | "unsupported_streaming_combination";

export class ProviderExecutionError extends Error {
  constructor(
    public readonly code: ProviderExecutionErrorCode,
    public readonly details: {
      provider?: string;
      status?: number;
      retryAfterMs?: number;
    } = {},
  ) {
    super(code);
    this.name = "ProviderExecutionError";
  }
}

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 200;
const MAX_ENUM_VALUES = 200;
const MAX_TOOL_DEFINITIONS = 32;
const toolNamePattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertFiniteBound(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderExecutionError("invalid_output_schema");
  }
  if (
    (name === "minItems" ||
      name === "maxItems" ||
      name === "minLength" ||
      name === "maxLength") &&
    (!Number.isInteger(value) || value < 0)
  ) {
    throw new ProviderExecutionError("invalid_output_schema");
  }
  return value;
}

export function validateStructuredOutputSchema(
  schema: unknown,
  depth = 0,
): StructuredOutputSchema {
  if (depth > MAX_SCHEMA_DEPTH || !isRecord(schema)) {
    throw new ProviderExecutionError("invalid_output_schema");
  }
  const type = schema.type;
  if (typeof type !== "string") {
    throw new ProviderExecutionError("invalid_output_schema");
  }

  if (type === "object") {
    if (!isRecord(schema.properties)) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    const entries = Object.entries(schema.properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    const properties = Object.fromEntries(
      entries.map(([key, value]) => {
        if (!key || key.length > 128) {
          throw new ProviderExecutionError("invalid_output_schema");
        }
        return [key, validateStructuredOutputSchema(value, depth + 1)];
      }),
    );
    const required =
      schema.required === undefined
        ? undefined
        : Array.isArray(schema.required) &&
            schema.required.every(
              (value) => typeof value === "string" && value in properties,
            )
          ? [...new Set(schema.required as string[])]
          : (() => {
              throw new ProviderExecutionError("invalid_output_schema");
            })();
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    ) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    return {
      type,
      properties,
      ...(required ? { required } : {}),
      ...(schema.additionalProperties !== undefined
        ? { additionalProperties: schema.additionalProperties }
        : {}),
    };
  }

  if (type === "array") {
    const items = validateStructuredOutputSchema(schema.items, depth + 1);
    const minItems = assertFiniteBound(schema.minItems, "minItems");
    const maxItems = assertFiniteBound(schema.maxItems, "maxItems");
    if (
      minItems !== undefined &&
      maxItems !== undefined &&
      minItems > maxItems
    ) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    return {
      type,
      items,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    };
  }

  if (type === "string") {
    const enumValues =
      schema.enum === undefined
        ? undefined
        : Array.isArray(schema.enum) &&
            schema.enum.length <= MAX_ENUM_VALUES &&
            schema.enum.every((value) => typeof value === "string")
          ? [...new Set(schema.enum as string[])]
          : (() => {
              throw new ProviderExecutionError("invalid_output_schema");
            })();
    const minLength = assertFiniteBound(schema.minLength, "minLength");
    const maxLength = assertFiniteBound(schema.maxLength, "maxLength");
    if (
      minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength
    ) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    return {
      type,
      ...(enumValues ? { enum: enumValues } : {}),
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
    };
  }

  if (type === "number" || type === "integer") {
    const minimum = assertFiniteBound(schema.minimum, "minimum");
    const maximum = assertFiniteBound(schema.maximum, "maximum");
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new ProviderExecutionError("invalid_output_schema");
    }
    return {
      type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  }

  if (type === "boolean" || type === "null") return { type };
  throw new ProviderExecutionError("invalid_output_schema");
}

export function validateStructuredValue(
  value: unknown,
  schemaInput: unknown,
): JsonValue {
  const schema = validateStructuredOutputSchema(schemaInput);

  const visit = (
    candidate: unknown,
    current: StructuredOutputSchema,
  ): JsonValue => {
    if (current.type === "null") {
      if (candidate !== null) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      return null;
    }
    if (current.type === "boolean") {
      if (typeof candidate !== "boolean") {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      return candidate;
    }
    if (current.type === "string") {
      if (typeof candidate !== "string") {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      if (
        (current.minLength !== undefined &&
          candidate.length < current.minLength) ||
        (current.maxLength !== undefined &&
          candidate.length > current.maxLength) ||
        (current.enum && !current.enum.includes(candidate))
      ) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      return candidate;
    }
    if (current.type === "number" || current.type === "integer") {
      if (
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        (current.type === "integer" && !Number.isInteger(candidate)) ||
        (current.minimum !== undefined && candidate < current.minimum) ||
        (current.maximum !== undefined && candidate > current.maximum)
      ) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      return candidate;
    }
    if (current.type === "array") {
      if (!Array.isArray(candidate)) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      if (
        (current.minItems !== undefined &&
          candidate.length < current.minItems) ||
        (current.maxItems !== undefined && candidate.length > current.maxItems)
      ) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
      return candidate.map((item) => visit(item, current.items));
    }
    if (!isRecord(candidate)) {
      throw new ProviderExecutionError("invalid_structured_output");
    }
    const result: Record<string, JsonValue> = {};
    const required = new Set(current.required ?? []);
    for (const field of required) {
      if (!(field in candidate)) {
        throw new ProviderExecutionError("invalid_structured_output");
      }
    }
    for (const [key, item] of Object.entries(candidate)) {
      const propertySchema = current.properties[key];
      if (!propertySchema) {
        if (current.additionalProperties !== true) {
          throw new ProviderExecutionError("invalid_structured_output");
        }
        if (
          item === null ||
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item))
        ) {
          result[key] = item as JsonValue;
          continue;
        }
        throw new ProviderExecutionError("invalid_structured_output");
      }
      result[key] = visit(item, propertySchema);
    }
    return result;
  };

  return visit(value, schema);
}

export function parseStructuredProviderText(
  text: string,
  schema: unknown,
): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderExecutionError("invalid_structured_output");
  }
  return validateStructuredValue(parsed, schema);
}

export function validateToolDefinitions(
  tools: readonly ProviderToolDefinition[] | undefined,
): ProviderToolDefinition[] {
  if (!tools) return [];
  if (tools.length > MAX_TOOL_DEFINITIONS) {
    throw new ProviderExecutionError("invalid_tool_definition");
  }
  const names = new Set<string>();
  return tools.map((tool) => {
    if (
      !toolNamePattern.test(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.trim().length === 0 ||
      tool.description.length > 2_000 ||
      names.has(tool.name)
    ) {
      throw new ProviderExecutionError("invalid_tool_definition");
    }
    names.add(tool.name);
    return {
      name: tool.name,
      description: tool.description.trim(),
      inputSchema: validateStructuredOutputSchema(tool.inputSchema),
    };
  });
}

export function normalizeToolCall(
  input: {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
  },
  tools: readonly ProviderToolDefinition[],
): ProviderToolCall {
  if (typeof input.name !== "string") {
    throw new ProviderExecutionError("provider_malformed_response");
  }
  const tool = tools.find((candidate) => candidate.name === input.name);
  if (!tool) throw new ProviderExecutionError("unexpected_tool_call");

  let args: unknown = input.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      throw new ProviderExecutionError("invalid_tool_arguments");
    }
  }
  try {
    const validated = validateStructuredValue(args, tool.inputSchema);
    return {
      ...(typeof input.id === "string" ? { id: input.id } : {}),
      name: tool.name,
      arguments: validated,
    };
  } catch (error) {
    if (
      error instanceof ProviderExecutionError &&
      error.code === "invalid_structured_output"
    ) {
      throw new ProviderExecutionError("invalid_tool_arguments");
    }
    throw error;
  }
}

export function parseRetryAfterMs(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}
