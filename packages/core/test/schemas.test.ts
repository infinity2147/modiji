import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  DecisionContextSchema,
  HypothesisSetSchema,
  PredicateSchema,
  ScreenEventSchema,
  formatControlMessage,
  parseControlMessage,
} from "../src";

const quote = {
  kind: "expert_quote",
  utteranceId: "utt-1",
  exactQuote: "Anything over 25 percent ownership goes to enhanced review.",
  t0Ms: 1000,
  t1Ms: 4200,
  frameIds: ["frame-7"],
  eventIds: ["ev-3"],
  relation: "supports",
  provenance: "human_voice",
} as const;

const confirmation = { expertId: "exp-1", at: 1, method: "debrief", ledgerEntryId: "led-9" } as const;

const rule = {
  id: "rule-1",
  decisionFamily: "reviewOutcome",
  kind: "decision",
  predicate: { ">": [{ var: "ownershipPct" }, 25] },
  effect: { type: "recommend", action: "enhancedReview" },
  priority: 10,
  overrides: [],
  evidence: [quote],
  confirmedBy: [confirmation],
  revision: 1,
  schemaVersion: 1,
  expertId: "exp-1",
};

describe("PredicateSchema", () => {
  it("accepts nested canonical JSON-Logic", () => {
    const p = {
      and: [
        { ">=": [{ var: "ownershipPct" }, 25] },
        { or: [{ in: [{ var: "jurisdiction" }, ["XA", "XB"]] }, { "!": [{ "==": [{ var: "pep" }, false] }] }] },
      ],
    };
    expect(PredicateSchema.parse(p)).toEqual(p);
  });

  it.each([
    ["unknown operator", { xor: [true, false] }],
    ["extra key", { "==": [{ var: "a" }, 1], note: "x" }],
    ["3-arg between", { "<": [1, { var: "a" }, 3] }],
    ["empty and", { and: [] }],
    ["non-array not", { "!": { "==": [{ var: "a" }, 1] } }],
    ["empty in-list", { in: [{ var: "a" }, []] }],
    ["dotted var", { "==": [{ var: "case.a" }, 1] }],
    ["bare boolean", true],
  ])("rejects %s", (_name, p) => {
    expect(PredicateSchema.safeParse(p).success).toBe(false);
  });
});

describe("ConfirmedRuleSchema", () => {
  it("accepts a rule with a supporting expert quote", () => {
    expect(ConfirmedRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("rejects a rule without evidence", () => {
    expect(ConfirmedRuleSchema.safeParse({ ...rule, evidence: [] }).success).toBe(false);
  });

  it("rejects a rule whose first evidence is not an expert quote", () => {
    const r = { ...rule, evidence: [{ kind: "frame", frameId: "f", ledgerEntryId: "l" }] };
    expect(ConfirmedRuleSchema.safeParse(r).success).toBe(false);
  });

  it("rejects a rule whose first quote contradicts it", () => {
    expect(ConfirmedRuleSchema.safeParse({ ...rule, evidence: [{ ...quote, relation: "contradicts" }] }).success).toBe(false);
  });

  it("rejects a quote with no frames, a blank quote, or reversed timestamps", () => {
    for (const bad of [{ frameIds: [] }, { exactQuote: "   " }, { t0Ms: 5000, t1Ms: 4000 }]) {
      expect(ConfirmedRuleSchema.safeParse({ ...rule, evidence: [{ ...quote, ...bad }] }).success).toBe(false);
    }
  });

  it("rejects an unconfirmed rule and a self-override", () => {
    expect(ConfirmedRuleSchema.safeParse({ ...rule, confirmedBy: [] }).success).toBe(false);
    expect(ConfirmedRuleSchema.safeParse({ ...rule, overrides: ["rule-1"] }).success).toBe(false);
  });
});

describe("HypothesisSetSchema", () => {
  const cand = (id: string, weight: number) => ({
    id,
    hypothesisSetId: "hs-1",
    predicate: { ">": [{ var: "ownershipPct" }, 25] },
    predictedAction: "enhancedReview",
    weight,
    complexity: 1,
    origin: "enumerated",
  });
  const set = { id: "hs-1", decisionFamily: "reviewOutcome", normalizationVersion: 0, schemaVersion: 1 };

  it("requires normalised weights", () => {
    expect(HypothesisSetSchema.safeParse({ ...set, candidates: [cand("a", 0.25), cand("b", 0.75)] }).success).toBe(true);
    expect(HypothesisSetSchema.safeParse({ ...set, candidates: [cand("a", 0.25), cand("b", 0.5)] }).success).toBe(false);
  });

  it("rejects candidates from another set", () => {
    const c = { ...cand("a", 1), hypothesisSetId: "hs-2" };
    expect(HypothesisSetSchema.safeParse({ ...set, candidates: [c] }).success).toBe(false);
  });
});

describe("ScreenEventSchema", () => {
  const base = { id: "e1", frameSeq: 3, captureTime: 10, sessionEpoch: 0, confidence: 0.9, source: "vision", critical: true };
  it("requires kind-specific fields", () => {
    expect(ScreenEventSchema.safeParse({ ...base, kind: "field_change", field: "ownershipPct", to: 35 }).success).toBe(true);
    expect(ScreenEventSchema.safeParse({ ...base, kind: "field_change", field: "ownershipPct" }).success).toBe(false);
    expect(ScreenEventSchema.safeParse({ ...base, kind: "action" }).success).toBe(false);
    expect(ScreenEventSchema.safeParse({ ...base, kind: "open_case" }).success).toBe(false);
  });
});

describe("DecisionContextSchema", () => {
  it("accepts known and unknown feature values", () => {
    const ctx = {
      case: { ownershipPct: 35, jurisdiction: { unknown: true, reason: "not_visible" } },
      workflow: { priorActions: [] },
      history: { derived: {} },
      actor: { role: "analyst", id: "a1" },
      environment: { date: "2026-10-04" },
      schemaVersion: 1,
    };
    expect(DecisionContextSchema.safeParse(ctx).success).toBe(true);
    expect(DecisionContextSchema.safeParse({ ...ctx, environment: { date: "04/10/2026" } }).success).toBe(false);
  });
});

describe("control messages", () => {
  const nonce = "abcdefghijklmnopqrstuvwxyz012345";
  it("round-trips a nonce", () => {
    expect(parseControlMessage(formatControlMessage(nonce))).toBe(nonce);
  });
  it("rejects text around the control token and short nonces", () => {
    expect(parseControlMessage(`please ${formatControlMessage(nonce)}`)).toBeNull();
    expect(parseControlMessage(formatControlMessage("short"))).toBeNull();
    expect(parseControlMessage("What about ownership?")).toBeNull();
  });
});
