import type { JsonValue } from "@/lib/types";

export const MEMORY_POLICY_VERSION = "raeburnai.memory-policy.v1" as const;

export type MemoryFindingType =
  | "credential"
  | "email"
  | "phone"
  | "payment_card"
  | "national_id";

export type MemoryClassification = "general" | "personal" | "sensitive";

export class MemoryPolicyError extends Error {
  constructor(
    public readonly code:
      | "private_key_not_allowed"
      | "high_risk_personal_data_not_allowed",
  ) {
    super(code);
    this.name = "MemoryPolicyError";
  }
}

const HIGH_RISK_LABELS = new Set([
  "biometric",
  "criminal_record",
  "genetic",
  "health",
  "political_opinion",
  "race_ethnicity",
  "religion",
  "sex_life",
  "sexual_orientation",
  "trade_union",
]);

const CREDENTIAL_KEY = /^(?:api[_-]?key|authorization|cookie|password|refresh[_-]?token|secret|token)$/i;
const EMAIL_KEY = /^(?:email|email_address)$/i;
const PHONE_KEY = /^(?:mobile|mobile_number|phone|phone_number|telephone)$/i;
const PAYMENT_KEY = /^(?:card|card_number|credit_card|debit_card|pan)$/i;
const NATIONAL_ID_KEY = /^(?:national_id|national_insurance|ni_number|social_security|ssn)$/i;
const HIGH_RISK_KEY =
  /(?:^|_)(?:biometric|criminal(?:_record)?|diagnosis|genetic|health|medical|political(?:_opinion)?|race|ethnicity|religion|sex_life|sexual_orientation|trade_union)(?:$|_)/i;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
const NI_PATTERN = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*([^\s,;]{6,})/gi;
const PHONE_PATTERN = /\+?\d[\d ()-]{8,}\d/g;
const CARD_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

interface MutableFindings {
  counts: Map<MemoryFindingType, number>;
}

export interface SanitizedMemoryCandidate {
  content: string;
  metadata: Record<string, JsonValue>;
  classification: MemoryClassification;
  findingTypes: MemoryFindingType[];
  redactionCount: number;
  sensitivityLabels: string[];
}

function recordFinding(findings: MutableFindings, type: MemoryFindingType): void {
  findings.counts.set(type, (findings.counts.get(type) ?? 0) + 1);
}

function redactPattern(
  value: string,
  pattern: RegExp,
  replacement: string,
  type: MemoryFindingType,
  findings: MutableFindings,
): string {
  return value.replace(pattern, (match) => {
    recordFinding(findings, type);
    return replacement || match;
  });
}

function hasPrivateKey(value: string): boolean {
  const upper = value.toUpperCase();
  return upper.includes("-----BEGIN ") && upper.includes("PRIVATE KEY-----");
}

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (!Number.isInteger(digit)) return false;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function redactPaymentCards(
  value: string,
  findings: MutableFindings,
): string {
  return value.replace(CARD_PATTERN, (candidate) => {
    const digits = candidate.replace(/[^0-9]/g, "");
    if (!luhnValid(digits)) return candidate;
    recordFinding(findings, "payment_card");
    return "[REDACTED:PAYMENT_CARD]";
  });
}

function redactCredentials(
  value: string,
  findings: MutableFindings,
): string {
  let next = redactPattern(
    value,
    BEARER_PATTERN,
    "Bearer [REDACTED:CREDENTIAL]",
    "credential",
    findings,
  );
  next = redactPattern(
    next,
    OPENAI_KEY_PATTERN,
    "[REDACTED:CREDENTIAL]",
    "credential",
    findings,
  );
  next = redactPattern(
    next,
    GITHUB_TOKEN_PATTERN,
    "[REDACTED:CREDENTIAL]",
    "credential",
    findings,
  );
  next = redactPattern(
    next,
    AWS_ACCESS_KEY_PATTERN,
    "[REDACTED:CREDENTIAL]",
    "credential",
    findings,
  );
  return next.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, label: string) => {
      recordFinding(findings, "credential");
      return `${label}=[REDACTED:CREDENTIAL]`;
    },
  );
}

function sanitizeString(value: string, findings: MutableFindings): string {
  if (hasPrivateKey(value)) {
    throw new MemoryPolicyError("private_key_not_allowed");
  }

  let next = redactCredentials(value, findings);
  next = redactPaymentCards(next, findings);
  next = redactPattern(
    next,
    NI_PATTERN,
    "[REDACTED:NATIONAL_ID]",
    "national_id",
    findings,
  );
  next = redactPattern(
    next,
    EMAIL_PATTERN,
    "[REDACTED:EMAIL]",
    "email",
    findings,
  );
  next = next.replace(PHONE_PATTERN, (candidate) => {
    const digits = candidate.replace(/[^0-9]/g, "");
    if (digits.length < 10 || digits.length > 15) return candidate;
    recordFinding(findings, "phone");
    return "[REDACTED:PHONE]";
  });
  return next;
}

function assertNoStructuredHighRiskData(value: JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoStructuredHighRiskData);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (HIGH_RISK_KEY.test(key) && item !== null) {
      throw new MemoryPolicyError("high_risk_personal_data_not_allowed");
    }
    assertNoStructuredHighRiskData(item);
  }
}

function findingForMetadataKey(key: string): MemoryFindingType | undefined {
  if (CREDENTIAL_KEY.test(key)) return "credential";
  if (PAYMENT_KEY.test(key)) return "payment_card";
  if (NATIONAL_ID_KEY.test(key)) return "national_id";
  if (EMAIL_KEY.test(key)) return "email";
  if (PHONE_KEY.test(key)) return "phone";
  return undefined;
}

function sanitizeJson(
  value: JsonValue,
  findings: MutableFindings,
): JsonValue {
  if (typeof value === "string") return sanitizeString(value, findings);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item, findings));
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const keyedFinding = findingForMetadataKey(key);
      if (keyedFinding && item !== null) {
        recordFinding(findings, keyedFinding);
        sanitized[key] = `[REDACTED:${keyedFinding.toUpperCase()}]`;
      } else {
        sanitized[key] = sanitizeJson(item, findings);
      }
    }
    return sanitized;
  }
  return value;
}

function classificationFor(
  findingTypes: MemoryFindingType[],
): MemoryClassification {
  if (
    findingTypes.some((type) =>
      ["credential", "payment_card", "national_id"].includes(type),
    )
  ) {
    return "sensitive";
  }
  if (findingTypes.length > 0) return "personal";
  return "general";
}

export function sanitizeMemoryCandidate(input: {
  content: string;
  metadata: Record<string, JsonValue>;
  sensitivityLabels?: string[];
}): SanitizedMemoryCandidate {
  const sensitivityLabels = [
    ...new Set(
      (input.sensitivityLabels ?? [])
        .map((label) => label.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  if (sensitivityLabels.some((label) => HIGH_RISK_LABELS.has(label))) {
    throw new MemoryPolicyError("high_risk_personal_data_not_allowed");
  }

  assertNoStructuredHighRiskData(input.metadata);
  const findings: MutableFindings = { counts: new Map() };
  const content = sanitizeString(input.content, findings);
  const metadataValue = sanitizeJson(input.metadata, findings);
  const metadata =
    metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
      ? metadataValue
      : {};
  const findingTypes = [...findings.counts.keys()].sort();
  const redactionCount = [...findings.counts.values()].reduce(
    (total, count) => total + count,
    0,
  );

  return {
    content,
    metadata,
    classification: classificationFor(findingTypes),
    findingTypes,
    redactionCount,
    sensitivityLabels,
  };
}
