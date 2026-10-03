import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  LedgerEntrySchema,
  WorkMapSchema,
  buildWorkMap,
  computeCoverage,
  decisionCell,
  lineage,
  observedDecisions,
  type ConfirmedRule,
  type Coverage,
  type FeatureValue,
  type LedgerEntry,
  type Witness,
} from "../src";
import { KYC_DOMAIN } from "../src/domains/kyc";

const T0 = 1_760_000_000_000;
const EXPERT = "s-expert";
const NOVICE = "s-novice";

/** Base case: every KYC feature known; individual cases override a few. */
const BASE: Record<string, FeatureValue> = {
  entityType: "company",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "low",
  uboOwnershipPct: 40,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 20_000,
  riskRating: "unrated",
};
const CASES: Record<string, Record<string, FeatureValue>> = {
  "CASE-A": { ...BASE, uboVerified: false },
  "CASE-B": { ...BASE, pep: true },
  "CASE-C": { ...BASE, sanctionsHit: true },
};
const caseFeatures = (caseId: string, edits: Readonly<Record<string, string | number | boolean>>): Record<string, FeatureValue> | undefined =>
  CASES[caseId] === undefined ? undefined : { ...CASES[caseId], ...edits };

class Fixture {
  readonly entries: LedgerEntry[] = [];
  private seq = new Map<string, number>();
  add(sessionId: string, source: LedgerEntry["source"], kind: string, payload: unknown, parentIds: string[] = [], id?: string): LedgerEntry {
    const sequence = this.seq.get(sessionId) ?? 0;
    this.seq.set(sessionId, sequence + 1);
    const e = LedgerEntrySchema.parse({
      id: id ?? `${sessionId}-${sequence}`,
      sessionId,
      sequence,
      source,
      kind,
      occurredAt: T0 + this.entries.length,
      receivedAt: T0 + this.entries.length,
      traceId: "trace",
      parentIds,
      schemaVersion: 1,
      privacyEpoch: 0,
      payload,
    });
    this.entries.push(e);
    return e;
  }
}

const screen = (kind: string, extra: Record<string, unknown>, frameSeq: number) => ({
  id: `ev-${frameSeq}-${kind}`,
  frameSeq,
  captureTime: T0,
  sessionEpoch: 0,
  kind,
  confidence: 1,
  source: "dom",
  critical: false,
  ...extra,
});
const decisionPayload = (caseId: string, action: string) => ({
  caseId,
  action,
  edits: {},
  result: { decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] },
});

function rule(id: string, predicate: unknown, effect: unknown, quote: string, kind = "decision"): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: "reviewOutcome",
    kind,
    predicate,
    effect,
    priority: 10,
    overrides: [],
    evidence: [
      { kind: "expert_quote", utteranceId: `utt-${id}`, exactQuote: quote, t0Ms: 0, t1Ms: 900, frameIds: ["s-expert-2"], eventIds: [], relation: "supports", provenance: "human_voice" },
    ],
    confirmedBy: [{ expertId: "expert-1", at: T0, method: "debrief", ledgerEntryId: `utt-${id}` }],
    revision: 1,
    schemaVersion: 1,
    expertId: "expert-1",
  });
}

const R_DOCS = rule("r-docs", { "==": [{ var: "uboVerified" }, false] }, { type: "recommend", action: "requestDocuments" }, "If we can't verify the owner, ask for documents.");
const R_PEP = rule("r-pep", { "==": [{ var: "pep" }, true] }, { type: "recommend", action: "enhancedReview" }, "Any PEP goes to enhanced review.");
const G_SANCTIONS = rule("g-sanctions", { "==": [{ var: "sanctionsHit" }, true] }, { type: "forbid", action: "approve" }, "Never approve a sanctions match.", "guardrail");
const RULES = [R_DOCS, R_PEP, G_SANCTIONS];

