import { createHash } from "node:crypto";
import { z } from "zod";
import {
  TrustedEvidenceSourceSchema,
  evidenceSourceContentHash,
  type TrustedEvidenceSource,
} from "@/lib/evidence-verification";

export const KG_EVIDENCE_EXPORT_VERSION =
  "raeburnai.kg-evidence-export.v1" as const;

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
  source_acl_ref: z.string().max(512).nullable().default(null),
});

export const KgEvidenceExportSchema = z.object({
  contract_version: z.literal(KG_EVIDENCE_EXPORT_VERSION),
  workspace_id: z.string().min(1).max(128),
  query: z.string().min(1).max(8_000),
  retrieved_at: z.string().datetime({ offset: true }),
  sources: z.array(KgEvidenceSourceSchema),
  bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type KgEvidenceExport = z.infer<typeof KgEvidenceExportSchema>;

export class KgEvidenceBridgeError extends Error {
  constructor(
    public readonly code:
      | "bundle_integrity_invalid"
      | "source_integrity_invalid"
      | "workspace_mismatch"
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
      source_acl_ref: source.source_acl_ref,
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
    });
  });

  return { bundle, trustedSources };
}
