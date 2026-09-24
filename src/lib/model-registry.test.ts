import { describe, expect, it } from "vitest";
import {
  ModelRegistryError,
  evaluateModelRegistryFreshness,
  modelRegistryDigest,
  parseModelRegistry,
  selectRegistryModel,
} from "@/lib/model-registry";

function registry() {
  return {
    contractVersion: "raeburnai.model-registry.v1",
    registryVersion: "0.1.0",
    generatedAt: "2026-09-24T08:00:00.000Z",
    entries: [
      {
        id: "local.fast.v1",
        provider: "ollama",
        model: "local-fast",
        revision: "1",
        lifecycle: "active",
        capabilities: ["general", "tools"],
        modalities: ["text"],
        contextWindow: 32000,
        toolSupport: "yes",
        privacy: "local",
        licensing: {
          identifier: "declared-test-license",
          technicalReview: "technical_reviewed",
        },
        benchmark: {
          qualityScore: 0.82,
          p95LatencyMs: 900,
          costPer1kTokensUsd: 0,
          evidenceDigests: ["a".repeat(64)],
        },
        freshness: {
          observedAt: "2026-09-24T08:00:00.000Z",
          maxAgeDays: 30,
          providerStatus: "active",
          sourceRef: "test-fixture",
          deprecationAt: null,
        },
      },
      {
        id: "cloud.quality.v1",
        provider: "openrouter",
        model: "cloud-quality",
        revision: "1",
        lifecycle: "active",
        capabilities: ["general", "tools"],
        modalities: ["text"],
        contextWindow: 128000,
        toolSupport: "yes",
        privacy: "third_party",
        licensing: {
          identifier: "declared-test-license",
          technicalReview: "technical_reviewed",
        },
        benchmark: {
          qualityScore: 0.95,
          p95LatencyMs: 1800,
          costPer1kTokensUsd: 0.01,
          evidenceDigests: ["b".repeat(64)],
        },
        freshness: {
          observedAt: "2026-09-24T08:00:00.000Z",
          maxAgeDays: 30,
          providerStatus: "active",
          sourceRef: "test-fixture",
          deprecationAt: null,
        },
      },
    ],
  };
}

describe("model registry", () => {
  it("parses a unique versioned registry and emits a stable digest", () => {
    const parsed = parseModelRegistry(registry());
    expect(parsed.entries).toHaveLength(2);
    expect(modelRegistryDigest(parsed)).toMatch(/^[a-f0-9]{64}$/);
    expect(modelRegistryDigest(parsed)).toBe(modelRegistryDigest(parsed));
  });

  it("rejects duplicate provider/model/revision identities", () => {
    const input = registry();
    input.entries.push({
      ...structuredClone(input.entries[0]),
      id: "local.duplicate.v1",
    });
    expect(() => parseModelRegistry(input)).toThrow(
      "duplicate provider/model/revision",
    );
  });

  it("reports stale, deprecated, unreviewed and unbenchmarked entries", () => {
    const input = registry();
    input.entries[0].freshness.observedAt = "2026-01-01T00:00:00.000Z";
    input.entries[0].licensing.technicalReview = "unreviewed";
    input.entries[0].benchmark.qualityScore = null;
    input.entries[0].benchmark.evidenceDigests = [];
    input.entries[1].freshness.providerStatus = "deprecated";

    const result = evaluateModelRegistryFreshness(
      input,
      new Date("2026-09-24T10:00:00.000Z"),
    );
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "stale_observation",
        "technical_review_missing",
        "benchmark_evidence_missing",
        "provider_deprecated",
      ]),
    );
  });

  it("selects only active, fresh, technically reviewed and benchmark-backed models", () => {
    const result = selectRegistryModel(
      registry(),
      {
        requiredCapabilities: ["general", "tools"],
        requireTools: true,
        privacy: "any",
        minQualityScore: 0.8,
        maxP95LatencyMs: 2500,
        maxCostPer1kTokensUsd: 0.02,
        weights: { quality: 0.8, latency: 0.1, cost: 0.1 },
      },
      new Date("2026-09-24T10:00:00.000Z"),
    );
    expect(result.entry.id).toBe("cloud.quality.v1");
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("fails closed when freshness or governance removes every candidate", () => {
    const input = registry();
    input.entries.forEach((entry) => {
      entry.licensing.technicalReview = "blocked";
    });
    expect(() =>
      selectRegistryModel(
        input,
        { requiredCapabilities: ["general"] },
        new Date("2026-09-24T10:00:00.000Z"),
      ),
    ).toMatchObject<Partial<ModelRegistryError>>({
      code: "no_eligible_model",
    });
  });

  it("does not silently accept zero selection weights", () => {
    expect(() =>
      selectRegistryModel(registry(), {
        weights: { quality: 0, latency: 0, cost: 0 },
      }),
    ).toMatchObject<Partial<ModelRegistryError>>({
      code: "invalid_selection_weights",
    });
  });
});