function fixture(): Fixture {
  const f = new Fixture();
  f.add(EXPERT, "engine", "session.started", { mode: "expert", caseSet: "training", domainId: "kycNorthstar", schemaVersion: 1 });
  f.add(EXPERT, "dom", "screen.event", screen("open_case", { caseId: "CASE-A" }, 1));
  f.add(EXPERT, "client", "frame.received", { frameId: "f-1", frameSeq: 1, captureTime: T0, width: 1568, height: 882, mediaPath: "frames/f-1.png", redactedRegions: 2, changeScore: 0.4 });
  f.add(EXPERT, "dom", "screen.event", screen("field_change", { caseId: "CASE-A", field: "riskRating", from: "unrated", to: "high" }, 2));
  const check = f.add(EXPERT, "engine", "interlock.check", { caseId: "CASE-A", action: "requestDocuments", edits: {}, result: decisionPayload("x", "approve").result });
  f.add(EXPERT, "dom", "case.decision", decisionPayload("CASE-A", "requestDocuments"), [check.id]);
  f.add(EXPERT, "dom", "screen.event", screen("open_case", { caseId: "CASE-B" }, 3));
  f.add(EXPERT, "dom", "case.decision", decisionPayload("CASE-B", "enhancedReview"));
  f.add(EXPERT, "dom", "screen.event", screen("open_case", { caseId: "CASE-C" }, 4));
  f.add(EXPERT, "dom", "case.decision", decisionPayload("CASE-C", "reject"));
  f.add(NOVICE, "engine", "session.started", { mode: "novice", caseSet: "training", domainId: "kycNorthstar", schemaVersion: 1 });
  f.add(NOVICE, "dom", "case.decision", decisionPayload("CASE-A", "approve"));
  return f;
}

const OPEN_COVERAGE: Coverage = {
  decisionsExplained: { explained: 2, total: 3 },
  unresolvedWitnesses: 1,
  acknowledgedWitnesses: 0,
  undefinedConcepts: 0,
  teachBackConfirmed: false,
  schemaVersion: 1,
  closed: false,
};

function build(entries: readonly LedgerEntry[], extra: { titles?: Record<string, string>; summary?: string } = {}) {
  return buildWorkMap({ id: "wm-1", domain: KYC_DOMAIN, entries, rules: RULES, revision: 3, coverage: OPEN_COVERAGE, caseFeatures, expertId: "expert-1", schemaVersion: 1, now: T0, ...extra });
}

describe("buildWorkMap", () => {
  it("builds one step per committed expert decision with its screen moment, explaining rules, quotes and guardrails", () => {
    const f = fixture();
    const wm = build(f.entries);
    expect(WorkMapSchema.safeParse(wm).success).toBe(true);
    expect(wm.sessionIds).toEqual([NOVICE, EXPERT].sort());
    expect(wm.steps.map((s) => [s.caseId, s.decision.action])).toEqual([
      ["CASE-A", "requestDocuments"],
      ["CASE-B", "enhancedReview"],
      ["CASE-C", "reject"],
    ]);
    const [a, b, c] = wm.steps;
    expect(a?.frameIds).toEqual(["s-expert-2"]);
    expect(a?.eventIds).toEqual(["s-expert-1", "s-expert-3"]);
    expect(a?.ruleIds).toEqual(["r-docs"]);
    expect(a?.reasonQuotes.map((q) => q.exactQuote)).toEqual(["If we can't verify the owner, ask for documents."]);
    expect(b?.ruleIds).toEqual(["r-pep"]);
    expect(b?.eventIds).toEqual(["s-expert-6"]);
    expect(b?.frameIds).toEqual([]);
    // Nothing decides "reject"; the sanctions guardrail is in force on that case.
    expect(c?.ruleIds).toEqual([]);
    expect(c?.reasonQuotes).toEqual([]);
    expect(c?.guardrailIds).toEqual(["g-sanctions"]);
    expect(a?.title).toBe("CASE-A — Request documents");
    expect(wm.rules.map((r) => r.id)).toEqual(["g-sanctions", "r-docs", "r-pep"]);
  });

  it("is deterministic: entry order does not matter, ids are stable", () => {
    const f = fixture();
    const shuffled = [...f.entries].reverse();
    expect(build(shuffled)).toEqual(build(f.entries));
    expect(build(f.entries).steps.map((s) => s.id)).toEqual(build(f.entries).steps.map((s) => s.id));
  });

  it("uses model titles and summary only as labels", () => {
    const f = fixture();
    const plain = build(f.entries);
    const stepId = plain.steps[0]?.id ?? "";
    const titled = build(f.entries, { titles: { [stepId]: "Unverified owner: documents first" }, summary: "Three KYC reviews." });
    expect(titled.steps[0]?.title).toBe("Unverified owner: documents first");
    expect(titled.summary).toBe("Three KYC reviews.");
    expect({ ...titled, steps: titled.steps.map((s) => ({ ...s, title: "" })), summary: "" }).toEqual({
      ...plain,
      steps: plain.steps.map((s) => ({ ...s, title: "" })),
      summary: "",
    });
  });

  it("skips novice sessions and decisions with unknown cases", () => {
    const f = fixture();
    f.add(EXPERT, "dom", "case.decision", decisionPayload("CASE-UNKNOWN", "approve"));
    const decisions = observedDecisions({ domain: KYC_DOMAIN, entries: f.entries, caseFeatures });
    expect(decisions.map((d) => d.entry.sessionId)).toEqual([EXPERT, EXPERT, EXPERT]);
  });
});

