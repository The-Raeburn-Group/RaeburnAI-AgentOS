import {
  parseKgEvidenceExport,
  type KgEvidenceExport,
} from "@/lib/kg-evidence-bridge";
import type { TrustedEvidenceSource } from "@/lib/evidence-verification";

type Environment = Readonly<Record<string, string | undefined>>;

export interface KgEvidenceClientRequest {
  workspaceId: string;
  actorId: string;
  query: string;
  roles?: string[];
  groups?: string[];
  limit?: number;
  retrievalMode?: "vector" | "lexical" | "hybrid";
  candidateMultiplier?: number;
  rerank?: boolean;
  graphDepth?: number;
  includeGraph?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface KgEvidenceClientResult {
  bundle: KgEvidenceExport;
  trustedSources: TrustedEvidenceSource[];
}

export class KgEvidenceClientError extends Error {
  constructor(
    public readonly code:
      | "unconfigured"
      | "invalid_base_url"
      | "insecure_base_url"
      | "request_failed"
      | "request_timeout"
      | "invalid_response",
    public readonly detail?: string,
  ) {
    super(detail ? code + ": " + detail : code);
    this.name = "KgEvidenceClientError";
  }
}

function configured(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function kgBaseUrl(env: Environment): URL {
  const raw = configured(env.RAEBURN_KG_BASE_URL);
  if (!raw) throw new KgEvidenceClientError("unconfigured", "RAEBURN_KG_BASE_URL");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KgEvidenceClientError("invalid_base_url");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new KgEvidenceClientError("invalid_base_url", "protocol must be http or https");
  }
  if (url.username || url.password) {
    throw new KgEvidenceClientError("invalid_base_url", "credentials are not allowed in URL");
  }
  if (
    env.NODE_ENV === "production" &&
    url.protocol !== "https:"
  ) {
    throw new KgEvidenceClientError("insecure_base_url");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  url.search = "";
  url.hash = "";
  return url;
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new KgEvidenceClientError(
      "invalid_response",
      "invalid bounded request option",
    );
  }
  return value;
}

function attachAbort(
  controller: AbortController,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export async function retrieveKnowledgeEvidence(
  request: KgEvidenceClientRequest,
  options: {
    env?: Environment;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<KgEvidenceClientResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = kgBaseUrl(env);
  const endpoint = new URL("v1/search/evidence", baseUrl);
  const apiKey = configured(env.RAEBURN_KG_API_KEY);
  if (env.NODE_ENV === "production" && !apiKey) {
    throw new KgEvidenceClientError(
      "unconfigured",
      "RAEBURN_KG_API_KEY is required in production",
    );
  }

  const timeoutMs = boundedInt(request.timeoutMs, 8_000, 100, 60_000);
  const controller = new AbortController();
  const detach = attachAbort(controller, request.signal);
  const timeout = setTimeout(() => controller.abort("kg_request_timeout"), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-id": request.workspaceId,
        "x-actor-id": request.actorId,
        ...(request.roles?.length
          ? { "x-actor-roles": request.roles.join(",") }
          : {}),
        ...(request.groups?.length
          ? { "x-actor-groups": request.groups.join(",") }
          : {}),
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        workspace_id: request.workspaceId,
        query: request.query,
        limit: boundedInt(request.limit, 10, 1, 50),
        include_graph: request.includeGraph ?? false,
        retrieval_mode: request.retrievalMode ?? "hybrid",
        candidate_multiplier: boundedInt(
          request.candidateMultiplier,
          4,
          1,
          10,
        ),
        rerank: request.rerank ?? true,
        graph_depth: boundedInt(request.graphDepth, 0, 0, 3),
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new KgEvidenceClientError(
        "request_failed",
        "Knowledge Graph returned HTTP " + response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new KgEvidenceClientError(
        "invalid_response",
        "Knowledge Graph did not return JSON",
      );
    }

    try {
      return parseKgEvidenceExport(payload, request.workspaceId);
    } catch (error) {
      throw new KgEvidenceClientError(
        "invalid_response",
        error instanceof Error ? error.message : "invalid evidence bundle",
      );
    }
  } catch (error) {
    if (error instanceof KgEvidenceClientError) throw error;
    if (controller.signal.aborted) {
      throw new KgEvidenceClientError("request_timeout");
    }
    throw new KgEvidenceClientError(
      "request_failed",
      error instanceof Error ? error.message : "unknown Knowledge Graph error",
    );
  } finally {
    clearTimeout(timeout);
    detach();
  }
}
