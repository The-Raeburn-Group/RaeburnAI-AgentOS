import { describe, expect, it } from "vitest";
import {
  EVIDENCE_VERIFIER_MANIFEST,
  buildExpertCatalog,
  buildExpertPack,
  expertCatalogDigest,
  listExpertManifests,
  listExpertPackSlugs,
  listExpertPackSummaries,
} from "@/lib/expert-catalog";
import { RoutingPolicyError, planExpertRoute } from "@/lib/routing-policy";

function expectRoutingError(
  action: () => unknown,
  code: RoutingPolicyError["code"],
) {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RoutingPolicyError);
  expect((thrown as RoutingPolicyError).code).toBe(code);
}

describe("governed expert catalog", () => {
  it("contains all 20 tracked expert packs with stable, unique identities", () => {
    const catalog = buildExpertCatalog();
    expect(catalog.packs).toHaveLength(20);
    expect(listExpertPackSlugs()).toHaveLength(20);
    expect(new Set(listExpertPackSlugs()).size).toBe(20);
    expect(expertCatalogDigest()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("provides 100 privacy-minimised synthetic seed records for every expert", () => {
    const catalog = buildExpertCatalog();
    const allIds = new Set<string>();

    for (const pack of catalog.packs) {
      expect(pack.taskTaxonomy).toHaveLength(5);
      expect(pack.evaluationSeed).toHaveLength(100);
      expect(pack.card.seedCaseCount).toBe(100);
      expect(pack.card.lifecycle).toBe("development");
      expect(pack.manifest.modelName).toBe("catalog-unassigned");
      expect(pack.manifest.evalSuites).toContain("expert-seed-v1");

      for (const record of pack.evaluationSeed) {
        expect(allIds.has(record.id)).toBe(false);
        allIds.add(record.id);
        expect(record.domain).toBe(pack.manifest.domains[0]);
        expect(record.provenance.sourceKind).toBe("synthetic");
        expect(record.provenance.privacy.containsPersonalData).toBe(false);
        expect(record.provenance.privacy.containsSpecialCategoryData).toBe(
          false,
        );
        expect(record.provenance.permittedPurposes).toEqual(
          expect.arrayContaining(["evaluation", "training", "red_team"]),
        );
      }
    }

    expect(allIds.size).toBe(2_000);
  });

  it("routes every catalog probe to its exact expert without activating unreviewed models", () => {
    const summaries = listExpertPackSummaries();
    const manifests = [...listExpertManifests(), EVIDENCE_VERIFIER_MANIFEST];

    for (const summary of summaries) {
      const plan = planExpertRoute(
        {
          goal: summary.routingProbe,
          maxExperts: 2,
        },
        manifests,
      );

      expect(plan.primaryAgents).toEqual([summary.slug]);
      expect(plan.riskTier).toBe(summary.riskTier);
      expect(summary.manifest.modelName).toBe("catalog-unassigned");
      expect(summary.card.lifecycle).toBe("development");
    }
  });

  it("keeps high-risk catalog experts fail-closed without an independent evidence verifier", () => {
    const pack = buildExpertPack("raeburn-finance");
    expectRoutingError(
      () =>
        planExpertRoute(
          { goal: pack.routingProbe, maxExperts: 2 },
          listExpertManifests(),
        ),
      "no_eligible_adjudicator",
    );
  });

  it("marks high-risk packs as requiring both human oversight and evidence", () => {
    const highRisk = buildExpertCatalog().packs.filter(
      (pack) =>
        pack.manifest.riskTier === "high" ||
        pack.manifest.riskTier === "critical",
    );

    expect(highRisk.length).toBeGreaterThan(0);
    for (const pack of highRisk) {
      expect(pack.manifest.approvalRequired).toBe(true);
      expect(pack.manifest.evidencePolicy.requireSources).toBe(true);
      expect(pack.card.humanOversight).toBe("required");
      expect(pack.card.evidenceRequired).toBe(true);
    }
  });
});
