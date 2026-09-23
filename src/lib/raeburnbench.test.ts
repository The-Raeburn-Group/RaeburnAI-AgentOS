import { describe, expect, it } from "vitest";
import candidateFixture from "../../benchmarks/candidates/reference.v0.json";
import corpusFixture from "../../benchmarks/raeburnbench.seed.v0.json";
import {
  RaeburnBenchCandidateSchema,
  RaeburnBenchError,
  evaluateRaeburnBench,
  verifyRaeburnBenchResultIntegrity,
} from "@/lib/raeburnbench";

describe("RaeburnBench", () => {
  it("scores the deterministic reference fixture across every seed suite", () => {
    const result = evaluateRaeburnBench(corpusFixture, candidateFixture);

    expect(result.gate).toEqual({
      status: "pass",
      absoluteFailures: [],
      regressionFailures: [],
    });
    expect(result.caseResults).toHaveLength(25);
    expect(result.caseResults.every((item) => item.passed)).toBe(true);
    expect(result.overallScore).toBe(1);
    expect(result.suiteScores).toEqual({
      domain: 1,
      hallucination: 1,
      citation: 1,
      routing: 1,
      prompt_injection: 1,
    });
    expect(result.corpus.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyRaeburnBenchResultIntegrity(result)).toEqual(result);
  });

  it("is byte-input independent and produces deterministic digests", () => {
    const first = evaluateRaeburnBench(corpusFixture, candidateFixture);
    const second = evaluateRaeburnBench(
      JSON.parse(JSON.stringify(corpusFixture)),
      JSON.parse(JSON.stringify(candidateFixture)),
    );

    expect(second.corpus.digest).toBe(first.corpus.digest);
    expect(second.artifactDigest).toBe(first.artifactDigest);
    expect(second).toEqual(first);
  });

  it("fails the absolute gate when a candidate omits a case", () => {
    const candidate = structuredClone(candidateFixture);
    candidate.outputs = candidate.outputs.filter(
      (item) => item.caseId !== "security.injection.exfiltrate.001",
    );

    const result = evaluateRaeburnBench(corpusFixture, candidate);
    const missing = result.caseResults.find(
      (item) => item.caseId === "security.injection.exfiltrate.001",
    );

    expect(missing).toMatchObject({
      score: 0,
      passed: false,
      reasons: ["candidate output missing"],
    });
    expect(result.gate.status).toBe("fail");
    expect(result.gate.absoluteFailures).toContain(
      "prompt_injection score 0.8 is below 1",
    );
  });

  it("rejects duplicate and unknown candidate case identifiers", () => {
    const duplicate = structuredClone(candidateFixture);
    duplicate.outputs.push(structuredClone(duplicate.outputs[0]));
    expect(() => RaeburnBenchCandidateSchema.parse(duplicate)).toThrow(
      "duplicate candidate output",
    );

    const unknown = structuredClone(candidateFixture);
    unknown.outputs[0].caseId = "unknown.case";
    expect(() => evaluateRaeburnBench(corpusFixture, unknown)).toThrowError(
      new RaeburnBenchError("candidate_unknown_case"),
    );
  });

  it("detects a regression even when the absolute domain floor still passes", () => {
    const baseline = evaluateRaeburnBench(corpusFixture, candidateFixture);
    const candidate = structuredClone(candidateFixture);
    const output = candidate.outputs.find(
      (item) => item.caseId === "domain.software.001",
    );
    if (!output) throw new Error("fixture output missing");
    output.answer = "Retry the request normally.";

    const result = evaluateRaeburnBench(corpusFixture, candidate, baseline);

    expect(result.suiteScores.domain).toBe(0.8);
    expect(result.gate.absoluteFailures).toEqual([]);
    expect(result.gate.regressionFailures).toContain(
      "domain score regressed from 1 to 0.8",
    );
    expect(result.gate.status).toBe("fail");
  });

  it("refuses stale or tampered baseline artifacts", () => {
    const baseline = evaluateRaeburnBench(corpusFixture, candidateFixture);
    const changedCorpus = structuredClone(corpusFixture);
    changedCorpus.version = "0.1.1";

    expect(() =>
      evaluateRaeburnBench(changedCorpus, candidateFixture, baseline),
    ).toThrowError(new RaeburnBenchError("baseline_corpus_mismatch"));

    const tampered = structuredClone(baseline);
    tampered.overallScore = 0.5;
    expect(() =>
      evaluateRaeburnBench(corpusFixture, candidateFixture, tampered),
    ).toThrowError(new RaeburnBenchError("baseline_integrity_invalid"));
  });

  it("penalizes missing evidence citations independently of answer wording", () => {
    const candidate = structuredClone(candidateFixture);
    const output = candidate.outputs.find(
      (item) => item.caseId === "citation.corroborated.001",
    );
    if (!output) throw new Error("fixture output missing");
    output.citations = ["ops"];

    const result = evaluateRaeburnBench(corpusFixture, candidate);
    const citation = result.caseResults.find(
      (item) => item.caseId === "citation.corroborated.001",
    );

    expect(citation?.passed).toBe(false);
    expect(citation?.reasons).toContain("required citation missing: status");
    expect(citation?.score).toBeLessThan(1);
  });

  it("penalizes fabricated extra citations even when required citations are present", () => {
    const candidate = structuredClone(candidateFixture);
    const output = candidate.outputs.find(
      (item) => item.caseId === "citation.primary.001",
    );
    if (!output) throw new Error("fixture output missing");
    output.citations = ["policy", "fabricated-source"];

    const result = evaluateRaeburnBench(corpusFixture, candidate);
    const citation = result.caseResults.find(
      (item) => item.caseId === "citation.primary.001",
    );

    expect(citation?.passed).toBe(false);
    expect(citation?.reasons).toContain(
      "unsupported citation: fabricated-source",
    );
    expect(citation?.score).toBeLessThan(1);
  });

  it("does not allow atomic expected values to pass as substrings", () => {
    const candidate = structuredClone(candidateFixture);
    const statusOutput = candidate.outputs.find(
      (item) => item.caseId === "hallucination.supported.001",
    );
    const calculationOutput = candidate.outputs.find(
      (item) => item.caseId === "hallucination.calculation.001",
    );
    if (!statusOutput || !calculationOutput) {
      throw new Error("fixture output missing");
    }
    statusOutput.answer = "INACTIVE";
    calculationOutput.answer = "125";

    const result = evaluateRaeburnBench(corpusFixture, candidate);
    const statusCase = result.caseResults.find(
      (item) => item.caseId === "hallucination.supported.001",
    );
    const calculationCase = result.caseResults.find(
      (item) => item.caseId === "hallucination.calculation.001",
    );

    expect(statusCase?.passed).toBe(false);
    expect(statusCase?.reasons).toContain(
      "supported answer phrase missing: ACTIVE",
    );
    expect(calculationCase?.passed).toBe(false);
    expect(calculationCase?.reasons).toContain(
      "supported answer phrase missing: 25",
    );
    expect(result.gate.status).toBe("fail");
  });

  it("keeps the benign quoted-instruction control distinct from an attack", () => {
    const result = evaluateRaeburnBench(corpusFixture, candidateFixture);
    const benign = result.caseResults.find(
      (item) => item.caseId === "security.injection.quoted.001",
    );
    const attack = result.caseResults.find(
      (item) => item.caseId === "security.injection.exfiltrate.001",
    );

    expect(benign).toMatchObject({ passed: true, score: 1 });
    expect(attack).toMatchObject({ passed: true, score: 1 });
  });

  it("rejects a corpus whose provenance no longer permits evaluation", () => {
    const corpus = structuredClone(corpusFixture);
    corpus.cases[0].record.provenance.permittedPurposes = ["training"];

    expect(() => evaluateRaeburnBench(corpus, candidateFixture)).toThrow(
      "purpose_not_permitted",
    );
  });
});
