import { z } from "zod";

const JsonPropertyTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "null",
]);

export const OutputContractSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text") }),
  z.object({
    mode: z.literal("json"),
    required: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    properties: z.record(JsonPropertyTypeSchema).default({}),
    additionalProperties: z.boolean().default(false),
    maxBytes: z.number().int().min(2).max(1_000_000).default(100_000),
  }),
]);

export type OutputContractInput = z.input<typeof OutputContractSchema>;
export type OutputContract = z.output<typeof OutputContractSchema>;

export class StructuredOutputError extends Error {
  constructor(
    public readonly code:
      | "invalid_output_contract"
      | "output_too_large"
      | "invalid_json"
      | "json_object_required"
      | "required_property_missing"
      | "unexpected_property"
      | "property_type_mismatch",
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "StructuredOutputError";
  }
}

function jsonType(value: unknown): z.infer<typeof JsonPropertyTypeSchema> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      throw new StructuredOutputError(
        "property_type_mismatch",
        "unsupported JSON value type",
      );
  }
}

export function outputContractFromManifest(manifest: unknown): OutputContract {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { mode: "text" };
  }
  const candidate = (manifest as Record<string, unknown>).outputContract;
  if (candidate === undefined) return { mode: "text" };
  const parsed = OutputContractSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StructuredOutputError("invalid_output_contract");
  }
  return parsed.data;
}

export function enforceStructuredOutput(
  text: string,
  contract: OutputContract,
): unknown {
  if (contract.mode === "text") return text;

  if (Buffer.byteLength(text, "utf8") > contract.maxBytes) {
    throw new StructuredOutputError("output_too_large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StructuredOutputError("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StructuredOutputError("json_object_required");
  }

  const object = parsed as Record<string, unknown>;
  for (const key of contract.required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new StructuredOutputError("required_property_missing", key);
    }
  }

  const propertyEntries = Object.entries(contract.properties);
  const declared = new Set(propertyEntries.map(([key]) => key));
  if (!contract.additionalProperties) {
    for (const key of Object.keys(object)) {
      if (!declared.has(key)) {
        throw new StructuredOutputError("unexpected_property", key);
      }
    }
  }

  for (const [key, expectedType] of propertyEntries) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const actualType = jsonType(object[key]);
    if (actualType !== expectedType) {
      throw new StructuredOutputError(
        "property_type_mismatch",
        `${key}: expected ${expectedType}, got ${actualType}`,
      );
    }
    if (actualType === "number" && !Number.isFinite(object[key] as number)) {
      throw new StructuredOutputError(
        "property_type_mismatch",
        `${key}: non-finite number`,
      );
    }
  }

  return parsed;
}
