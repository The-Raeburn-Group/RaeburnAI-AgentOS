import { z } from "zod";
import { agentManifestDigest } from "@/lib/collaboration";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";

export const ROUTING_PLAN_CONTRACT_VERSION =
  "raeburnai.routing-plan.v1" as const;

export const RoutingIntentSchema = z.enum([
  "general_reasoning",
  "research",
  "software_engineering",
  "cybersecurity",
  "legal_research",
  "ai_engineering",
  "health_research",
  "finance",
  "tax",
  "procurement",
  "data_science",
  "strategy",
  "compliance",
  "sales",
  "recruitment",
  "operations",
  "education",
  "science",
  "creative",
  "vision_document",
]);
export type RoutingIntent = z.infer<typeof RoutingIntentSchema>;

export const RoutingRiskTierSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type RoutingRiskTier = z.infer<typeof RoutingRiskTierSchema>;

export const RoutingPlanRequestSchema = z.object({
  goal: z.string().trim().min(5).max(20_000),
  requiredCapabilities: z.array(z.string().trim().min(1)).max(32).default([]),
  requiredTools: z.array(z.string().trim().min(1)).max(32).default([]),
  maxExperts: z.number().int().min(1).max(4).default(2),
});
export type RoutingPlanRequest = z.infer<typeof RoutingPlanRequestSchema>;

const RoutingCandidateScoreSchema = z.object({
  expert: z.string().min(1),
  score: z.number().int().nonnegative(),
  matchedIntents: z.array(RoutingIntentSchema),
});

export const RoutingPlanSchema = z.object({
  contractVersion: z.literal(ROUTING_PLAN_CONTRACT_VERSION),
  primaryIntent: RoutingIntentSchema,
  intents: z.array(RoutingIntentSchema).min(1),
  riskTier: RoutingRiskTierSchema,
  mode: z.enum(["sequential", "parallel", "adjudicated", "evidence"]),
  strictness: z.enum(["standard", "high", "regulated"]),
  primaryAgents: z.array(z.string().min(1)).min(1),
  adjudicator: z.string().min(1).optional(),
  requiresHumanApproval: z.boolean(),
  reasons: z.array(z.string().min(1)).min(1),
  candidateScores: z.array(RoutingCandidateScoreSchema),
});
export type RoutingPlan = z.infer<typeof RoutingPlanSchema>;

export class RoutingPolicyError extends Error {
  constructor(
    public readonly code:
      | "duplicate_expert_slug"
      | "no_eligible_expert"
      | "no_eligible_adjudicator"
      | "max_experts_insufficient"
      | "manifest_integrity_invalid"
      | "manifest_identity_mismatch",
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RoutingPolicyError";
  }
}

