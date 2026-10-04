import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  RuleConfirmedPayloadSchema,
  RuleRevisedPayloadSchema,
  checkAction,
  expertRulebook,
  planConfirmation,
  recordLookup,
  ruleIdentity,
  rulebookFromLedger,
  teamRulebook,
  unknown,
  type ActionId,
  type ConfirmedRule,
} from "../src";
import { KYC_DOMAIN } from "../src/domains/kyc";

/** The production duplicate (BUGS #9): "> 25 % unverified → enhanced review", written two ways. */
const DOCS = { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] };
const DOCS_FLIPPED = { and: [{ "==": [false, { var: "uboVerified" }] }, { "<": [25, { var: "uboOwnershipPct" }] }] };
const HIGH = { "==": [{ var: "jurisdictionRisk" }, "high"] };
const EDD = { type: "recommend", action: "enhancedReview" } as const;

function rule(id: string, expertId: string, input: { predicate: unknown; effect: unknown; utterance?: string; priority?: number; overrides?: string[]; kind?: ConfirmedRule["kind"] }): ConfirmedRule {
  const utterance = input.utterance ?? `u-${id}`;
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: "reviewOutcome",
    kind: input.kind ?? "decision",
    predicate: input.predicate,
    effect: input.effect,
    priority: input.priority ?? 10,
    overrides: input.overrides ?? [],
    evidence: [{ kind: "expert_quote", utteranceId: utterance, exactQuote: `quote ${id}`, t0Ms: 0, t1Ms: 1, frameIds: [`f-${id}`], eventIds: [], relation: "supports", provenance: "human_voice" }],
    confirmedBy: [{ expertId, at: 1, method: "explicit_statement", ledgerEntryId: utterance }],
    revision: 1,
    schemaVersion: 1,
    expertId,
  });
}

const confirmed = (r: ConfirmedRule, i: number) => ({ id: `e${i}`, source: "engine" as const, kind: "rule.confirmed", payload: RuleConfirmedPayloadSchema.parse({ rule: r }) });

describe("ruleIdentity", () => {
  it("is the decision family, the canonical predicate and the effect", () => {
    const a = rule("a", "asha", { predicate: DOCS, effect: EDD });
    expect(ruleIdentity(rule("b", "priya", { predicate: DOCS_FLIPPED, effect: EDD, priority: 99 }))).toBe(ruleIdentity(a));
    expect(ruleIdentity(rule("c", "asha", { predicate: DOCS, effect: { type: "forbid", action: "approve" } }))).not.toBe(ruleIdentity(a));
    expect(ruleIdentity(rule("d", "asha", { predicate: HIGH, effect: EDD }))).not.toBe(ruleIdentity(a));
  });
});

describe("planConfirmation (write-time de-duplication, per expert)", () => {
  const first = rule("r1", "asha", { predicate: DOCS, effect: EDD });

  it("re-confirming the same rule (written differently) revises the existing rule: revision + 1, confirmation and evidence appended", () => {
    const again = rule("r2", "asha", { predicate: DOCS_FLIPPED, effect: EDD });
    const plan = planConfirmation([first], again);
    if (plan.kind !== "merge") throw new Error(`expected a merge, got ${plan.kind}`);
    expect(plan.existing.id).toBe("r1");
    expect(plan.rule).toMatchObject({ id: "r1", revision: 2, predicate: first.predicate, expertId: "asha" });
    expect(plan.rule.evidence.map((e) => (e.kind === "expert_quote" ? e.exactQuote : e.kind))).toEqual(["quote r1", "quote r2"]);
    expect(plan.rule.confirmedBy.map((c) => c.ledgerEntryId)).toEqual(["u-r1", "u-r2"]);
    expect(plan.reason).toContain("re-confirmed by asha");
    // The fold accepts it as the next revision of the same rule: one rule, not two.
    const book = rulebookFromLedger([confirmed(first, 0), { id: "e1", source: "engine", kind: "rule.revised", payload: RuleRevisedPayloadSchema.parse({ rule: plan.rule, reason: plan.reason }) }]);
    expect(book.rejected).toEqual([]);
    expect(book.rules.map((r) => [r.id, r.revision])).toEqual([["r1", 2]]);
  });

  it("is a duplicate when nothing new would be added: the same words over the same screen, re-submitted", () => {
    expect(planConfirmation([first], { ...first, id: "r3" })).toEqual({ kind: "duplicate", existing: first });
    const [quote] = first.evidence;
    const resubmitted = ConfirmedRuleSchema.parse({ ...first, id: "r3", evidence: [{ ...quote, utteranceId: "u-again", t0Ms: 5, t1Ms: 9 }], confirmedBy: [{ ...first.confirmedBy[0], ledgerEntryId: "u-again" }] });
    expect(planConfirmation([first], resubmitted).kind).toBe("duplicate");
  });

  it("keeps identical rules of different experts separate, and new rules new", () => {
    const priya = rule("p1", "priya", { predicate: DOCS, effect: EDD });
    expect(planConfirmation([first], priya)).toEqual({ kind: "new", rule: priya });
    const other = rule("r4", "asha", { predicate: HIGH, effect: EDD });
    expect(planConfirmation([first], other)).toEqual({ kind: "new", rule: other });
  });

  it("merges into a reconciled rule both experts confirmed, from either expert", () => {
    const reconciled = ConfirmedRuleSchema.parse({ ...first, confirmedBy: [...first.confirmedBy, { expertId: "priya", at: 2, method: "debrief", ledgerEntryId: "u-p" }] });
    expect(planConfirmation([reconciled], rule("p2", "priya", { predicate: DOCS_FLIPPED, effect: EDD })).kind).toBe("merge");
  });

  it("unites override edges and keeps the higher priority, never letting the rule override itself", () => {
    const plan = planConfirmation([first], rule("r5", "asha", { predicate: DOCS, effect: EDD, priority: 30, overrides: ["x", "r1"] }));
    if (plan.kind !== "merge") throw new Error("expected a merge");
    expect(plan.rule.overrides).toEqual(["x"]);
    expect(plan.rule.priority).toBe(30);
  });
});

