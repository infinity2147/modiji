/**
 * Session feature model (plan §6.6): the base domain plus the concepts the EXPERT confirmed, each one a
 * typed `derived` feature, versioned. An LLM (interview proposer, answer parser, vision) only proposes a
 * concept; it becomes a feature here only through a `concept.confirmed` entry written by the expert,
 * which carries the expert's own definition (label, type, values or bounds) and the schema version it
 * introduced. Pure and deterministic: the same base and confirmations always give the same model.
 */
import { parseDomainConfig, type DomainIssue } from "../domain/parse";
import { typecheckPredicate } from "../logic/typecheck";
import type { DomainConfig, Feature } from "../schemas/domain";
import { ConceptDefinitionSchema, type ConceptDefinition } from "../schemas/concepts";
import { SchemaVersionSchema } from "../schemas/primitives";
import type { ConfirmedRule } from "../schemas/rules";

/** Schema version of a base domain before any concept is confirmed (the CaseDesk / KYC case schema version). */
export const BASE_SCHEMA_VERSION = 1;

/** A confirmed concept and the schema version its confirmation introduced. */
export type ConfirmedConcept = { definition: ConceptDefinition; schemaVersion: number };

export type FeatureModel = {
  /** Base features first (unchanged), then one `derived` feature per confirmed concept in version order. */
  domain: DomainConfig;
  schemaVersion: number;
  /** Ids of the features added by confirmed concepts, in version order. */
  conceptFeatures: readonly string[];
};

/** The feature a confirmed concept adds. `source: "derived"`: its value is never read from the case record. */
export function conceptFeature(d: ConceptDefinition): Feature {
  const base = { id: d.name, label: d.label, source: "derived" as const, ...(d.description !== undefined && { description: d.description }) };
  switch (d.type) {
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "enum", values: [...d.values] };
    case "number":
      return { ...base, type: "number", min: d.min, max: d.max, integer: d.integer, ...(d.unit !== undefined && { unit: d.unit }) };
  }
}

/**
 * Base + confirmed concepts → the session's feature model, validated by `parseDomainConfig`.
 *
 * Refused (all issues collected): confirmation versions that are not exactly base+1 … base+n; a concept id
 * equal to a base feature or an earlier concept, compared case-insensitively ("SourceOfFunds" next to
 * "sourceOfFunds" would read as the same feature to an expert and to a model); anything the domain parser
 * rejects (bounds, duplicate enum values).
 */
export function featureModel(
  base: DomainConfig,
  confirmed: readonly ConfirmedConcept[],
  baseVersion: number = BASE_SCHEMA_VERSION,
): { ok: true; model: FeatureModel } | { ok: false; issues: DomainIssue[] } {
  const issues: DomainIssue[] = [];
  const ordered = [...confirmed].sort((a, b) => a.schemaVersion - b.schemaVersion);
  const taken = new Map(base.features.map((f) => [f.id.toLowerCase(), `base feature "${f.id}"`]));
  ordered.forEach((c, i) => {
    const at = `/concepts/${i}`;
    const parsed = ConceptDefinitionSchema.safeParse(c.definition);
    if (!parsed.success) issues.push(...parsed.error.issues.map((x) => ({ path: `${at}/${x.path.join("/")}`, message: x.message })));
    if (!SchemaVersionSchema.safeParse(c.schemaVersion).success || c.schemaVersion !== baseVersion + i + 1)
      issues.push({ path: `${at}/schemaVersion`, message: `expected schema version ${baseVersion + i + 1}, got ${c.schemaVersion}` });
    const key = c.definition.name.toLowerCase();
    const clash = taken.get(key);
    if (clash !== undefined) issues.push({ path: `${at}/name`, message: `concept "${c.definition.name}" collides with ${clash}` });
    else taken.set(key, `concept "${c.definition.name}"`);
  });
  if (issues.length > 0) return { ok: false, issues };
  const parsed = parseDomainConfig({ ...base, features: [...base.features, ...ordered.map((c) => conceptFeature(c.definition))] });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    model: { domain: parsed.domain, schemaVersion: baseVersion + ordered.length, conceptFeatures: ordered.map((c) => c.definition.name) },
  };
}

export class FeatureModelError extends Error {
  readonly issues: DomainIssue[];
  constructor(issues: DomainIssue[]) {
    super(`invalid feature model:\n${issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "FeatureModelError";
    this.issues = issues;
  }
}

export function loadFeatureModel(base: DomainConfig, confirmed: readonly ConfirmedConcept[], baseVersion: number = BASE_SCHEMA_VERSION): FeatureModel {
  const result = featureModel(base, confirmed, baseVersion);
  if (!result.ok) throw new FeatureModelError(result.issues);
  return result.model;
}

/** The base domain as a version-1 feature model (no concepts confirmed). */
export function baseFeatureModel(base: DomainConfig, baseVersion: number = BASE_SCHEMA_VERSION): FeatureModel {
  return { domain: base, schemaVersion: baseVersion, conceptFeatures: [] };
}

/**
 * Whether a confirmed rule can be stated in `domain`: its family exists and its predicate type-checks
 * there. A rule confirmed under an older schema version stays expressible after a concept is added (it
 * does not read the new feature); a rule reading a concept confirmed in another session is not
 * expressible in a model without that concept, so solver and guardrail consumers of that model must
 * leave it out rather than fail.
 */
export function ruleWithinModel(domain: DomainConfig, rule: Pick<ConfirmedRule, "decisionFamily" | "predicate">): boolean {
  return domain.decisionFamilies.some((f) => f.id === rule.decisionFamily) && typecheckPredicate(rule.predicate, domain.features).length === 0;
}