interface IntentRule {
  intent: RoutingIntent;
  phrases: readonly string[];
  tokens: readonly string[];
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: "research",
    phrases: [
      "primary source",
      "primary sources",
      "contradiction check",
      "contradiction checks",
      "investigate a claim",
      "source verification",
    ],
    tokens: [
      "research",
      "investigate",
      "evidence",
      "source",
      "sources",
      "corroboration",
      "contradiction",
      "claim",
    ],
  },
  {
    intent: "software_engineering",
    phrases: [
      "race condition",
      "software change",
      "software engineering",
      "typescript service",
      "authentication logic",
      "deploy to production",
      "delete production",
    ],
    tokens: [
      "typescript",
      "software",
      "code",
      "api",
      "service",
      "database",
      "bug",
      "race",
      "concurrency",
    ],
  },
  {
    intent: "cybersecurity",
    phrases: [
      "credential exfiltration",
      "security sensitive",
      "prompt injection",
      "authentication logic",
      "cyber security",
      "disable security",
    ],
    tokens: [
      "security",
      "cybersecurity",
      "credential",
      "credentials",
      "exfiltration",
      "authentication",
      "vulnerability",
      "exploit",
      "attack",
      "secret",
      "token",
    ],
  },
  {
    intent: "legal_research",
    phrases: [
      "legal review",
      "legal conclusion",
      "governing jurisdiction",
      "sign contract",
      "file court",
    ],
    tokens: [
      "legal",
      "law",
      "court",
      "contract",
      "statute",
      "regulation",
      "jurisdiction",
    ],
  },
  {
    intent: "ai_engineering",
    phrases: ["machine learning", "artificial intelligence", "fine tuning"],
    tokens: [
      "llm",
      "model",
      "prompt",
      "embedding",
      "inference",
      "adapter",
      "rag",
    ],
  },
  {
    intent: "health_research",
    phrases: [
      "medical advice",
      "clinical evidence",
      "health research",
      "prescribe medication",
    ],
    tokens: [
      "medical",
      "health",
      "clinical",
      "diagnosis",
      "treatment",
      "medicine",
      "patient",
    ],
  },
  {
    intent: "finance",
    phrases: [
      "financial advice",
      "investment decision",
      "execute trade",
      "transfer funds",
    ],
    tokens: [
      "finance",
      "financial",
      "investment",
      "valuation",
      "portfolio",
      "trade",
      "trading",
    ],
  },
  {
    intent: "tax",
    phrases: ["tax return", "tax advice", "submit tax return"],
    tokens: ["tax", "vat", "hmrc", "corporation", "selfassessment"],
  },
  {
    intent: "procurement",
    phrases: ["public procurement", "supplier selection"],
    tokens: ["procurement", "tender", "bid", "supplier", "framework"],
  },
  {
    intent: "data_science",
    phrases: ["data science", "statistical analysis"],
    tokens: ["analytics", "statistics", "dataset", "regression", "forecast"],
  },
  {
    intent: "strategy",
    phrases: ["business strategy", "competitive analysis", "market entry"],
    tokens: ["strategy", "strategic", "competitive", "market", "positioning"],
  },
  {
    intent: "compliance",
    phrases: ["regulatory compliance", "ai governance", "compliance review"],
    tokens: ["compliance", "gdpr", "governance", "iso", "control", "controls"],
  },
  {
    intent: "sales",
    phrases: ["sales prospect", "commercial negotiation", "sales pipeline"],
    tokens: ["sales", "prospect", "qualification", "pipeline", "negotiation"],
  },
  {
    intent: "recruitment",
    phrases: ["recruitment sourcing", "ats workflow", "candidate assessment"],
    tokens: ["recruitment", "sourcing", "ats", "candidate", "hiring"],
  },
  {
    intent: "operations",
    phrases: [
      "operations workflow",
      "process improvement",
      "capacity planning",
    ],
    tokens: ["operations", "workflow", "process", "capacity", "runbook"],
  },
  {
    intent: "education",
    phrases: ["lesson plan", "assessment rubric", "adaptive learning"],
    tokens: ["education", "teaching", "curriculum", "assessment", "learning"],
  },
  {
    intent: "science",
    phrases: [
      "scientific literature",
      "experiment design",
      "test a hypothesis",
    ],
    tokens: ["science", "scientific", "experiment", "hypothesis", "laboratory"],
  },
  {
    intent: "creative",
    phrases: ["brand voice", "creative campaign", "creative writing"],
    tokens: ["creative", "branding", "copywriting", "campaign", "ideation"],
  },
  {
    intent: "vision_document",
    phrases: ["analyze a screenshot", "analyse a screenshot", "document image"],
    tokens: ["vision", "screenshot", "diagram", "image", "ocr"],
  },
];

const CRITICAL_PHRASES = [
  "transfer funds",
  "execute trade",
  "sign contract",
  "submit tax return",
  "file court",
  "deploy to production",
  "delete production",
  "disable security",
  "prescribe medication",
];

