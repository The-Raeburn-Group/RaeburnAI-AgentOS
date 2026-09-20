import { describe, expect, it } from "vitest";
import {
  MemoryPolicyError,
  sanitizeMemoryCandidate,
} from "@/lib/memory-policy";

describe("memory redaction policy", () => {
  it("redacts credentials and direct identifiers from content and nested metadata", () => {
    const result = sanitizeMemoryCandidate({
      content:
        "Email alice@example.com, phone +44 7700 900123, NI AB 12 34 56 C, " +
        "card 4111 1111 1111 1111, token ghp_123456789012345678901234567890.",
      metadata: {
        profile: {
          email: "alice@example.com",
          phone_number: "+44 7700 900123",
        },
        authorization: "Bearer very-secret-access-token",
      },
      sensitivityLabels: ["customer-contact"],
    });

    expect(result.content).not.toContain("alice@example.com");
    expect(result.content).not.toContain("+44 7700 900123");
    expect(result.content).not.toContain("AB 12 34 56 C");
    expect(result.content).not.toContain("4111 1111 1111 1111");
    expect(result.content).not.toContain("ghp_123456789012345678901234567890");
    expect(JSON.stringify(result.metadata)).not.toContain("alice@example.com");
    expect(JSON.stringify(result.metadata)).not.toContain(
      "very-secret-access-token",
    );
    expect(result.findingTypes).toEqual(
      expect.arrayContaining([
        "credential",
        "email",
        "national_id",
        "payment_card",
        "phone",
      ]),
    );
    expect(result.redactionCount).toBeGreaterThanOrEqual(7);
    expect(result.classification).toBe("sensitive");
  });

  it("rejects private keys rather than storing partially redacted key material", () => {
    expect(() =>
      sanitizeMemoryCandidate({
        content:
          "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
        metadata: {},
      }),
    ).toThrowError(new MemoryPolicyError("private_key_not_allowed"));
  });

  it("denies explicitly labelled high-risk personal data by default", () => {
    expect(() =>
      sanitizeMemoryCandidate({
        content: "User supplied a sensitive preference.",
        metadata: {},
        sensitivityLabels: ["Health"],
      }),
    ).toThrowError(
      new MemoryPolicyError("high_risk_personal_data_not_allowed"),
    );
  });

  it("denies structured special-category fields even when the caller omits labels", () => {
    expect(() =>
      sanitizeMemoryCandidate({
        content: "A structured profile was supplied.",
        metadata: {
          profile: {
            health_status: "private",
          },
        },
      }),
    ).toThrowError(
      new MemoryPolicyError("high_risk_personal_data_not_allowed"),
    );
  });

  it("does not redact ordinary numbers that do not satisfy a detector invariant", () => {
    const result = sanitizeMemoryCandidate({
      content: "Order 123456789 and project 20260920 remain searchable.",
      metadata: { order: 123456789 },
    });

    expect(result.content).toContain("123456789");
    expect(result.content).toContain("20260920");
    expect(result.redactionCount).toBe(0);
    expect(result.classification).toBe("general");
  });
});
