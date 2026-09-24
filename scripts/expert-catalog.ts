import {
  EVIDENCE_VERIFIER_MANIFEST,
  buildExpertCatalog,
  expertCatalogDigest,
  listExpertManifests,
} from "../src/lib/expert-catalog";
import { planExpertRoute } from "../src/lib/routing-policy";

const catalog = buildExpertCatalog();
const manifests = [...listExpertManifests(), EVIDENCE_VERIFIER_MANIFEST];
const routes = catalog.packs.map((pack) => {
  const plan = planExpertRoute(
    {
      goal: pack.routingProbe,
      maxExperts: 2,
    },
    manifests,
  );

  if (
    plan.primaryAgents.length !== 1 ||
    plan.primaryAgents[0] !== pack.manifest.slug ||
    plan.riskTier !== pack.manifest.riskTier
  ) {
    throw new Error(
      `expert_catalog_route_mismatch: ${pack.manifest.slug} -> ${plan.primaryAgents.join(",")}/${plan.riskTier}`,
    );
  }

  return {
    expert: pack.manifest.slug,
    riskTier: plan.riskTier,
    seedCases: pack.evaluationSeed.length,
    taskCount: pack.taskTaxonomy.length,
  };
});

const totalSeedCases = catalog.packs.reduce(
  (sum, pack) => sum + pack.evaluationSeed.length,
  0,
);

if (catalog.packs.length !== 20 || totalSeedCases !== 2_000) {
  throw new Error("expert_catalog_cardinality_invalid");
}

process.stdout.write(
  `${JSON.stringify(
    {
      contractVersion: catalog.contractVersion,
      catalogVersion: catalog.catalogVersion,
      digest: expertCatalogDigest(),
      expertCount: catalog.packs.length,
      totalSeedCases,
      routes,
    },
    null,
    2,
  )}\n`,
);
