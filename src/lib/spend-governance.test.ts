import { describe, expect, it } from "vitest";

import {
  costMicrosForTokens,
  estimateModelTokens,
  formatMicrosAsUsd,
  parseUsdToMicros,
  registryModelCostMicrosPer1k,
  SpendBudgetInputSchema,
} from "@/lib/spend-governance";

describe("spend governance primitives", () => {
  it("parses and formats USD without floating point drift", () => {
    expect(parseUsdToMicros("0")).toBe(0n);
    expect(parseUsdToMicros("12.34")).toBe(12_340_000n);
    expect(parseUsdToMicros("999999999.999999")).toBe(
      999_999_999_999_999n,
    );
    expect(formatMicrosAsUsd(12_340_000n)).toBe("12.34");
    expect(formatMicrosAsUsd(1n)).toBe("0.000001");
    expect(() => parseUsdToMicros("1.0000001")).toThrow("invalid_usd_amount");
    expect(() => parseUsdToMicros("-1")).toThrow("invalid_usd_amount");
  });

  it("uses a conservative bounded token estimate and round-up costing", () => {
    expect(
      estimateModelTokens(
        [
          { content: "12345678" },
          { content: "abcd" },
        ],
        100,
      ),
    ).toBe(103);
    expect(costMicrosForTokens(1, 1n)).toBe(1n);
    expect(costMicrosForTokens(1_001, 1_000_000n)).toBe(1_001_000n);
  });

  it("keeps unresolved repository model pricing fail-closed", () => {
    expect(registryModelCostMicrosPer1k("ollama", "llama3.1")).toBeNull();
    expect(registryModelCostMicrosPer1k("openai", "not-registered")).toBeNull();
  });

  it("rejects malformed, inverted and unsafe budget definitions", () => {
    expect(() =>
      SpendBudgetInputSchema.parse({
        name: "monthly",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        softLimitUsd: "75.00",
        hardLimitUsd: "100.00",
      }),
    ).not.toThrow();

    expect(() =>
      SpendBudgetInputSchema.parse({
        name: "bad",
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        hardLimitUsd: "100.00",
      }),
    ).toThrow();

    expect(() =>
      SpendBudgetInputSchema.parse({
        name: "bad",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        softLimitUsd: "101",
        hardLimitUsd: "100",
      }),
    ).toThrow();

    expect(() =>
      SpendBudgetInputSchema.parse({
        name: "bad",
        periodStart: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-10-01T00:00:00.000Z",
        hardLimitUsd: "1000000000",
      }),
    ).toThrow();
  });
});