const HIGH_RISK_PHRASES = [
  "credential exfiltration",
  "security sensitive",
  "production credential",
  "personal data",
  "special category",
  "authentication logic",
  "prompt injection",
];

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTag(value: string): string {
  return normalizedText(value).replace(/ /g, "_");
}

function words(value: string): Set<string> {
  return new Set(normalizedText(value).split(" ").filter(Boolean));
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = ` ${normalizedText(text)} `;
  const wanted = ` ${normalizedText(phrase)} `;
  return normalized.includes(wanted);
}

function classifyIntents(goal: string): {
  primary: RoutingIntent;
  intents: RoutingIntent[];
  scores: Map<RoutingIntent, number>;
} {
  const goalWords = words(goal);
  const scored = INTENT_RULES.map((rule) => {
    const phraseScore = rule.phrases.reduce(
      (sum, phrase) => sum + (containsPhrase(goal, phrase) ? 4 : 0),
      0,
    );
    const tokenScore = rule.tokens.reduce(
      (sum, token) => sum + (goalWords.has(token) ? 1 : 0),
      0,
    );
    return { intent: rule.intent, score: phraseScore + tokenScore };
  })
    .filter((item) => item.score >= 2)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.intent.localeCompare(right.intent);
    });

  if (scored.length === 0) {
    return {
      primary: "general_reasoning",
      intents: ["general_reasoning"],
      scores: new Map([["general_reasoning", 1]]),
    };
  }

  return {
    primary: scored[0]!.intent,
    intents: scored.map((item) => item.intent),
    scores: new Map(scored.map((item) => [item.intent, item.score])),
  };
}

function classifyRisk(
  goal: string,
  intents: RoutingIntent[],
): { riskTier: RoutingRiskTier; reason: string } {
  for (const phrase of CRITICAL_PHRASES) {
    if (containsPhrase(goal, phrase)) {
      return {
        riskTier: "critical",
        reason: `critical action marker: ${phrase}`,
      };
    }
  }

  for (const phrase of HIGH_RISK_PHRASES) {
    if (containsPhrase(goal, phrase)) {
      return { riskTier: "high", reason: `high-risk marker: ${phrase}` };
    }
  }

  if (
    intents.some((intent) =>
      [
        "cybersecurity",
        "legal_research",
        "health_research",
        "finance",
        "tax",
        "compliance",
      ].includes(intent),
    )
  ) {
    return {
      riskTier: "high",
      reason: "classified high-stakes domain",
    };
  }

  if (intents.some((intent) => intent !== "general_reasoning")) {
    return {
      riskTier: "medium",
      reason: "specialist domain requires governed routing",
    };
  }

  return { riskTier: "low", reason: "general low-risk routing" };
}

function exactSetContains(haystack: string[], required: string[]): boolean {
  const values = new Set(haystack.map(canonicalTag));
  return required.every((value) => values.has(canonicalTag(value)));
}

function expertMatchesIntent(
  manifest: AgentManifest,
  intent: RoutingIntent,
): boolean {
  const domains = new Set(manifest.domains.map(canonicalTag));
  const capabilities = new Set(manifest.capabilities.map(canonicalTag));
  return (
    domains.has(intent) ||
    capabilities.has(intent) ||
    capabilities.has(`${intent}_expert`)
  );
}

function scoreExpert(
  manifest: AgentManifest,
  intents: RoutingIntent[],
  intentScores: Map<RoutingIntent, number>,
): z.infer<typeof RoutingCandidateScoreSchema> {
  const matchedIntents = intents.filter((intent) =>
    expertMatchesIntent(manifest, intent),
  );
  const domains = new Set(manifest.domains.map(canonicalTag));
  const capabilities = new Set(manifest.capabilities.map(canonicalTag));
  const score = matchedIntents.reduce((sum, intent) => {
    const classifierScore = intentScores.get(intent) ?? 1;
    const domainScore = domains.has(intent) ? 100 : 0;
    const capabilityScore =
      capabilities.has(intent) || capabilities.has(`${intent}_expert`) ? 40 : 0;
    return sum + domainScore + capabilityScore + classifierScore;
  }, 0);
  return { expert: manifest.slug, score, matchedIntents };
}

