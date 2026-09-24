import { describe, expect, it } from "vitest";

import {
  normalizeToolCall,
  parseRetryAfterMs,
  parseStructuredProviderText,
  ProviderExecutionError,
  validateStructuredOutputSchema,
  validateStructuredValue,
  validateToolDefinitions,
  type ProviderToolDefinition,
} from "@/lib/provider-contract";

const objectSchema = {
  type: "object" as const,
  properties: {
    answer: { type: "string" as const, minLength: 1 },
    confidence: {
      type: "number" as const,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["answer", "confidence"],
  additionalProperties: false,
};

describe("provider execution contract", () => {
  it("validates bounded structured output and rejects extra or missing fields", () => {
    expect(
      validateStructuredValue(
        { answer: "grounded", confidence: 0.9 },
        objectSchema,
      ),
    ).toEqual({ answer: "grounded", confidence: 0.9 });

    expect(() =>
      validateStructuredValue({ answer: "missing confidence" }, objectSchema),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_structured_output",
      }),
    );

    expect(() =>
      validateStructuredValue(
        { answer: "grounded", confidence: 0.9, hidden: "unexpected" },
        objectSchema,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_structured_output",
      }),
    );
  });

  it("parses JSON text and rejects malformed JSON before it can be trusted", () => {
    expect(
      parseStructuredProviderText(
        '{"answer":"ok","confidence":0.5}',
        objectSchema,
      ),
    ).toEqual({ answer: "ok", confidence: 0.5 });

    expect(() =>
      parseStructuredProviderText(
        '{"answer":"ok","confidence":',
        objectSchema,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_structured_output",
      }),
    );
  });

  it("rejects excessively deep and internally inconsistent schemas", () => {
    let nested: unknown = { type: "string" };
    for (let index = 0; index < 14; index += 1) {
      nested = {
        type: "array",
        items: nested,
      };
    }
    expect(() => validateStructuredOutputSchema(nested)).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_output_schema",
      }),
    );

    expect(() =>
      validateStructuredOutputSchema({
        type: "string",
        minLength: 5,
        maxLength: 2,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_output_schema",
      }),
    );
  });

  it("normalizes only declared tool calls with schema-valid arguments", () => {
    const tools: ProviderToolDefinition[] = validateToolDefinitions([
      {
        name: "lookup_record",
        description: "Look up a record by a stable identifier.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    ]);

    expect(
      normalizeToolCall(
        {
          id: "call-1",
          name: "lookup_record",
          arguments: '{"id":"abc-123"}',
        },
        tools,
      ),
    ).toEqual({
      id: "call-1",
      name: "lookup_record",
      arguments: { id: "abc-123" },
    });

    expect(() =>
      normalizeToolCall(
        { name: "delete_everything", arguments: "{}" },
        tools,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "unexpected_tool_call",
      }),
    );

    expect(() =>
      normalizeToolCall(
        { name: "lookup_record", arguments: '{"unexpected":true}' },
        tools,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_tool_arguments",
      }),
    );
  });

  it("rejects duplicate or malformed tool definitions", () => {
    expect(() =>
      validateToolDefinitions([
        {
          name: "lookup",
          description: "First definition.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "lookup",
          description: "Duplicate definition.",
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderExecutionError>>({
        code: "invalid_tool_definition",
      }),
    );
  });

  it("normalizes Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("1.5", 0)).toBe(1500);
    expect(
      parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000),
    ).toBe(4_000);
    expect(parseRetryAfterMs("not-a-date", 0)).toBeUndefined();
  });
});
