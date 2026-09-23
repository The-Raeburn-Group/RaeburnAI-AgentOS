import { describe, expect, it } from "vitest";
import corpus from "../../benchmarks/raeburnbench.seed.v0.json";
import {
  DatasetAdmissibilityError,
  DatasetRecordSchema,
  assertEvaluationRecordAdmissible,
  assertTrainingRecordAdmissible,
  parseDatasetRecordsJsonl,
  serializeDatasetRecordsJsonl,
} from "@/lib/dataset-provenance";

describe("dataset provenance contracts", () => {
  it("accepts every seed record for the purposes explicitly permitted", () => {
    for (const item of corpus.cases) {
      expect(assertEvaluationRecordAdmissible(item.record).id).toBe(
        item.record.id,
      );
      expect(assertTrainingRecordAdmissible(item.record).id).toBe(
        item.record.id,
      );
    }
  });

  it("fails closed when evaluation permission is absent", () => {
    const record = structuredClone(corpus.cases[0].record);
    record.provenance.license.evaluationAllowed = false;

    expect(() => assertEvaluationRecordAdmissible(record)).toThrowError(
      new DatasetAdmissibilityError("license_not_permitted"),
    );
  });

  it("fails closed when the declared purpose is absent", () => {
    const record = structuredClone(corpus.cases[0].record);
    record.provenance.permittedPurposes = ["training"];

    expect(() => assertEvaluationRecordAdmissible(record)).toThrowError(
      new DatasetAdmissibilityError("purpose_not_permitted"),
    );
  });

  it("rejects unbased personal data at schema validation", () => {
    const record = DatasetRecordSchema.parse(
      structuredClone(corpus.cases[0].record),
    );
    record.provenance.sourceKind = "first_party";
    record.provenance.privacy.containsPersonalData = true;
    delete record.provenance.privacy.lawfulBasis;

    expect(() => DatasetRecordSchema.parse(record)).toThrow(
      "personal-data records require a documented lawful basis",
    );
  });

  it("rejects impossible provenance calendar dates", () => {
    for (const date of ["2026-02-31", "2026-99-99", "2025-02-29"]) {
      const record = structuredClone(corpus.cases[0].record);
      record.date = date;
      expect(() => DatasetRecordSchema.parse(record)).toThrow(
        "date must be a real ISO calendar date",
      );
    }
  });

  it("accepts a valid leap-day provenance date", () => {
    const record = structuredClone(corpus.cases[0].record);
    record.date = "2024-02-29";
    expect(DatasetRecordSchema.parse(record).date).toBe("2024-02-29");
  });

  it("does not admit special-category data into automated v1 evaluation", () => {
    const record = DatasetRecordSchema.parse(
      structuredClone(corpus.cases[0].record),
    );
    record.provenance.sourceKind = "first_party";
    record.provenance.privacy.containsPersonalData = true;
    record.provenance.privacy.containsSpecialCategoryData = true;
    record.provenance.privacy.lawfulBasis = "documented-test-basis";

    expect(() => assertEvaluationRecordAdmissible(record)).toThrowError(
      new DatasetAdmissibilityError("special_category_data_not_permitted"),
    );
  });
  it("round-trips canonical admissible JSONL without changing record meaning", () => {
    const records = corpus.cases.slice(0, 3).map((item) => item.record);
    const jsonl = serializeDatasetRecordsJsonl(records, "evaluation");
    expect(jsonl.endsWith("\n")).toBe(true);

    const reparsed = parseDatasetRecordsJsonl(jsonl, "evaluation");
    expect(reparsed).toEqual(
      records.map((record) => DatasetRecordSchema.parse(record)),
    );
    expect(serializeDatasetRecordsJsonl(reparsed, "evaluation")).toBe(jsonl);
  });

  it("rejects duplicate IDs and inadmissible records during JSONL import/export", () => {
    const record = structuredClone(corpus.cases[0].record);
    expect(() =>
      serializeDatasetRecordsJsonl([record, record], "evaluation"),
    ).toThrow(`duplicate dataset record id: ${record.id}`);

    const forbidden = structuredClone(record);
    forbidden.provenance.license.trainingAllowed = false;
    expect(() =>
      serializeDatasetRecordsJsonl([forbidden], "training"),
    ).toThrowError(new DatasetAdmissibilityError("license_not_permitted"));

    const duplicateJsonl = [
      JSON.stringify(record),
      JSON.stringify(record),
      "",
    ].join("\n");
    expect(() =>
      parseDatasetRecordsJsonl(duplicateJsonl, "evaluation"),
    ).toThrow(`duplicate dataset record id: ${record.id}`);
  });
});
