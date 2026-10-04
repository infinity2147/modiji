import { describe, expect, it } from "vitest";
import {
  BASE_SCHEMA_VERSION,
  FeatureModelError,
  REMODEL_LEDGER_KINDS,
  conceptValues,
  featureModel,
  foldSessionSchema,
  loadFeatureModel,
  parseDomainConfig,
  pendingBackfills,
  PredicateSchema,
  ruleWithinModel,
  type ConceptDefinition,
  type ConfirmedConcept,
  type LedgerEntry,
} from "../src/index";
import { KYC_DOMAIN } from "../src/domains/kyc/index";

const DOCS: ConceptDefinition = { name: "documentsComplete", label: "Documents complete", type: "boolean" } as ConceptDefinition;
const TENURE: ConceptDefinition = {
  name: "directorTenureYears",
  label: "Director tenure",
  type: "number",
  min: 0,
  max: 60,
  integer: true,
  unit: "years",
} as ConceptDefinition;
const TIER: ConceptDefinition = { name: "clientTier", label: "Client tier", type: "enum", values: ["standard", "private"] } as ConceptDefinition;

const confirmed = (...defs: ConceptDefinition[]): ConfirmedConcept[] => defs.map((definition, i) => ({ definition, schemaVersion: BASE_SCHEMA_VERSION + i + 1 }));

describe("featureModel", () => {
  it("adds one typed derived feature per confirmed concept and bumps the version; the result is a valid domain", () => {
    const model = loadFeatureModel(KYC_DOMAIN, confirmed(DOCS, TENURE, TIER));
    expect(model.schemaVersion).toBe(4);
    expect(model.conceptFeatures).toEqual(["documentsComplete", "directorTenureYears", "clientTier"]);
    expect(model.domain.features.slice(0, KYC_DOMAIN.features.length)).toEqual(KYC_DOMAIN.features);
    expect(model.domain.features.slice(KYC_DOMAIN.features.length)).toEqual([
      { id: "documentsComplete", label: "Documents complete", source: "derived", type: "boolean" },
      { id: "directorTenureYears", label: "Director tenure", source: "derived", type: "number", min: 0, max: 60, integer: true, unit: "years" },
      { id: "clientTier", label: "Client tier", source: "derived", type: "enum", values: ["standard", "private"] },
    ]);
    expect(parseDomainConfig(model.domain).ok).toBe(true);
    // Concepts are decision inputs, not screen fields: critical fields, actions and families are untouched.
    expect(model.domain.criticalFields).toEqual(KYC_DOMAIN.criticalFields);
    expect(model.domain.decisionFamilies).toEqual(KYC_DOMAIN.decisionFamilies);
  });

  it("with no confirmations is the base domain at the base version", () => {
    const model = loadFeatureModel(KYC_DOMAIN, []);
    expect(model).toEqual({ domain: KYC_DOMAIN, schemaVersion: BASE_SCHEMA_VERSION, conceptFeatures: [] });
  });

  it("is deterministic: confirmation order in the input does not matter, versions do", () => {
    const a = loadFeatureModel(KYC_DOMAIN, confirmed(DOCS, TENURE));
    const b = loadFeatureModel(KYC_DOMAIN, [...confirmed(DOCS, TENURE)].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("refuses a concept id that collides with a base feature or an earlier concept, case-insensitively", () => {
    const clash = featureModel(KYC_DOMAIN, confirmed({ ...DOCS, name: "SourceOfFunds" } as ConceptDefinition));
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.issues[0]?.message).toContain('collides with base feature "sourceOfFunds"');
    const twice = featureModel(KYC_DOMAIN, confirmed(DOCS, { ...TIER, name: "DocumentsComplete" } as ConceptDefinition));
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.issues[0]?.message).toContain('collides with concept "documentsComplete"');
  });

  it("refuses gaps or repeats in the version sequence and invalid definitions", () => {
    expect(featureModel(KYC_DOMAIN, [{ definition: DOCS, schemaVersion: 3 }]).ok).toBe(false);
    expect(featureModel(KYC_DOMAIN, [{ definition: DOCS, schemaVersion: 2 }, { definition: TIER, schemaVersion: 2 }]).ok).toBe(false);
    const inverted = featureModel(KYC_DOMAIN, confirmed({ ...TENURE, min: 10, max: 1 } as ConceptDefinition));
    expect(inverted.ok).toBe(false);
    const oneValue = featureModel(KYC_DOMAIN, confirmed({ ...TIER, values: ["only"] } as ConceptDefinition));
    expect(oneValue.ok).toBe(false);
    expect(() => loadFeatureModel(KYC_DOMAIN, confirmed({ ...TIER, values: ["a", "a"] } as ConceptDefinition))).toThrow(FeatureModelError);
  });

  it("rules confirmed under an older version stay expressible; a rule reading an absent concept is not", () => {
    const model = loadFeatureModel(KYC_DOMAIN, confirmed(DOCS));
    const old = PredicateSchema.parse({ "==": [{ var: "pep" }, true] });
    const usesConcept = PredicateSchema.parse({ "==": [{ var: "documentsComplete" }, false] });
    expect(ruleWithinModel(model.domain, { decisionFamily: "reviewOutcome", predicate: old })).toBe(true);
    expect(ruleWithinModel(model.domain, { decisionFamily: "reviewOutcome", predicate: usesConcept })).toBe(true);
    expect(ruleWithinModel(KYC_DOMAIN, { decisionFamily: "reviewOutcome", predicate: usesConcept })).toBe(false);
    expect(ruleWithinModel(model.domain, { decisionFamily: "nope", predicate: old })).toBe(false);
  });
});

let seq = 0;
function entry(kind: string, source: LedgerEntry["source"], payload: unknown, parentIds: string[] = []): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: "s1",
    sequence: seq,
    source,
    kind,
    occurredAt: seq,
    receivedAt: seq,
    traceId: "t",
    parentIds,
    schemaVersion: 1,
    privacyEpoch: 0,
    payload,
  };
}

