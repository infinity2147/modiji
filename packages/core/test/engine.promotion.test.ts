import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  RULE_EVENT_KINDS,
  diffRules,
  promoteToConfirmedRule,
  rulebookFromLedger,
  type CandidateRule,
  type ConfirmedRule,
  type ExpertQuoteEvidence,
  type LedgerEntry,
  type LedgerReader,
  type LedgerSource,
  type PromotionError,
  type StatedRule,
  StatedRuleSchema,
} from "../src";
import { KYC } from "./engine.fixtures";

const ENTRIES: Record<string, { source: LedgerSource; kind: string }> = {
  "utt-voice": { source: "voice", kind: "utterance.transcript" },
  "utt-typed": { source: "expert", kind: "expert.statement" },
  "utt-ctl": { source: "system_control", kind: "gate.control_message" },
  "utt-vision": { source: "vision", kind: "screen.event" },
  "frame-1": { source: "client", kind: "frame.received" },
  "frame-ctl": { source: "system_control", kind: "frame.received" },
  "event-1": { source: "vision", kind: "screen.event" },
  "event-dom": { source: "dom", kind: "screen.event" },
  "confirm-1": { source: "voice", kind: "utterance.transcript" },
  "decision-1": { source: "dom", kind: "case.decision" },
};
const LEDGER: LedgerReader = { get: (id) => (ENTRIES[id] === undefined ? undefined : { id, ...ENTRIES[id] }) };

const QUOTE: ExpertQuoteEvidence = {
  kind: "expert_quote",
  utteranceId: "utt-voice",
  exactQuote: "Anything over a quarter that isn't verified goes to enhanced review.",
  t0Ms: 61_200,
  t1Ms: 64_900,
  frameIds: ["frame-1"],
  eventIds: ["event-1", "event-dom"],
  relation: "supports",
  provenance: "human_voice",
};
const CANDIDATE = {
  id: "cand_1",
  hypothesisSetId: "hs-review",
  predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] },
  predictedAction: "enhancedReview",
  weight: 0.6,
  complexity: 2,
  origin: "enumerated",
} as unknown as CandidateRule;

const promote = (over: Partial<Parameters<typeof promoteToConfirmedRule>[0]> = {}) =>
  promoteToConfirmedRule({
    ruleId: "rule-ownership",
    domain: KYC,
    decisionFamily: "reviewOutcome",
    source: { candidate: CANDIDATE },
    priority: 10,
    overrides: [],
    evidence: [QUOTE],
    links: [{ kind: "observed_decision", ledgerEntryId: "decision-1" }],
    confirmation: { expertId: "expert-1", at: 1_760_000_000_000, method: "debrief", ledgerEntryId: "confirm-1" },
    expertId: "expert-1",
    schemaVersion: 1,
    ledger: LEDGER,
    ...over,
  });
const codes = (r: ReturnType<typeof promote>): PromotionError["code"][] => (r.ok ? [] : r.errors.map((e) => e.code));

describe("promoteToConfirmedRule", () => {
  it("builds a ConfirmedRule (revision 1) from a candidate with ledger-checked evidence", () => {
    const r = promote();
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(ConfirmedRuleSchema.safeParse(r.rule).success).toBe(true);
    expect(r.rule).toMatchObject({ revision: 1, kind: "decision", effect: { type: "recommend", action: "enhancedReview" }, evidence: [QUOTE, { kind: "observed_decision" }] });
  });

  it("promotes an explicitly stated rule whose quote is in the evidence; typed text counts as the expert's words", () => {
    const rule: StatedRule = StatedRuleSchema.parse({
      predicate: CANDIDATE.predicate,
      action: "approve",
      kind: "guardrail",
      effect: { type: "forbid", action: "approve" },
      exactQuote: "over a quarter that isn't verified",
      t0Ms: 61_200,
      t1Ms: 64_900,
    });
    const r = promote({ source: { statedRule: rule }, evidence: [{ ...QUOTE, utteranceId: "utt-typed", provenance: "human_text" }] });
    // The stated effect is carried through: a prohibition stays a prohibition.
    expect(r.ok && { kind: r.rule.kind, effect: r.rule.effect, priority: r.rule.priority }).toEqual({ kind: "guardrail", effect: { type: "forbid", action: "approve" }, priority: 10 });
    expect(codes(promote({ source: { statedRule: { ...rule, exactQuote: "never approve these" } } }))).toEqual(["stated_quote_not_in_evidence"]);
  });

  it("rejects a system_control (or non-expert) utterance", () => {
    expect(promote({ evidence: [{ ...QUOTE, utteranceId: "utt-ctl" }] })).toEqual({
      ok: false,
      errors: [{ code: "utterance_not_expert", evidenceIndex: 0, utteranceId: "utt-ctl", source: "system_control" }],
    });
    expect(codes(promote({ evidence: [{ ...QUOTE, utteranceId: "utt-vision" }] }))).toEqual(["utterance_not_expert"]);
    expect(codes(promote({ evidence: [{ ...QUOTE, utteranceId: "utt-missing" }] }))).toEqual(["utterance_missing"]);
  });

  it("rejects missing or control frames and events", () => {
    expect(codes(promote({ evidence: [{ ...QUOTE, frameIds: ["frame-1", "frame-gone"] }] }))).toEqual(["frame_missing"]);
    expect(codes(promote({ evidence: [{ ...QUOTE, frameIds: ["frame-ctl"] }] }))).toEqual(["not_evidence"]);
    // Frames are real redacted screen frames: a DOM event (or any other entry) never stands in for one.
    expect(promote({ evidence: [{ ...QUOTE, frameIds: ["event-dom"] }] })).toEqual({
      ok: false,
      errors: [{ code: "not_a_frame", evidenceIndex: 0, frameId: "event-dom", kind: "screen.event" }],
    });
    expect(codes(promote({ evidence: [{ ...QUOTE, eventIds: ["event-gone"] }] }))).toEqual(["event_missing"]);
    expect(codes(promote({ links: [{ kind: "frame", frameId: "f", ledgerEntryId: "nowhere" }] }))).toEqual(["link_missing"]);
  });

  it("rejects a blank quote, reversed timestamps, no evidence, a contradicting first quote, and a missing confirmation", () => {
    expect(codes(promote({ evidence: [{ ...QUOTE, exactQuote: "   " }] }))).toEqual(["blank_quote"]);
    expect(codes(promote({ evidence: [{ ...QUOTE, t0Ms: 5_000, t1Ms: 4_000 }] }))).toEqual(["reversed_timestamps"]);
    expect(codes(promote({ evidence: [] }))).toEqual(["first_evidence_not_supporting"]);
    expect(codes(promote({ evidence: [{ ...QUOTE, relation: "contradicts" }] }))).toEqual(["first_evidence_not_supporting"]);
    expect(codes(promote({ confirmation: { expertId: "expert-1", at: 1, method: "debrief", ledgerEntryId: "utt-ctl" } }))).toEqual(["confirmation_missing"]);
  });

  it("rejects a predicate that does not type-check and an action outside the family, reporting everything at once", () => {
    const bad = { ...CANDIDATE, predicate: { ">": [{ var: "ownerTenure" }, 3] }, predictedAction: "rateHigh" } as unknown as CandidateRule;
    expect(codes(promote({ source: { candidate: bad }, evidence: [{ ...QUOTE, exactQuote: "" }] }))).toEqual(["predicate_invalid", "action_not_in_family", "blank_quote"]);
  });
});

