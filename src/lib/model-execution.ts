import modelRegistryInput from "../../config/model-registry.v1.json";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { parseModelRegistry } from "@/lib/model-registry";
import {
  type ProviderGenerationOptions,
  type ProviderToolChoice,
  type ProviderToolDefinition,
  generateWithProvider,
} from "@/lib/providers";
import {
  enforceStructuredOutput,
  type OutputContract,
  type OutputContractInput,
  OutputContractSchema,
  StructuredOutputError,
} from "@/lib/structured-output";
import {
  JsonValueSchema,
  type ProviderMessage,
  type ProviderResponse,
} from "@/lib/types";
import {
  commitSpend,
  recordUnreservedUsage,
  releaseSpend,
  reserveSpend,
  UsageLedgerError,
} from "@/lib/usage-ledger";

export interface ModelCostEvidence {
  modelRegistryId: string;
  unitCostMicrousdPer1k: number;
}

export type ModelCostResolver = (
  provider: string,
  model: string,
) => ModelCostEvidence | null;

export type ModelGenerator = (
  options: ProviderGenerationOptions,
) => Promise<ProviderResponse>;

export interface GovernedModelCallOptions {
  tenantId: string;
  actorId: string;
  requestId: string;
  runId?: string;
  taskId: string;
  expertSlug?: string;
  provider: string;
  model: string;
  messages: ProviderMessage[];
  responseFormat?: "text" | "json";
  outputContract?: OutputContractInput;
  tools?: ProviderToolDefinition[];
  toolChoice?: ProviderToolChoice;
  signal?: AbortSignal;
  now?: Date;
  generate?: ModelGenerator;
  costResolver?: ModelCostResolver;
}

function safeMicrousd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_model_cost_microusd");
  }
  return value;
}

function usdToMicrousd(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("invalid_model_cost_usd");
  }
  return safeMicrousd(Math.round(value * 1_000_000));
}

export function resolveRegistryModelCost(
  provider: string,
  model: string,
): ModelCostEvidence | null {
  const registry = parseModelRegistry(modelRegistryInput);
  const eligible = registry.entries.filter(
    (entry) =>
      entry.provider === provider &&
      entry.model === model &&
      entry.lifecycle === "active" &&
      entry.freshness.providerStatus === "active" &&
      entry.licensing.technicalReview === "technical_reviewed" &&
      entry.benchmark.costPer1kTokensUsd !== null &&
      entry.benchmark.evidenceDigests.length > 0,
  );
  if (eligible.length !== 1) return null;
  const entry = eligible[0];
  if (!entry || entry.benchmark.costPer1kTokensUsd === null) return null;
  return {
    modelRegistryId: entry.id,
    unitCostMicrousdPer1k: usdToMicrousd(entry.benchmark.costPer1kTokensUsd),
  };
}

export function estimateTokenUpperBound(
  messages: ProviderMessage[],
  maxOutputTokens = env.MODEL_MAX_OUTPUT_TOKENS,
): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("invalid_model_max_output_tokens");
  }
  const inputBytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, "utf8"),
    0,
  );
  const estimate = inputBytes + maxOutputTokens;
  if (!Number.isSafeInteger(estimate) || estimate <= 0) {
    throw new Error("invalid_model_token_estimate");
  }
  return estimate;
}

export function estimateModelCostMicrousd(
  tokens: number,
  unitCostMicrousdPer1k: number,
): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error("invalid_model_token_count");
  }
  safeMicrousd(unitCostMicrousdPer1k);
  const numerator = BigInt(tokens) * BigInt(unitCostMicrousdPer1k);
  const microusd = (numerator + 999n) / 1_000n;
  const asNumber = Number(microusd);
  return safeMicrousd(asNumber);
}

function providerTokenBreakdown(response: ProviderResponse): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number | null;
} {
  const inputTokens = response.promptTokens ?? 0;
  const outputTokens = response.completionTokens ?? 0;
  const derivedTotal =
    response.promptTokens !== undefined &&
    response.completionTokens !== undefined
      ? response.promptTokens + response.completionTokens
      : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: response.tokens ?? derivedTotal,
  };
}

function resolveOutputContract(
  options: GovernedModelCallOptions,
): OutputContract | undefined {
  if (!options.outputContract) return undefined;
  const contract = OutputContractSchema.parse(options.outputContract);
  if (
    options.responseFormat !== undefined &&
    options.responseFormat !== contract.mode
  ) {
    throw new StructuredOutputError(
      "invalid_output_contract",
      "responseFormat conflicts with outputContract.mode",
    );
  }
  return contract;
}

function applyOutputContract(
  response: ProviderResponse,
  contract: OutputContract | undefined,
): ProviderResponse {
  if (!contract || contract.mode === "text") return response;
  const structured = JsonValueSchema.parse(
    enforceStructuredOutput(response.text, contract),
  );
  return {
    ...response,
    structuredOutput: structured,
  };
}

