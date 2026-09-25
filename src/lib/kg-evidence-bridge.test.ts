import { describe, expect, it } from "vitest";
import {
  KgEvidenceBridgeError,
  kgEvidenceBundleDigest,
  parseKgEvidenceExport,
} from "@/lib/kg-evidence-bridge";

const FIXTURE = {
  contract_version: "raeburnai.kg-evidence-export.v1",
  workspace_id: "tenant-a",
  query: "approved control threshold",
  retrieved_at: "2026-09-25T18:00:00Z",
  sources: [
    {
      id: "chunk-1",
      uri: "https://example.test/policy",
      title: "Approved policy",
      source_type: "primary",
      retrieved_at: "2026-09-25T18:00:00Z",
      workspace_id: "tenant-a",
      document_id: "doc-1",
      document_version: "revision-7",
      chunk_id: "chunk-1",
      excerpt: "The approved control threshold is 75 percent.",
      content_hash:
        "105e8d8a4f05b8f4de9ec72d3580c5406c8a9dde3525fe53c20c6f893fffe8ae",
      source_acl_ref: null,
    },
  ],
  bundle_sha256:
    "a50b20a5f87e8c219bddadefb06cab41d67ffac316d2dc7f054c3843fae57057",
} as const;

describe("Knowledge Graph evidence bridge", () => {
  it("accepts the independently generated cross-language contract fixture", () => {
    const parsed = parseKgEvidenceExport(FIXTURE, "tenant-a");

    expect(kgEvidenceBundleDigest(parsed.bundle)).toBe(
      FIXTURE.bundle_sha256,
    );
    expect(parsed.trustedSources).toEqual([
      {
        id: "chunk-1",
        uri: "https://example.test/policy",
        title: "Approved policy",
        sourceType: "primary",
        retrievedAt: "2026-09-25T18:00:00Z",
        documentId: "doc-1",
        documentVersion: "revision-7",
        chunkId: "chunk-1",
        excerpt: "The approved control threshold is 75 percent.",
        contentHash:
          "105e8d8a4f05b8f4de9ec72d3580c5406c8a9dde3525fe53c20c6f893fffe8ae",
      },
    ]);
  });

  it("rejects bundle transport tampering", () => {
    const tampered = structuredClone(FIXTURE) as Record<string, unknown>;
    tampered.query = "tampered query";

    expect(() => parseKgEvidenceExport(tampered, "tenant-a")).toThrowError(
      new KgEvidenceBridgeError("bundle_integrity_invalid"),
    );
  });

  it("rejects source excerpt tampering even when a forged bundle digest is supplied", () => {
    const tampered = structuredClone(FIXTURE);
    tampered.sources[0].excerpt = "The approved control threshold is 10 percent.";
    tampered.bundle_sha256 = kgEvidenceBundleDigest(tampered);

    expect(() => parseKgEvidenceExport(tampered, "tenant-a")).toThrowError(
      new KgEvidenceBridgeError("source_integrity_invalid", "chunk-1"),
    );
  });

  it("rejects workspace drift at bundle and source level", () => {
    expect(() => parseKgEvidenceExport(FIXTURE, "tenant-b")).toThrowError(
      KgEvidenceBridgeError,
    );

    const drifted = structuredClone(FIXTURE);
    drifted.sources[0].workspace_id = "tenant-b";
    drifted.bundle_sha256 = kgEvidenceBundleDigest(drifted);

    expect(() => parseKgEvidenceExport(drifted, "tenant-a")).toThrowError(
      KgEvidenceBridgeError,
    );
  });

  it("accepts stable Knowledge Graph URNs when an external source URI is unavailable", () => {
    const urnFixture = structuredClone(FIXTURE);
    urnFixture.sources[0].uri =
      "urn:raeburnai:kg:tenant-a:doc-1:chunk-1";
    urnFixture.bundle_sha256 = kgEvidenceBundleDigest(urnFixture);

    const parsed = parseKgEvidenceExport(urnFixture, "tenant-a");
    expect(parsed.trustedSources[0]?.uri).toBe(
      "urn:raeburnai:kg:tenant-a:doc-1:chunk-1",
    );
  });
});
