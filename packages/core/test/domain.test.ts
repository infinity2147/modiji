import { describe, expect, it } from "vitest";
import { DomainConfigError, loadDomainConfig, parseDomainConfig, type DomainConfigInput } from "../src";

/** A small, generic onboarding-review domain. Not a real institution's policy. */
const fixture: DomainConfigInput = {
  id: "onboardingReview",
  title: "Customer onboarding review (sample)",
  features: [
    { id: "ownershipPct", label: "Largest ownership stake", source: "case", type: "number", min: 0, max: 100, unit: "%" },
    { id: "entityType", label: "Entity type", source: "case", type: "enum", values: ["individual", "company", "trust"] },
    { id: "hasBeneficialOwners", label: "Has beneficial owners", source: "case", type: "boolean" },
    { id: "customerName", label: "Customer name", source: "case", type: "string" },
    { id: "priorEscalations", label: "Prior escalations", source: "derived", type: "number", min: 0, max: 50, integer: true },
  ],
  actions: [
    { id: "approve", label: "Approve", terminal: true },
    { id: "enhancedReview", label: "Enhanced review", terminal: false },
    {
      id: "requestDocuments",
      label: "Request documents",
      terminal: false,
      params: [
        { id: "document", label: "Document", type: "enum", values: ["proofOfAddress", "registryExtract"] },
        { id: "note", label: "Note", type: "string", required: false },
      ],
    },
    { id: "decline", label: "Decline", terminal: true },
  ],
  decisionFamilies: [
    { id: "reviewOutcome", label: "Review outcome", actions: ["approve", "enhancedReview", "requestDocuments", "decline"] },
  ],
  domainConstraints: [
    { and: [{ ">=": [{ var: "ownershipPct" }, 0] }, { "<=": [{ var: "ownershipPct" }, 100] }] },
    { or: [{ "!=": [{ var: "entityType" }, "individual"] }, { "==": [{ var: "hasBeneficialOwners" }, false] }] },
  ],
  criticalFields: ["ownershipPct", "entityType"],
};

/** Returns a deep copy of the fixture with `edit` applied. */
function variant(edit: (d: DomainConfigInput) => void): DomainConfigInput {
  const d = structuredClone(fixture);
  edit(d);
  return d;
}

function issuesOf(input: unknown) {
  const r = parseDomainConfig(input);
  if (r.ok) throw new Error("expected the config to be rejected");
  return r.issues;
}

describe("parseDomainConfig", () => {
  it("accepts a valid domain and applies schema defaults", () => {
    const r = parseDomainConfig(fixture);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.domain.features[0]).toMatchObject({ type: "number", integer: false });
    expect(r.domain.actions[2]?.params?.[0]).toMatchObject({ required: true });
  });

  it("maps schema errors to JSON pointers", () => {
    const bad = variant((d) => {
      d.features[1] = { id: "entity.type", label: "Entity type", source: "case", type: "enum", values: ["a"] };
      d.title = "";
    });
    expect(issuesOf(bad).map((i) => i.path).sort()).toEqual(["/features/1/id", "/title"]);
    expect(issuesOf(null)).toEqual([{ path: "", message: expect.any(String) }]);
  });

  it.each<[string, (d: DomainConfigInput) => void, string, string]>([
    [
      "duplicate feature id",
      (d) => d.features.push({ id: "entityType", label: "Again", source: "derived", type: "boolean" }),
      "/features/5/id",
      'duplicate feature id "entityType" (first at /features/1/id)',
    ],
    [
      "duplicate action id",
      (d) => d.actions.push({ id: "approve", label: "Approve again", terminal: true }),
      "/actions/4/id",
      "duplicate action id",
    ],
    [
      "duplicate decision family id",
      (d) => d.decisionFamilies.push({ id: "reviewOutcome", label: "Again", actions: ["approve"] }),
      "/decisionFamilies/1/id",
      "duplicate decision family id",
    ],
    [
      "unknown family action",
      (d) => d.decisionFamilies[0]?.actions.push("escalate"),
      "/decisionFamilies/0/actions/4",
      'unknown action "escalate"',
    ],
    ["unknown critical field", (d) => d.criticalFields.push("riskScore"), "/criticalFields/2", 'unknown feature "riskScore"'],
    [
      "number min > max",
      (d) => (d.features[4] = { id: "priorEscalations", label: "x", source: "derived", type: "number", min: 10, max: 5 }),
      "/features/4/max",
      "less than min",
    ],
    [
      "non-integer bound on an integer feature",
      (d) => (d.features[4] = { id: "priorEscalations", label: "x", source: "derived", type: "number", min: 0, max: 9.5, integer: true }),
      "/features/4/max",
      "must be an integer",
    ],
    [
      "duplicate enum value",
      (d) => (d.features[1] = { id: "entityType", label: "x", source: "case", type: "enum", values: ["individual", "company", "trust", "company"] }),
      "/features/1/values/3",
      'duplicate enum value "company"',
    ],
    [
      "enum param without values",
      (d) => (d.actions[0] = { id: "approve", label: "Approve", terminal: true, params: [{ id: "reason", label: "Reason", type: "enum" }] }),
      "/actions/0/params/0",
      "requires values",
    ],
    [
      "string param with values",
      (d) => (d.actions[2] = { id: "requestDocuments", label: "x", terminal: false, params: [{ id: "note", label: "Note", type: "string", values: ["a"] }] }),
      "/actions/2/params/0/values",
      "must not declare values",
    ],
    [
      "duplicate param id",
      (d) =>
        (d.actions[2] = {
          id: "requestDocuments",
          label: "x",
          terminal: false,
          params: [
            { id: "note", label: "Note", type: "string" },
            { id: "note", label: "Note 2", type: "string" },
          ],
        }),
      "/actions/2/params/1/id",
      'duplicate param id "note"',
    ],
    [
      "ill-typed domain constraint",
      (d) => d.domainConstraints.push({ or: [{ "==": [{ var: "hasBeneficialOwners" }, true] }, { "==": [{ var: "entityType" }, "partnership"] }] }),
      "/domainConstraints/2/or/1/==/1",
      "is not a value of enum",
    ],
  ])("reports %s", (_name, edit, path, message) => {
    expect(issuesOf(variant(edit))).toEqual([{ path, message: expect.stringContaining(message) }]);
  });

  it("collects every cross-check issue instead of stopping at the first", () => {
    const bad = variant((d) => {
      d.features.push({ id: "ownershipPct", label: "Dup", source: "case", type: "boolean" });
      d.decisionFamilies[0]?.actions.push("escalate");
      d.criticalFields.push("riskScore");
      d.domainConstraints.push({ ">": [{ var: "ghost" }, 1] });
    });
    expect(issuesOf(bad).map((i) => i.path)).toEqual([
      "/features/5/id",
      "/decisionFamilies/0/actions/4",
      "/criticalFields/2",
      "/domainConstraints/2/>/0",
    ]);
  });
});

describe("loadDomainConfig", () => {
  it("returns the parsed domain", () => {
    expect(loadDomainConfig(fixture).id).toBe("onboardingReview");
  });

  it("throws a DomainConfigError listing all issues", () => {
    const bad = variant((d) => {
      d.criticalFields.push("a", "b");
    });
    const error = (() => {
      try {
        loadDomainConfig(bad);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(DomainConfigError);
    expect(error).toMatchObject({ issues: [{ path: "/criticalFields/2" }, { path: "/criticalFields/3" }] });
    expect(String(error)).toMatch(/\/criticalFields\/2: .*\n.*\/criticalFields\/3: /);
  });
});