function eligibleForRequirements(
  manifest: AgentManifest,
  request: RoutingPlanRequest,
): boolean {
  return (
    exactSetContains(manifest.capabilities, request.requiredCapabilities) &&
    exactSetContains(manifest.requiredTools, request.requiredTools)
  );
}

function isEvidenceAdjudicator(manifest: AgentManifest): boolean {
  const capabilities = new Set(manifest.capabilities.map(canonicalTag));
  return (
    (capabilities.has("adjudication") ||
      capabilities.has("evidence_verification") ||
      capabilities.has("verification")) &&
    manifest.evidencePolicy.requireSources &&
    manifest.evidencePolicy.contradictionSearch
  );
}

function isAdjudicator(manifest: AgentManifest): boolean {
  const capabilities = new Set(manifest.capabilities.map(canonicalTag));
  return (
    capabilities.has("adjudication") ||
    capabilities.has("evidence_verification") ||
    capabilities.has("verification")
  );
}

function sortedUniqueExperts(manifests: AgentManifest[]): AgentManifest[] {
  const bySlug = new Map<string, AgentManifest>();
  for (const manifest of manifests) {
    if (bySlug.has(manifest.slug)) {
      throw new RoutingPolicyError(
        "duplicate_expert_slug",
        `duplicate expert slug: ${manifest.slug}`,
      );
    }
    bySlug.set(manifest.slug, manifest);
  }
  return [...bySlug.values()].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
}

export function planExpertRoute(
  requestInput: unknown,
  manifestInputs: unknown[],
): RoutingPlan {
  const request = RoutingPlanRequestSchema.parse(requestInput);
  const manifests = sortedUniqueExperts(
    manifestInputs.map((input) => AgentManifestSchema.parse(input)),
  );
  const classification = classifyIntents(request.goal);
  const { riskTier, reason: riskReason } = classifyRisk(
    request.goal,
    classification.intents,
  );

  if (
    (riskTier === "high" || riskTier === "critical") &&
    classification.intents.length > request.maxExperts
  ) {
    throw new RoutingPolicyError(
      "max_experts_insufficient",
      "high-stakes multi-domain requests may not silently drop classified domains",
    );
  }

  const eligible = manifests.filter((manifest) =>
    eligibleForRequirements(manifest, request),
  );
  const candidateScores = eligible
    .map((manifest) =>
      scoreExpert(manifest, classification.intents, classification.scores),
    )
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.expert.localeCompare(right.expert);
    });

  const manifestBySlug = new Map(
    eligible.map((manifest) => [manifest.slug, manifest]),
  );
  const selected: AgentManifest[] = [];
  for (const intent of classification.intents) {
    const candidate = candidateScores.find(
      (item) =>
        item.matchedIntents.includes(intent) &&
        !selected.some((expert) => expert.slug === item.expert),
    );
    if (!candidate) {
      throw new RoutingPolicyError(
        "no_eligible_expert",
        `no verified expert satisfies classified intent: ${intent}`,
      );
    }
    const expert = manifestBySlug.get(candidate.expert);
    if (!expert) {
      throw new RoutingPolicyError(
        "no_eligible_expert",
        `expert registry entry disappeared: ${candidate.expert}`,
      );
    }
    selected.push(expert);
    if (selected.length >= request.maxExperts) break;
  }

  if (selected.length === 0) {
    throw new RoutingPolicyError(
      "no_eligible_expert",
      "no verified expert satisfies routing requirements",
    );
  }

  const strictness =
    riskTier === "critical"
      ? ("regulated" as const)
      : riskTier === "high"
        ? ("high" as const)
        : ("standard" as const);
  const mode =
    riskTier === "critical" || riskTier === "high"
      ? ("evidence" as const)
      : selected.length > 1
        ? ("adjudicated" as const)
        : ("sequential" as const);

  let adjudicator: AgentManifest | undefined;
  if (mode === "evidence" || mode === "adjudicated") {
    adjudicator = manifests
      .filter(
        (manifest) =>
          !selected.some((expert) => expert.slug === manifest.slug) &&
          (mode === "evidence"
            ? isEvidenceAdjudicator(manifest)
            : isAdjudicator(manifest)),
      )
      .sort((left, right) => left.slug.localeCompare(right.slug))[0];

    if (!adjudicator) {
      throw new RoutingPolicyError(
        "no_eligible_adjudicator",
        mode === "evidence"
          ? "high-stakes routing requires an evidence-capable independent adjudicator"
          : "multi-expert routing requires an independent adjudicator",
      );
    }
  }

  const requiresHumanApproval =
    riskTier === "high" ||
    riskTier === "critical" ||
    selected.some((manifest) => manifest.approvalRequired) ||
    Boolean(adjudicator?.approvalRequired);

  return RoutingPlanSchema.parse({
    contractVersion: ROUTING_PLAN_CONTRACT_VERSION,
    primaryIntent: classification.primary,
    intents: classification.intents,
    riskTier,
    mode,
    strictness,
    primaryAgents: selected.map((manifest) => manifest.slug),
    ...(adjudicator ? { adjudicator: adjudicator.slug } : {}),
    requiresHumanApproval,
    reasons: [
      `primary intent: ${classification.primary}`,
      `classified intents: ${classification.intents.join(", ")}`,
      riskReason,
      `selected expert count: ${selected.length}`,
      ...(adjudicator ? [`independent adjudicator: ${adjudicator.slug}`] : []),
    ],
    candidateScores,
  });
}