export async function executeGovernedModelCall(
  options: GovernedModelCallOptions,
): Promise<{
  response: ProviderResponse;
  usageEventId: string;
  costMicrousd: number;
  budgetBreached: boolean;
  overReservation: boolean;
}> {
  const now = options.now ?? new Date();
  const generate = options.generate ?? generateWithProvider;
  const costResolver = options.costResolver ?? resolveRegistryModelCost;
  const outputContract = resolveOutputContract(options);
  const responseFormat = outputContract?.mode ?? options.responseFormat;
  const costEvidence = costResolver(options.provider, options.model);
  const budgetPolicy = await db.budgetPolicy.findUnique({
    where: { tenantId: options.tenantId },
  });

  if (
    budgetPolicy?.enforcementMode === "hard" &&
    (budgetPolicy.monthlyLimitMicrousd !== null ||
      budgetPolicy.perRequestLimitMicrousd !== null) &&
    costEvidence === null
  ) {
    throw new UsageLedgerError(
      "cost_evidence_missing",
      "hard budget enforcement requires integrity-reviewed model price evidence",
    );
  }

  const estimatedTokens = estimateTokenUpperBound(options.messages);
  const estimatedCostMicrousd =
    costEvidence === null
      ? 0
      : estimateModelCostMicrousd(
          estimatedTokens,
          costEvidence.unitCostMicrousdPer1k,
        );

  const reservation = budgetPolicy
    ? await reserveSpend(
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          requestId: options.requestId,
          idempotencyKey: `model-reserve:${options.taskId}`,
          estimatedCostMicrousd,
          ttlSeconds: Math.min(
            3600,
            Math.max(30, Math.ceil(env.MODEL_REQUEST_TIMEOUT_MS / 1000) + 30),
          ),
        },
        now,
      )
    : null;

  const startedAt = Date.now();
  let response: ProviderResponse;
  try {
    response = await generate({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      responseFormat,
      maxOutputTokens: env.MODEL_MAX_OUTPUT_TOKENS,
      timeoutMs: env.MODEL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
      tools: options.tools,
      toolChoice: options.toolChoice,
    });
  } catch (error) {
    if (reservation) {
      try {
        await releaseSpend({
          tenantId: options.tenantId,
          reservationId: reservation.reservation.id,
          actorId: options.actorId,
          reason:
            "model dispatch failed before a metered response was available",
        });
      } catch {
        // Preserve the original provider failure. Reservation expiry is the
        // fail-safe recovery path if release itself cannot be persisted.
      }
    }
    throw error;
  }

  let outputValidationError: unknown;
  try {
    response = applyOutputContract(response, outputContract);
  } catch (error) {
    outputValidationError = error;
  }

  const latencyMs = Math.max(0, Date.now() - startedAt);
  const tokens = providerTokenBreakdown(response);
  const chargeableTokens = tokens.totalTokens ?? estimatedTokens;
  const actualCostMicrousd =
    costEvidence === null
      ? 0
      : estimateModelCostMicrousd(
          chargeableTokens,
          costEvidence.unitCostMicrousdPer1k,
        );
  const occurredAt = new Date().toISOString();
  const metadata = {
    cost_evidence:
      costEvidence === null ? "unavailable" : "governed_model_registry",
    token_evidence:
      tokens.totalTokens === null ? "conservative_upper_bound" : "provider",
    response_format: responseFormat ?? "text",
    output_validation:
      outputContract === undefined
        ? "not_requested"
        : outputValidationError
          ? "failed"
          : "passed",
    tool_call_count: response.toolCalls?.length ?? 0,
  };

  if (reservation) {
    const committed = await commitSpend({
      tenantId: options.tenantId,
      reservationId: reservation.reservation.id,
      idempotencyKey: `model-usage:${options.taskId}`,
      actorId: options.actorId,
      runId: options.runId,
      category: "model",
      provider: options.provider,
      model: options.model,
      modelRegistryId: costEvidence?.modelRegistryId,
      expertSlug: options.expertSlug,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      latencyMs,
      actualCostMicrousd,
      billableMetric: "model_request",
      billableUnits: 1,
      metadata,
      occurredAt,
    });
    if (outputValidationError) throw outputValidationError;
    return {
      response,
      usageEventId: committed.event.id,
      costMicrousd: actualCostMicrousd,
      budgetBreached: committed.budgetBreached,
      overReservation: committed.overReservation,
    };
  }

  const recorded = await recordUnreservedUsage({
    tenantId: options.tenantId,
    requestId: options.requestId,
    idempotencyKey: `model-usage:${options.taskId}`,
    actorId: options.actorId,
    runId: options.runId,
    category: "model",
    provider: options.provider,
    model: options.model,
    modelRegistryId: costEvidence?.modelRegistryId,
    expertSlug: options.expertSlug,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    latencyMs,
    actualCostMicrousd,
    billableMetric: "model_request",
    billableUnits: 1,
    metadata,
    occurredAt,
  });
  if (outputValidationError) throw outputValidationError;
  return {
    response,
    usageEventId: recorded.event.id,
    costMicrousd: actualCostMicrousd,
    budgetBreached: false,
    overReservation: false,
  };
}
