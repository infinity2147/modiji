import type { DomainConfig, Feature } from "../schemas/domain";
import { SymbolIdSchema, type FeatureId, type Value } from "../schemas/primitives";

export type FeatureValueCheck = { ok: true; featureId: FeatureId; value: Value } | { ok: false; message: string };

/**
 * Validates an untrusted (feature id, value) pair against the domain's declared features: the
 * feature exists, the JS type matches, enum values are declared, numbers are finite, within
 * [min, max] and integral where required. Messages name the feature and the problem; they never
 * echo a submitted string (only declared enum values and numbers appear).
 */
export function validateFeatureValue(domain: DomainConfig, featureId: string, value: unknown): FeatureValueCheck {
  const feature = domain.features.find((f) => f.id === featureId);
  if (feature === undefined)
    return {
      ok: false,
      message: SymbolIdSchema.safeParse(featureId).success
        ? `unknown feature "${featureId}" in domain "${domain.id}"`
        : `feature id is not a valid identifier`,
    };
  const problem = valueProblem(feature, value);
  return problem === undefined
    ? { ok: true, featureId: feature.id, value: value as Value }
    : { ok: false, message: `feature "${feature.id}": ${problem}` };
}

function valueProblem(f: Feature, value: unknown): string | undefined {
  switch (f.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `expected a boolean, got ${typeName(value)}`;
    case "string":
      return typeof value === "string" ? undefined : `expected a string, got ${typeName(value)}`;
    case "enum":
      if (typeof value !== "string") return `expected one of ${f.values.join(", ")}, got ${typeName(value)}`;
      return f.values.includes(value) ? undefined : `value is not one of ${f.values.join(", ")}`;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `expected a finite number, got ${typeName(value)}`;
      if (value < f.min || value > f.max) return `${value} is outside [${f.min}, ${f.max}]`;
      if (f.integer && !Number.isInteger(value)) return `${value} is not an integer`;
      return undefined;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return Number.isFinite(value) ? "a number" : Number.isNaN(value) ? "NaN" : "an infinite number";
  return `a ${typeof value}`;
}