const StoredManifestEnvelopeSchema = z
  .object({
    integrity: z.object({
      algorithm: z.literal("sha256"),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  })
  .passthrough();

export interface StoredManifestIdentity {
  slug: string;
  version: string;
  systemPrompt?: string;
  modelProvider?: string;
  modelName?: string;
  approvalRequired?: boolean;
}

export function verifyStoredAgentManifest(
  input: unknown,
  expected: StoredManifestIdentity,
): AgentManifest {
  const envelope = StoredManifestEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new RoutingPolicyError(
      "manifest_integrity_invalid",
      "stored manifest is missing a valid SHA-256 integrity envelope",
    );
  }

  const parsed = AgentManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RoutingPolicyError(
      "manifest_integrity_invalid",
      "stored manifest does not satisfy raeburnai.agent-manifest.v1",
    );
  }
  const manifest = parsed.data;

  if (
    manifest.slug !== expected.slug ||
    manifest.version !== expected.version
  ) {
    throw new RoutingPolicyError(
      "manifest_identity_mismatch",
      "stored manifest slug/version does not match the executable agent record",
    );
  }

  const executionFields: Array<[string, unknown, unknown]> = [
    ["systemPrompt", expected.systemPrompt, manifest.systemPrompt],
    ["modelProvider", expected.modelProvider, manifest.modelProvider],
    ["modelName", expected.modelName, manifest.modelName],
    ["approvalRequired", expected.approvalRequired, manifest.approvalRequired],
  ];
  for (const [field, actual, declared] of executionFields) {
    if (actual !== undefined && actual !== declared) {
      throw new RoutingPolicyError(
        "manifest_identity_mismatch",
        `stored manifest ${field} does not match the executable agent record`,
      );
    }
  }

  if (agentManifestDigest(manifest) !== envelope.data.integrity.digest) {
    throw new RoutingPolicyError(
      "manifest_integrity_invalid",
      "stored manifest digest does not match its content",
    );
  }

  return manifest;
}
