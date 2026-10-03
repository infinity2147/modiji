import { describe, expect, it } from "vitest";
import { validateFeatureValue } from "../src";
import { KYC_DOMAIN } from "../src/domains/kyc";

describe("validateFeatureValue", () => {
  it.each([
    ["entityType", "trust"],
    ["pep", false],
    ["accountAgeMonths", 0],
    ["accountAgeMonths", 600],
    ["uboOwnershipPct", 25.5],
    ["expectedMonthlyVolume", 50_000],
  ])("accepts %s = %j", (featureId, value) => {
    expect(validateFeatureValue(KYC_DOMAIN, featureId, value)).toEqual({ ok: true, featureId, value });
  });

  it.each([
    ["unknown feature", "favouriteColour", "blue", 'unknown feature "favouriteColour" in domain "kycNorthstar"'],
    ["non-identifier feature id", "a.b c", 1, "feature id is not a valid identifier"],
    ["boolean given a string", "pep", "yes", 'feature "pep": expected a boolean, got a string'],
    ["boolean given null", "pep", null, 'feature "pep": expected a boolean, got null'],
    ["enum given a number", "entityType", 3, 'feature "entityType": expected one of individual, company, trust, got a number'],
    ["enum value not declared", "jurisdictionRisk", "extreme", 'feature "jurisdictionRisk": value is not one of low, medium, high'],
    ["number given a string", "accountAgeMonths", "12", 'feature "accountAgeMonths": expected a finite number, got a string'],
    ["NaN", "uboOwnershipPct", Number.NaN, 'feature "uboOwnershipPct": expected a finite number, got NaN'],
    ["infinity", "uboOwnershipPct", Number.POSITIVE_INFINITY, 'feature "uboOwnershipPct": expected a finite number, got an infinite number'],
    ["below min", "uboOwnershipPct", -1, 'feature "uboOwnershipPct": -1 is outside [0, 100]'],
    ["above max", "accountAgeMonths", 601, 'feature "accountAgeMonths": 601 is outside [0, 600]'],
    ["non-integer for an integer feature", "accountAgeMonths", 2.5, 'feature "accountAgeMonths": 2.5 is not an integer'],
    ["array", "pep", [true], 'feature "pep": expected a boolean, got an array'],
  ])("rejects %s", (_, featureId, value, message) => {
    expect(validateFeatureValue(KYC_DOMAIN, featureId, value)).toEqual({ ok: false, message });
  });

  it("never echoes a submitted free-text value", () => {
    const secret = "Jane Q. Customer, passport X1234567";
    for (const featureId of ["jurisdictionRisk", "pep", "accountAgeMonths"]) {
      const result = validateFeatureValue(KYC_DOMAIN, featureId, secret);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain(secret);
    }
  });
});
