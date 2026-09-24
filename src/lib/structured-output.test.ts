import { describe, expect, it } from "vitest";

import {
  enforceStructuredOutput,
  outputContractFromManifest,
  StructuredOutputError,
} from "@/lib/structured-output";

describe("structured output enforcement", () => {
  it("defaults legacy manifests to text without mutating output", () => {
    const contract = outputContractFromManifest({});
    expect(contract).toEqual({ mode: "text" });
    expect(enforceStructuredOutput("plain text", contract)).toBe("plain text");
  });

  it("accepts a declared JSON object with exact property types", () => {
    const contract = outputContractFromManifest({
      outputContract: {
        mode: "json",
        required: ["decision", "confidence"],
        properties: {
          decision: "string",
          confidence: "number",
          approved: "boolean",
        },
        additionalProperties: false,
        maxBytes: 1000,
      },
    });
    expect(
      enforceStructuredOutput(
        '{"decision":"approve","confidence":0.9,"approved":true}',
        contract,
      ),
    ).toEqual({
      decision: "approve",
      confidence: 0.9,
      approved: true,
    });
  });

  it.each([
    ['{"decision":"approve"}', "required_property_missing", "confidence"],
    [
      '{"decision":"approve","confidence":"high"}',
      "property_type_mismatch",
      "confidence",
    ],
    [
      '{"decision":"approve","confidence":0.9,"extra":true}',
      "unexpected_property",
      "extra",
    ],
    ["[1,2,3]", "json_object_required", undefined],
    ["not-json", "invalid_json", undefined],
  ])("fails closed on malformed governed JSON", (text, code, detail) => {
    const contract = outputContractFromManifest({
      outputContract: {
        mode: "json",
        required: ["decision", "confidence"],
        properties: {
          decision: "string",
          confidence: "number",
        },
        additionalProperties: false,
      },
    });
    try {
      enforceStructuredOutput(text, contract);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect(error).toMatchObject({ code });
      if (detail)
        expect((error as StructuredOutputError).detail).toContain(detail);
    }
  });

  it("rejects invalid manifest output contracts instead of silently downgrading", () => {
    expect(() =>
      outputContractFromManifest({
        outputContract: {
          mode: "json",
          required: ["result"],
          properties: { result: "unsupported-type" },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<StructuredOutputError>>({
        code: "invalid_output_contract",
      }),
    );
  });

  it("enforces the configured output byte ceiling", () => {
    const contract = outputContractFromManifest({
      outputContract: {
        mode: "json",
        properties: { result: "string" },
        maxBytes: 10,
      },
    });
    expect(() =>
      enforceStructuredOutput('{"result":"too large"}', contract),
    ).toThrowError(
      expect.objectContaining<Partial<StructuredOutputError>>({
        code: "output_too_large",
      }),
    );
  });
});
