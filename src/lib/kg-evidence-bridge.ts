import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TrustedEvidenceSourceSchema,
  evidenceSourceContentHash,
  type TrustedEvidenceSource,
} from "@/lib/evidence-verification";

export const KG_EVIDENCE_EXPORT_VERSION =
  "raeburnai.kg-evidence-export.v1" as const;

const KgEvidenceSecuritySchema = z.object({
  trust: z.literal("untrusted"),
  instruction_authority: z.literal("none"),
  handling: z.literal("data-only"),
  injection_detected: z.boolean(),
  signals: z.array(z.string().min(1).max(256)).max(64),
});

const KgEvidenceSourceSchema = z.object({
  id: z.string().min(1).max(256),
  uri: z.string().min(1).max(2048),
  title: z.string().min(1).max(512),
  source_type: z.enum(["primary", "secondary", "internal", "unknown"]),
  retrieved_at: z.string().datetime({ offset: true }),
  workspace_id: z.string().min(1).max(128),
  document_id: z.string().min(1).max(256),
  document_version: z.string().min(1).max(512),
  chunk_id: z.string().min(1).max(256),
  excerpt: z.string().min(1).max(20_000),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  page_start: z.number().int().min(1).nullable(),
  page_end: z.number().int().min(1).nullable(),
  source_acl_ref: z.string().max(512).nullable(),
  security: KgEvidenceSecuritySchema,
});

export const KgEvidenceExportSchema = z.object({
  contract_version: z.literal(KG_EVIDENCE_EXPORT_VERSION),
  workspace_id: z.string().min(1).max(128),
  query: z.string().min(1).max(8_000),
  retrieved_at: z.string().datetime({ offset: true }),
  sources: z.array(KgEvidenceSourceSchema).max(50),
  bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type KgEvidenceExport = z.infer<typeof KgEvidenceExportSchema>;

export class KgEvidenceBridgeError extends Error {
  constructor(
    public readonly code:
      | "bundle_integrity_invalid"
      | "source_integrity_invalid"
      | "workspace_mismatch"
      | "query_mismatch"
      | "result_limit_exceeded"
      | "duplicate_source_id",
    public readonly detail?: string,
  ) {
    super(detail ? code + ": " + detail : code);
    this.name = "KgEvidenceBridgeError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, item]) =>
            JSON.stringify(key) + ":" + canonicalJson(item),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function bundlePayload(bundle: KgEvidenceExport) {
  return {
    contract_version: bundle.contract_version,
    workspace_id: bundle.workspace_id,
    query: bundle.query,
    retrieved_at: bundle.retrieved_at,
    sources: bundle.sources.map((source) => ({
      id: source.id,
      uri: source.uri,
      title: source.title,
      source_type: source.source_type,
      retrieved_at: source.retrieved_at,
      workspace_id: source.workspace_id,
      document_id: source.document_id,
      document_version: source.document_version,
      chunk_id: source.chunk_id,
      excerpt: source.excerpt,
      content_hash: source.content_hash,
      page_start: source.page_start,
      page_end: source.page_end,
      source_acl_ref: source.source_acl_ref,
      security: source.security,
    })),
  };
}

export function kgEvidenceBundleDigest(bundle: KgEvidenceExport): string {
  return createHash("sha256")
    .update(canonicalJson(bundlePayload(bundle)))
    .digest("hex");
}

export function parseKgEvidenceExport(
  input: unknown,
  expectedWorkspaceId?: string,
  expectedQuery?: string,
  expectedLimit?: number,
): {
  bundle: KgEvidenceExport;
  trustedSources: TrustedEvidenceSource[];
} {
  const bundle = KgEvidenceExportSchema.parse(input);
  if (expectedWorkspaceId && bundle.workspace_id !== expectedWorkspaceId) {
    throw new KgEvidenceBridgeError(
      "workspace_mismatch",
      "expected " +
        expectedWorkspaceId +
        ", received " +
        bundle.workspace_id,
    );
  }
  if (expectedQuery !== undefined && bundle.query !== expectedQuery) {
    throw new KgEvidenceBridgeError(
      "query_mismatch",
      "Knowledge Graph response query does not match the request",
    );
  }
  if (
    expectedLimit !== undefined &&
    bundle.sources.length > expectedLimit
  ) {
    throw new KgEvidenceBridgeError(
      "result_limit_exceeded",
      "Knowledge Graph returned " +
        bundle.sources.length +
        " sources for requested limit " +
        expectedLimit,
    );
  }
  if (kgEvidenceBundleDigest(bundle) !== bundle.bundle_sha256) {
    throw new KgEvidenceBridgeError("bundle_integrity_invalid");
  }

  const seen = new Set<string>();
  const trustedSources = bundle.sources.map((source) => {
    if (seen.has(source.id)) {
      throw new KgEvidenceBridgeError("duplicate_source_id", source.id);
    }
    seen.add(source.id);

    if (source.workspace_id !== bundle.workspace_id) {
      throw new KgEvidenceBridgeError(
        "workspace_mismatch",
        "source " +
          source.id +
          " belongs to " +
          source.workspace_id,
      );
    }
    if (evidenceSourceContentHash(source.excerpt) !== source.content_hash) {
      throw new KgEvidenceBridgeError("source_integrity_invalid", source.id);
    }

    return TrustedEvidenceSourceSchema.parse({
      id: source.id,
      uri: source.uri,
      title: source.title,
      sourceType: source.source_type,
      retrievedAt: source.retrieved_at,
      documentId: source.document_id,
      documentVersion: source.document_version,
      chunkId: source.chunk_id,
      excerpt: source.excerpt,
      contentHash: source.content_hash,
      pageStart: source.page_start,
      pageEnd: source.page_end,
      sourceAclRef: source.source_acl_ref,
      retrievalSecurity: {
        trust: source.security.trust,
        instructionAuthority: source.security.instruction_authority,
        handling: source.security.handling,
        injectionDetected: source.security.injection_detected,
        signals: source.security.signals,
      },
    });
  });

  return { bundle, trustedSources };
}
