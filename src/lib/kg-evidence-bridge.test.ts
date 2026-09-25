import { describe, expect, it } from "vitest";
import {
  KgEvidenceBridgeError,
  kgEvidenceBundleDigest,
  parseKgEvidenceExport,
  type KgEvidenceExport,
} from "@/lib/kg-evidence-bridge";

const FIXTURE: KgEvidenceExport = {
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
      page_start: null,
      page_end: null,
      source_acl_ref: "drive:file-policy-1:acl-v4",
      security: {
        trust: "untrusted",
        instruction_authority: "none",
        handling: "data-only",
        injection_detected: false,
        signals: [],
      },
    },
  ],
  bundle_sha256:
    "7f3db78a8f63af03766ed94b453e329929dd6f179fa312aa397b96b942dfb84c",
};

describe("Knowledge Graph evidence bridge", () => {
  it("accepts the independently generated cross-language contract fixture", () => {
    const parsed = parseKgEvidenceExport(FIXTURE, "tenant-a");

    expect(kgEvidenceBundleDigest(parsed.bundle)).toBe(FIXTURE.bundle_sha256);
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
        pageStart: null,
        pageEnd: null,
        sourceAclRef: "drive:file-policy-1:acl-v4",
        retrievalSecurity: {
          trust: "untrusted",
          instructionAuthority: "none",
          handling: "data-only",
          injectionDetected: false,
          signals: [],
        },
      },
    ]);
  });

  it("binds the export to the exact requested query and result limit", () => {
    expect(() =>
      parseKgEvidenceExport(FIXTURE, "tenant-a", "different query", 10),
    ).toThrowError(new KgEvidenceBridgeError("query_mismatch"));

    expect(() =>
      parseKgEvidenceExport(
        FIXTURE,
        "tenant-a",
        "approved control threshold",
        0,
      ),
    ).toThrowError(new KgEvidenceBridgeError("result_limit_exceeded"));
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
    tampered.sources[0].excerpt =
      "The approved control threshold is 10 percent.";
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
    urnFixture.sources[0].uri = "urn:raeburnai:kg:tenant-a:doc-1:chunk-1";
    urnFixture.bundle_sha256 = kgEvidenceBundleDigest(urnFixture);

    const parsed = parseKgEvidenceExport(urnFixture, "tenant-a");
    expect(parsed.trustedSources[0]?.uri).toBe(
      "urn:raeburnai:kg:tenant-a:doc-1:chunk-1",
    );
  });
});
