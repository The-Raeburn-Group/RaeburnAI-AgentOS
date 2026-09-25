import { describe, expect, it, vi } from "vitest";
import {
  KgEvidenceClientError,
  retrieveKnowledgeEvidence,
} from "@/lib/kg-evidence-client";

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
} as const;

describe("Knowledge Graph evidence client", () => {
  it("propagates delegated context and returns verified trusted sources", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://kg.example.test/base/v1/search/evidence",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-workspace-id": "tenant-a",
        "x-actor-id": "actor-a",
        "x-actor-roles": "researcher,auditor",
        "x-actor-groups": "team-alpha",
        "x-api-key": "kg-secret",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        workspace_id: "tenant-a",
        query: "approved control threshold",
        retrieval_mode: "hybrid",
        include_graph: false,
        graph_depth: 0,
      });
      return new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await retrieveKnowledgeEvidence(
      {
        workspaceId: "tenant-a",
        actorId: "actor-a",
        roles: ["researcher", "auditor"],
        groups: ["team-alpha"],
        query: "approved control threshold",
      },
      {
        env: {
          NODE_ENV: "production",
          RAEBURN_KG_BASE_URL: "https://kg.example.test/base",
          RAEBURN_KG_API_KEY: "kg-secret",
        },
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(result.trustedSources).toHaveLength(1);
    expect(result.trustedSources[0]?.documentVersion).toBe("revision-7");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing production credentials or insecure production URLs", async () => {
    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          query: "approved control threshold",
        },
        {
          env: {
            NODE_ENV: "production",
            RAEBURN_KG_BASE_URL: "https://kg.example.test",
          },
          fetchImpl: vi.fn() as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "unconfigured" });

    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          query: "approved control threshold",
        },
        {
          env: {
            NODE_ENV: "production",
            RAEBURN_KG_BASE_URL: "http://kg.example.test",
            RAEBURN_KG_API_KEY: "secret",
          },
          fetchImpl: vi.fn() as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "insecure_base_url" });
  });

  it("rejects delegated header injection and ambiguous role values before network I/O", async () => {
    const fetchImpl = vi.fn();

    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a\nspoofed",
          query: "approved control threshold",
        },
        {
          env: { RAEBURN_KG_BASE_URL: "http://localhost:8000" },
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          roles: ["researcher,admin"],
          query: "approved control threshold",
        },
        {
          env: { RAEBURN_KG_BASE_URL: "http://localhost:8000" },
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-2xx and integrity-invalid Knowledge Graph responses", async () => {
    const notFound = vi.fn(async () => new Response("missing", { status: 404 }));
    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          query: "approved control threshold",
        },
        {
          env: { RAEBURN_KG_BASE_URL: "http://localhost:8000" },
          fetchImpl: notFound as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "request_failed" });

    const tampered = structuredClone(FIXTURE);
    tampered.sources[0].excerpt = "Tampered text";
    const badBundle = vi.fn(
      async () =>
        new Response(JSON.stringify(tampered), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          query: "approved control threshold",
        },
        {
          env: { RAEBURN_KG_BASE_URL: "http://localhost:8000" },
          fetchImpl: badBundle as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("enforces a bounded timeout", async () => {
    const hangingFetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    await expect(
      retrieveKnowledgeEvidence(
        {
          workspaceId: "tenant-a",
          actorId: "actor-a",
          query: "approved control threshold",
          timeoutMs: 100,
        },
        {
          env: { RAEBURN_KG_BASE_URL: "http://localhost:8000" },
          fetchImpl: hangingFetch as unknown as typeof fetch,
        },
      ),
    ).rejects.toEqual(new KgEvidenceClientError("request_timeout"));
  });
});