describe("team rulebook merges semantically identical rules of different experts", () => {
  const asha = rule("asha-docs", "asha", { predicate: DOCS, effect: EDD });
  const priya = rule("priya-docs", "priya", { predicate: DOCS_FLIPPED, effect: EDD });
  const forbid = rule("priya-forbid", "priya", { predicate: HIGH, effect: { type: "forbid", action: "approve" }, kind: "guardrail", priority: 40 });
  const ashaForbid = rule("asha-forbid", "asha", { predicate: HIGH, effect: { type: "forbid", action: "approve" }, kind: "guardrail", priority: 40 });
  const book = rulebookFromLedger([asha, priya, forbid, ashaForbid].map(confirmed));

  it("shows each rule once, carrying both experts' confirmations and quotes; per-expert books keep both", () => {
    const team = teamRulebook(book, []);
    expect(team.rules.map((r) => r.id)).toEqual(["asha-docs", "priya-forbid"]);
    expect(team.merged).toEqual([
      { ruleId: "priya-docs", into: "asha-docs" },
      { ruleId: "asha-forbid", into: "priya-forbid" },
    ]);
    const docs = team.rules[0];
    expect(docs?.revision).toBe(1);
    expect(docs?.confirmedBy.map((c) => c.expertId)).toEqual(["asha", "priya"]);
    expect(docs?.evidence.flatMap((e) => (e.kind === "expert_quote" ? [e.exactQuote] : []))).toEqual(["quote asha-docs", "quote priya-docs"]);
    expect(team.revision).toBe(book.revision);
    expect(expertRulebook(book, "priya").rules.map((r) => r.id)).toEqual(["priya-docs", "priya-forbid"]);
    // A check cites the one rule and both experts' quotes.
    const result = checkAction({ rules: team.rules, features: recordLookup({ jurisdictionRisk: "high" }), action: "approve" as ActionId, domain: KYC_DOMAIN });
    expect(result).toMatchObject({ decision: "forbid", matchedRules: ["priya-forbid"] });
    expect(result.evidence.map((e) => e.exactQuote)).toEqual(["quote priya-forbid", "quote asha-forbid"]);
  });

  it("does not merge rules whose override edges differ, so no exception is extended to the other expert's guardrail", () => {
    const exception = rule("asha-exc", "asha", { predicate: { "==": [{ var: "customerStatus" }, "existing"] }, effect: { type: "recommend", action: "approve" }, kind: "exception", priority: 30, overrides: ["asha-forbid"] });
    const withException = rulebookFromLedger([forbid, ashaForbid, exception].map(confirmed));
    const team = teamRulebook(withException, []);
    expect(team.rules.map((r) => r.id)).toEqual(["priya-forbid", "asha-forbid", "asha-exc"]);
    expect(team.merged).toEqual([]);
  });

  it("changes no decision: every check over the merged team rulebook equals the check over all rules", () => {
    const lift = rule("lift", "asha", { predicate: { ">=": [{ var: "accountAgeMonths" }, 24] }, effect: { type: "recommend", action: "approve" }, priority: 30, overrides: ["priya-forbid", "asha-forbid"] });
    const approval = rule("pep-a", "asha", { predicate: { "==": [{ var: "pep" }, true] }, effect: { type: "require_approval", role: "compliance" }, kind: "escalation", priority: 20 });
    const approvalP = rule("pep-p", "priya", { predicate: { "==": [true, { var: "pep" }] }, effect: { type: "require_approval", role: "compliance" }, kind: "escalation", priority: 20 });
    const all = rulebookFromLedger([asha, priya, forbid, ashaForbid, lift, approval, approvalP].map(confirmed));
    const team = teamRulebook(all, []);
    expect(team.merged.map((m) => m.ruleId)).toEqual(["priya-docs", "asha-forbid", "pep-p"]);
    // A feature value, or not extracted (unknown).
    const known = <T extends string | number | boolean>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: unknown("not_extracted") });
    fc.assert(
      fc.property(
        known(fc.constantFrom("low", "medium", "high")),
        known(fc.integer({ min: 0, max: 60 })),
        known(fc.boolean()),
        fc.constantFrom("approve", "enhancedReview", "reject", "requestDocuments"),
        (jurisdictionRisk, accountAgeMonths, pep, action) => {
          const features = recordLookup({ jurisdictionRisk, accountAgeMonths, pep });
          const check = (rules: readonly ConfirmedRule[]) => {
            const r = checkAction({ rules, features, action: action as ActionId, domain: KYC_DOMAIN });
            return { decision: r.decision, missingFeatures: r.missingFeatures, quotes: r.evidence.map((e) => e.exactQuote).sort() };
          };
          expect(check(team.rules)).toEqual(check(all.rules));
        },
      ),
      { seed: 20261004, numRuns: 300 },
    );
  });
});