const proposed = (name: string, exactQuote?: string) =>
  entry("concept.proposed", "engine", { name, label: name, definition: `What ${name} means.`, type: "boolean", ...(exactQuote !== undefined && { exactQuote }) });
const words = { text: "Yes — whether every required document is on file.", provenance: "human_text" as const };

describe("foldSessionSchema", () => {
  it("undefined concepts are deduplicated proposals minus base features; only confirm/dismiss settle them", () => {
    const p1 = proposed("documentsComplete", "the file is incomplete");
    const p2 = proposed("documentsComplete");
    const p3 = proposed("boardTrackRecord");
    const p4 = proposed("pep");
    const p5 = proposed("shellCompany");
    const before = foldSessionSchema(KYC_DOMAIN, [p1, p2, p3, p4, p5]);
    expect(before.undefinedConcepts.map((c) => [c.concept.name, c.entryIds, c.origin])).toEqual([
      ["documentsComplete", [p1.id, p2.id], "interview"],
      ["boardTrackRecord", [p3.id], "vision"],
      ["shellCompany", [p5.id], "vision"],
    ]);

    const conf = entry("concept.confirmed", "expert", { feature: "documentsComplete", schemaVersion: 2, definition: DOCS, statement: words }, [p1.id, p2.id]);
    const bump = entry("schema.version_bumped", "engine", { from: 1, to: 2, feature: "documentsComplete", label: "Documents complete" }, [conf.id]);
    const dis = entry("concept.dismissed", "expert", { name: "shellCompany", reason: "already_covered", coveredBy: "entityType", statement: words }, [p5.id]);
    const again = proposed("documentsComplete");
    const after = foldSessionSchema(KYC_DOMAIN, [p1, p2, p3, p4, p5, conf, bump, dis, again]);
    expect(after.undefinedConcepts.map((c) => c.concept.name)).toEqual(["boardTrackRecord"]);
    expect(after.model.schemaVersion).toBe(2);
    expect(after.confirmed).toEqual([{ definition: DOCS, schemaVersion: 2, entryId: conf.id, bumpEntryId: bump.id }]);
    expect(after.dismissed.map((d) => [d.name, d.coveredBy])).toEqual([["shellCompany", "entityType"]]);
    expect(after.skipped).toEqual([]);
  });

  it("backfilled values are per decision; pending pairs read Unknown{not_extracted}; failures stay backfill_failed", () => {
    const conf = entry("concept.confirmed", "expert", { feature: "documentsComplete", schemaVersion: 2, definition: DOCS, statement: words });
    const bump = entry("schema.version_bumped", "engine", { from: 1, to: 2, feature: "documentsComplete", label: "Documents complete" }, [conf.id]);
    const ok = entry("feature.backfilled", "engine", {
      feature: "documentsComplete",
      schemaVersion: 2,
      decisionEntryId: "d1",
      caseId: "NS-2026-0101",
      value: false,
      evidence: "Proof of address: missing",
      frameIds: ["f1"],
      timing: "after_confirmation",
    });
    const failed = entry("feature.backfilled", "engine", {
      feature: "documentsComplete",
      schemaVersion: 2,
      decisionEntryId: "d2",
      caseId: "NS-2026-0102",
      value: { unknown: true, reason: "backfill_failed" },
      failure: "not_visible",
      frameIds: ["f2"],
      timing: "after_confirmation",
    });
    const schema = foldSessionSchema(KYC_DOMAIN, [conf, bump, ok, failed]);
    expect(conceptValues(schema, "d1")).toEqual({ documentsComplete: false });
    expect(conceptValues(schema, "d2")).toEqual({ documentsComplete: { unknown: true, reason: "backfill_failed" } });
    expect(conceptValues(schema, "d3")).toEqual({ documentsComplete: { unknown: true, reason: "not_extracted" } });
    expect(pendingBackfills(schema, ["d1", "d2", "d3"])).toEqual([{ decisionEntryId: "d3", feature: "documentsComplete" }]);
    for (const kind of ["concept.confirmed", "concept.dismissed", "schema.version_bumped", "feature.backfilled"]) expect(REMODEL_LEDGER_KINDS.has(kind)).toBe(true);
  });

  it("skips (with a reason) a confirmation that collides, a backfill of an unconfirmed feature, and a mismatched bump", () => {
    const clash = entry("concept.confirmed", "expert", {
      feature: "PEP",
      schemaVersion: 2,
      definition: { ...DOCS, name: "PEP" },
      statement: words,
    });
    const stray = entry("feature.backfilled", "engine", {
      feature: "documentsComplete",
      schemaVersion: 2,
      decisionEntryId: "d1",
      caseId: "c",
      value: true,
      frameIds: [],
      timing: "new_case",
    });
    const bump = entry("schema.version_bumped", "engine", { from: 1, to: 2, feature: "documentsComplete", label: "x" });
    const schema = foldSessionSchema(KYC_DOMAIN, [clash, stray, bump]);
    expect(schema.model.schemaVersion).toBe(1);
    expect(schema.skipped.map((s) => s.ledgerEntryId)).toEqual([clash.id, stray.id, bump.id]);
  });

  it("refuses inconsistent backfill payloads at the registry (unknown without failure, other unknown reasons)", () => {
    const bad = entry("feature.backfilled", "engine", {
      feature: "documentsComplete",
      schemaVersion: 2,
      decisionEntryId: "d1",
      caseId: "c",
      value: { unknown: true, reason: "not_visible" },
      failure: "not_visible",
      frameIds: [],
      timing: "new_case",
    });
    const conf = entry("concept.confirmed", "expert", { feature: "documentsComplete", schemaVersion: 2, definition: DOCS, statement: words });
    expect(foldSessionSchema(KYC_DOMAIN, [conf, bad]).skipped.map((s) => s.ledgerEntryId)).toEqual([bad.id]);
  });
});
