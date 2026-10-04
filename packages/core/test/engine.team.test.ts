import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  RuleConfirmedPayloadSchema,
  RuleRevisedPayloadSchema,
  checkAction,
  expertRulebook,
  recordLookup,
  ruleExperts,
  rulebookFromLedger,
  teamRulebook,
  type ActionId,
  type ConfirmedRule,
  type DisagreementHold,
} from "../src";
import { KYC_DOMAIN } from "../src/domains/kyc";

const HIGH = { "==": [{ var: "jurisdictionRisk" }, "high"] };
const LONG_STANDING = { and: [{ "==": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 24] }, HIGH] };

function rule(id: string, expertId: string, input: { predicate: unknown; effect: unknown; kind?: ConfirmedRule["kind"]; priority?: number; overrides?: string[]; also?: string[] }): ConfirmedRule {
  const confirmer = (e: string) => ({ expertId: e, at: 1, method: "debrief" as const, ledgerEntryId: `u-${e}` });
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: "reviewOutcome",
    kind: input.kind ?? "decision",
    predicate: input.predicate,
    effect: input.effect,
    priority: input.priority ?? 10,
    overrides: input.overrides ?? [],
    evidence: [{ kind: "expert_quote", utteranceId: `u-${id}`, exactQuote: `quote ${id}`, t0Ms: 0, t1Ms: 1, frameIds: ["f"], eventIds: [], relation: "supports", provenance: "human_text" }],
    confirmedBy: [confirmer(expertId), ...(input.also ?? []).map(confirmer)],
    revision: 1,
    schemaVersion: 1,
    expertId,
  });
}

const ASHA_EDD = rule("asha-edd", "asha", { predicate: HIGH, effect: { type: "recommend", action: "enhancedReview" } });
const ASHA_EXC = rule("asha-exc", "asha", { predicate: LONG_STANDING, effect: { type: "recommend", action: "approve" }, kind: "exception", priority: 30, overrides: ["asha-edd"] });
const PRIYA_EDD = rule("priya-edd", "priya", { predicate: HIGH, effect: { type: "recommend", action: "enhancedReview" } });
const PRIYA_FORBID = rule("priya-forbid", "priya", { predicate: HIGH, effect: { type: "forbid", action: "approve" }, kind: "guardrail", priority: 40 });

const confirmed = (r: ConfirmedRule, i: number) => ({ id: `e${i}`, source: "engine" as const, kind: "rule.confirmed", payload: RuleConfirmedPayloadSchema.parse({ rule: r }) });

const CASE = {
  entityType: "company",
  customerStatus: "existing",
  accountAgeMonths: 36,
  jurisdictionRisk: "high",
  uboOwnershipPct: 20,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 10_000,
  riskRating: "high",
};

describe("per-expert rulebooks (plan §7.10)", () => {
  const book = rulebookFromLedger([ASHA_EDD, ASHA_EXC, PRIYA_EDD, PRIYA_FORBID].map(confirmed));

  it("an expert's book holds the rules they authored or confirmed, with its own revision count", () => {
    const asha = expertRulebook(book, "asha");
    const priya = expertRulebook(book, "priya");
    expect(asha.rules.map((r) => r.id)).toEqual(["asha-edd", "asha-exc"]);
    expect(priya.rules.map((r) => r.id)).toEqual(["priya-edd", "priya-forbid"]);
    expect([asha.revision, priya.revision, book.revision]).toEqual([2, 2, 4]);
    expect(priya.history.map((h) => [h.ruleId, h.rulebookRevision])).toEqual([
      ["priya-edd", 1],
      ["priya-forbid", 2],
    ]);
  });

  it("a rule reconciled by both experts (both in confirmedBy) is in both books", () => {
    const after = ConfirmedRuleSchema.parse({ ...PRIYA_EDD, revision: 2, overrides: ["asha-exc"], confirmedBy: [...PRIYA_EDD.confirmedBy, { expertId: "asha", at: 2, method: "debrief", ledgerEntryId: "u-asha-2" }] });
    const revised = rulebookFromLedger([
      ...[ASHA_EDD, ASHA_EXC, PRIYA_EDD].map(confirmed),
      { id: "e9", source: "engine", kind: "rule.revised", payload: RuleRevisedPayloadSchema.parse({ rule: after, reason: "reconciled" }) },
    ]);
    expect(ruleExperts(after)).toEqual(["priya", "asha"]);
    expect(expertRulebook(revised, "asha").rules.map((r) => r.id)).toEqual(["asha-edd", "asha-exc", "priya-edd"]);
    expect(expertRulebook(revised, "asha").history.at(-1)).toMatchObject({ kind: "revised", ruleId: "priya-edd", rulebookRevision: 3 });
    expect(expertRulebook(revised, "priya").revision).toBe(2);
  });
});