const unresolved = (id: string, assignment: Record<string, FeatureValue>): Witness =>
  ({ id, kind: "unresolved", decisionFamily: "reviewOutcome", assignment, schemaVersion: 1 }) as Witness;

describe("computeCoverage", () => {
  const f = fixture();
  const decisions = observedDecisions({ domain: KYC_DOMAIN, entries: f.entries, caseFeatures }).slice(0, 2);
  const gap = unresolved("w-1", { ...BASE });

  it.each([
    [true, true, true, true, true],
    [false, true, true, true, false],
    [true, false, true, true, false],
    [true, true, false, true, false],
    [true, true, true, false, false],
    [false, false, false, false, false],
  ])("explained=%s noGaps=%s noConcepts=%s teachBack=%s → closed=%s", (explained, noGaps, noConcepts, teachBack, closed) => {
    const c = computeCoverage({
      domain: KYC_DOMAIN,
      rules: explained ? RULES : [R_DOCS],
      decisions,
      witnesses: noGaps ? [] : [gap],
      resolutions: [],
      undefinedConcepts: noConcepts ? 0 : 1,
      teachBackConfirmed: teachBack,
      schemaVersion: 1,
    });
    expect(c.closed).toBe(closed);
    expect(c.decisionsExplained).toEqual({ explained: explained ? 2 : 1, total: 2 });
    expect(c.unresolvedWitnesses).toBe(noGaps ? 0 : 1);
  });

  it("never closes over zero observed decisions", () => {
    const c = computeCoverage({ domain: KYC_DOMAIN, rules: RULES, decisions: [], witnesses: [], resolutions: [], undefinedConcepts: 0, teachBackConfirmed: true, schemaVersion: 1 });
    expect(c.closed).toBe(false);
  });

  it("counts boundary witnesses as checks, not gaps", () => {
    const boundary = { id: "w-b", kind: "boundary", decisionFamily: "reviewOutcome", assignment: BASE, schemaVersion: 1, ruleId: "r-docs", feature: "uboOwnershipPct", threshold: 25, side: "at" } as Witness;
    const c = computeCoverage({ domain: KYC_DOMAIN, rules: RULES, decisions, witnesses: [boundary], resolutions: [], undefinedConcepts: 0, teachBackConfirmed: true, schemaVersion: 1 });
    expect(c.unresolvedWitnesses).toBe(0);
    expect(c.closed).toBe(true);
  });

  it("excludes acknowledged witnesses, carried to the same decision cell after a rerun, not to another cell", () => {
    const acknowledged = { witness: gap, resolution: { witnessId: gap.id, resolution: "escalate_to_controller" as const, ledgerEntryId: "stmt-1" } };
    // Same cell under the rules (pep false, uboVerified true), different canonical case.
    const sameCell = unresolved("w-2", { ...BASE, jurisdictionRisk: "high" });
    const otherCell = unresolved("w-3", { ...BASE, pep: true, uboVerified: true, sanctionsHit: false });
    expect(decisionCell(RULES, KYC_DOMAIN.decisionFamilies[0]!, sameCell.assignment)).toEqual(decisionCell(RULES, KYC_DOMAIN.decisionFamilies[0]!, gap.assignment));
    const c = computeCoverage({
      domain: KYC_DOMAIN,
      rules: RULES,
      decisions,
      witnesses: [sameCell, otherCell],
      resolutions: [acknowledged],
      undefinedConcepts: 0,
      teachBackConfirmed: true,
      schemaVersion: 1,
    });
    expect(c.acknowledgedWitnesses).toBe(1);
    expect(c.unresolvedWitnesses).toBe(1);
    expect(c.closed).toBe(false);
    const outOfScope = { ...acknowledged, resolution: { ...acknowledged.resolution, resolution: "rule_added" as const } };
    expect(computeCoverage({ domain: KYC_DOMAIN, rules: RULES, decisions, witnesses: [gap], resolutions: [outOfScope], undefinedConcepts: 0, teachBackConfirmed: true, schemaVersion: 1 }).unresolvedWitnesses).toBe(1);
  });
});

