import { describe, expect, it } from "vitest";
import corpus from "../../benchmarks/raeburnbench.seed.v0.json";
import {
  DatasetAdmissibilityError,
  DatasetRecordSchema,
  assertEvaluationRecordAdmissible,
  assertTrainingRecordAdmissible,
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
    const record = structuredClone(corpus.cases[0].record);
    record.provenance.sourceKind = "first_party";
    record.provenance.privacy.containsPersonalData = true;
    delete record.provenance.privacy.lawfulBasis;

    expect(() => DatasetRecordSchema.parse(record)).toThrow(
      "personal-data records require a documented lawful basis",
    );
  });

  it("does not admit special-category data into automated v1 evaluation", () => {
    const record = structuredClone(corpus.cases[0].record);
    record.provenance.sourceKind = "first_party";
    record.provenance.privacy.containsPersonalData = true;
    record.provenance.privacy.containsSpecialCategoryData = true;
    record.provenance.privacy.lawfulBasis = "documented-test-basis";

    expect(() => assertEvaluationRecordAdmissible(record)).toThrowError(
      new DatasetAdmissibilityError("special_category_data_not_permitted"),
    );
  });
});