describe("rulebook", () => {
  const promoted = promote();
  if (!promoted.ok) throw new Error("fixture");
  const rule = promoted.rule;
  const revised: ConfirmedRule = { ...rule, predicate: { and: [{ ">=": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] } as never, revision: 2 };
  const other: ConfirmedRule = { ...rule, id: "rule-pep", predicate: { "==": [{ var: "pep" }, true] } as never, effect: { type: "recommend", action: "escalateCompliance" as never } };
  let seq = 0;
  const entry = (kind: string, payload: unknown, source: LedgerSource = "expert"): Pick<LedgerEntry, "id" | "source" | "kind" | "payload"> => ({ id: `e${++seq}`, source, kind, payload });

  it("folds confirmations, revisions (revision++, diff kept) and retirements", () => {
    const book = rulebookFromLedger([
      entry(RULE_EVENT_KINDS.confirmed, { rule }),
      entry("screen.event", { anything: true }),
      entry(RULE_EVENT_KINDS.confirmed, { rule: other }, "engine"),
      entry(RULE_EVENT_KINDS.revised, { rule: revised, reason: "expert: 25% exactly also counts" }),
      entry(RULE_EVENT_KINDS.retired, { ruleId: "rule-pep", reason: "covered by the escalation guardrail" }),
    ]);
    expect(book.rejected).toEqual([]);
    expect(book.revision).toBe(4);
    expect(book.rules).toEqual([revised]);
    const revision = book.history.find((h) => h.kind === "revised");
    expect(revision?.kind === "revised" && revision.fields).toEqual(["predicate", "revision"]);
    expect(book.history.map((h) => [h.kind, h.rulebookRevision])).toEqual([
      ["confirmed", 1],
      ["confirmed", 2],
      ["revised", 3],
      ["retired", 4],
    ]);
  });

  it("rejects control-sourced, invalid, out-of-order and duplicate events with reasons", () => {
    const book = rulebookFromLedger([
      entry(RULE_EVENT_KINDS.confirmed, { rule }, "system_control"),
      entry(RULE_EVENT_KINDS.confirmed, { rule: { ...rule, evidence: [] } }),
      entry(RULE_EVENT_KINDS.revised, { rule: revised, reason: "too early" }),
      entry(RULE_EVENT_KINDS.confirmed, { rule }),
      entry(RULE_EVENT_KINDS.confirmed, { rule }),
      entry(RULE_EVENT_KINDS.revised, { rule: { ...revised, revision: 3 }, reason: "skips a revision" }),
      entry(RULE_EVENT_KINDS.retired, { ruleId: "rule-unknown", reason: "?" }),
    ]);
    expect(book.rules).toEqual([rule]);
    expect(book.revision).toBe(1);
    expect(book.rejected.map((r) => r.reason.split(":")[0])).toEqual([
      'rule events must come from the engine or the expert, not "system_control"',
      "invalid payload",
      "rule rule-ownership is not live",
      "rule rule-ownership was already confirmed",
      "rule rule-ownership is at revision 1; a revision must be 2, got 3",
      "rule rule-unknown is not live",
    ]);
  });

  it("diffRules reports added, removed and field-level changes", () => {
    const third: ConfirmedRule = { ...other, id: "rule-sanctions" };
    const diff = diffRules([rule, other], [revised, third]);
    expect(diff.added.map((r) => r.id)).toEqual(["rule-sanctions"]);
    expect(diff.removed.map((r) => r.id)).toEqual(["rule-pep"]);
    expect(diff.changed).toEqual([{ id: "rule-ownership", before: rule, after: revised, fields: ["predicate", "revision"] }]);
    expect(diffRules([rule], [rule])).toEqual({ added: [], removed: [], changed: [] });
  });
});