describe("lineage", () => {
  function dag() {
    const f = new Fixture();
    const frame = f.add(EXPERT, "client", "frame.received", { frameId: "f", frameSeq: 1, captureTime: T0, width: 10, height: 10, mediaPath: "m", redactedRegions: 0, changeScore: 1 }, [], "frame");
    const event = f.add(EXPERT, "dom", "screen.event", screen("open_case", { caseId: "CASE-A" }, 1), [], "event");
    const decision = f.add(EXPERT, "dom", "case.decision", decisionPayload("CASE-A", "requestDocuments"), [], "decision");
    const hyp = f.add(EXPERT, "engine", "hypotheses.updated", { decisionFamily: "reviewOutcome", hypothesisSetId: "hs", top: [], contradiction: false }, [decision.id], "hyp");
    const question = f.add(EXPERT, "engine", "question.queued", {}, [decision.id, hyp.id], "question");
    const control = f.add(EXPERT, "system_control", "gate.control_message", {}, [question.id], "control");
    const answer = f.add(EXPERT, "voice", "utterance.transcript", {}, [question.id], "answer");
    const ruleEntry = f.add(EXPERT, "engine", "rule.confirmed", {}, [answer.id], "rule");
    const tutor = f.add(EXPERT, "engine", "tutor.intervention", {}, [ruleEntry.id], "tutor");
    const sibling = f.add(EXPERT, "engine", "hypotheses.updated", {}, [], "sibling");
    return { f, frame, event, decision, control, tutor, sibling };
  }

  it("traces Frame → ScreenEvent → Decision → Candidate → Question → Answer → ConfirmedRule → TutorIntervention", () => {
    const { f } = dag();
    const t = lineage(f.entries, "rule", [
      { from: "frame", to: "decision" },
      { from: "event", to: "decision" },
    ]);
    expect(t?.nodes.map((n) => n.stage)).toEqual(["frame", "screen_event", "decision", "candidate", "question", "answer", "confirmed_rule", "tutor_intervention"]);
    expect(t?.nodes.find((n) => n.id === "rule")?.role).toBe("focus");
    expect(t?.nodes.find((n) => n.id === "frame")?.role).toBe("ancestor");
    expect(t?.nodes.find((n) => n.id === "tutor")?.role).toBe("descendant");
    expect(t?.edges).toContainEqual({ from: "frame", to: "decision", via: "screen_moment" });
    expect(t?.edges).toContainEqual({ from: "answer", to: "rule", via: "parent" });
  });

  it("never includes system_control entries or unrelated siblings, and has no frame without a link", () => {
    const { f } = dag();
    const t = lineage(f.entries, "decision");
    const ids = t?.nodes.map((n) => n.id) ?? [];
    expect(ids).not.toContain("control");
    expect(ids).not.toContain("sibling");
    expect(ids).not.toContain("frame");
    expect(ids[0]).toBe("decision");
    expect(lineage(f.entries, "control")).toBeUndefined();
    expect(lineage(f.entries, "missing")).toBeUndefined();
  });
});