describe("team rulebook during an open disagreement", () => {
  const book = rulebookFromLedger([ASHA_EDD, ASHA_EXC, PRIYA_EDD, PRIYA_FORBID].map(confirmed));
  const hold: DisagreementHold = { witnessId: "w1", decisionFamily: "reviewOutcome", experts: ["asha", "priya"], assignment: CASE };

  it("holds back the disagreeing experts' decision rules that apply to the case, never a guardrail", () => {
    const team = teamRulebook(book, [hold]);
    expect(team.rules.map((r) => r.id)).toEqual(["priya-forbid"]);
    expect(team.held.map((h) => h.ruleId)).toEqual(["asha-edd", "asha-exc", "priya-edd"]);
    expect(team.revision).toBe(book.revision);
    expect(teamRulebook(book, []).rules).toHaveLength(4);
  });

  it("a forbid from one expert stays enforced while the experts disagree", () => {
    const team = teamRulebook(book, [hold]);
    const result = checkAction({ rules: team.rules, features: recordLookup(CASE), action: "approve" as ActionId, domain: KYC_DOMAIN });
    expect(result.decision).toBe("forbid");
    expect(result.matchedRules).toEqual(["priya-forbid"]);
  });

  it("safety is monotonic: holding back never makes checkAction less restrictive (rules that override guardrails included)", () => {
    // An exception that overrides the forbid: holding it back must re-enable the forbid, never remove it.
    const lifting = rule("asha-lift", "asha", { predicate: LONG_STANDING, effect: { type: "recommend", action: "approve" }, priority: 30, overrides: ["priya-forbid"] });
    const full = rulebookFromLedger([ASHA_EDD, ASHA_EXC, PRIYA_EDD, PRIYA_FORBID, lifting].map(confirmed));
    const rank = { allow: 0, insufficient_information: 1, needs_approval: 1, forbid: 2 } as const;
    const values = { customerStatus: ["new", "existing"], jurisdictionRisk: ["low", "medium", "high"] } as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...values.customerStatus),
        fc.integer({ min: 0, max: 60 }),
        fc.constantFrom(...values.jurisdictionRisk),
        fc.constantFrom("approve", "enhancedReview", "reject"),
        fc.boolean(),
        (customerStatus, months, jurisdictionRisk, action, holdOpen) => {
          const features = recordLookup({ ...CASE, customerStatus, accountAgeMonths: customerStatus === "new" ? 0 : Math.max(1, months), jurisdictionRisk });
          const check = (rules: readonly ConfirmedRule[]) => checkAction({ rules, features, action: action as ActionId, domain: KYC_DOMAIN }).decision;
          const without = check(full.rules);
          const withHold = check(teamRulebook(full, holdOpen ? [hold] : []).rules);
          expect(rank[withHold]).toBeGreaterThanOrEqual(rank[without]);
        },
      ),
      { seed: 20261004, numRuns: 400 },
    );
    // The concrete case: without the hold the exception lifts the forbid; with it, the forbid applies.
    const approve = (rules: readonly ConfirmedRule[]) => checkAction({ rules, features: recordLookup(CASE), action: "approve" as ActionId, domain: KYC_DOMAIN }).decision;
    expect(approve(full.rules)).toBe("allow");
    expect(approve(teamRulebook(full, [hold]).rules)).toBe("forbid");
  });
});
