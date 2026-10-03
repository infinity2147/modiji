import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ActionIdSchema,
  ConfirmedRuleSchema,
  checkAction,
  evaluatePredicate,
  loadDomainConfig,
  unknown,
  type ConfirmedRule,
  type FeatureLookup,
  type FeatureValue,
  type Predicate,
} from "../src";
import { lookupFrom } from "./helpers";

const RUNS = { seed: 20261004, numRuns: 500 };
const FEATURES = ["f0", "f1", "f2", "f3"] as const;
const ACTIONS = ["a0", "a1", "a2"] as const;

const DOMAIN = loadDomainConfig({
  id: "prop",
  title: "Property domain",
  features: FEATURES.map((id) => ({ id, label: id, source: "case", type: "boolean" })),
  actions: ACTIONS.map((id) => ({ id, label: id, terminal: true })),
  decisionFamilies: [{ id: "fam", label: "Family", actions: [...ACTIONS] }],
  domainConstraints: [],
  criticalFields: [],
});

const leafArb = fc.record({ f: fc.constantFrom(...FEATURES), v: fc.boolean() }).map(({ f, v }) => ({ "==": [{ var: f }, v] }));
const predicateArb: fc.Arbitrary<unknown> = fc.letrec<{ p: unknown }>((tie) => ({
  p: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leafArb,
    fc.array(tie("p"), { minLength: 1, maxLength: 3 }).map((xs) => ({ and: xs })),
    fc.array(tie("p"), { minLength: 1, maxLength: 3 }).map((xs) => ({ or: xs })),
    tie("p").map((x) => ({ "!": [x] })),
  ),
})).p;

type RawRule = { predicate: unknown; effect: unknown; overrides: number[] };

const forbidEffectArb = fc.constantFrom(...ACTIONS).map((action) => ({ type: "forbid", action }));
const anyEffectArb = fc.oneof(
  forbidEffectArb,
  fc.constant({ type: "require_approval", role: "supervisor" }),
  fc.constantFrom(...ACTIONS).map((action) => ({ type: "recommend", action })),
);

function rulebookArb(effectArb: fc.Arbitrary<unknown>): fc.Arbitrary<ConfirmedRule[]> {
  return fc
    .array(fc.record({ predicate: predicateArb, effect: effectArb, overrides: fc.uniqueArray(fc.nat({ max: 5 }), { maxLength: 2 }) }), {
      maxLength: 6,
    })
    .map((raws: RawRule[]) =>
      raws.map((r, i) =>
        ConfirmedRuleSchema.parse({
          id: `r${i}`,
          decisionFamily: "fam",
          kind: "guardrail",
          predicate: r.predicate,
          effect: r.effect,
          priority: 1,
          overrides: r.overrides.filter((j) => j !== i && j < raws.length).map((j) => `r${j}`),
          evidence: [
            {
              kind: "expert_quote",
              utteranceId: `u${i}`,
              exactQuote: `quote ${i}`,
              t0Ms: 0,
              t1Ms: 1,
              frameIds: [`fr${i}`],
              eventIds: [],
              relation: "supports",
              provenance: "human_voice",
            },
          ],
          confirmedBy: [{ expertId: "e", at: 0, method: "debrief", ledgerEntryId: `l${i}` }],
          revision: 1,
          schemaVersion: 1,
          expertId: "e",
        }),
      ),
    );
}

const truthValueArb: fc.Arbitrary<FeatureValue> = fc.oneof(fc.boolean(), fc.constant(unknown("not_visible")));
const partialArb = fc.tuple(...FEATURES.map(() => truthValueArb)).map((vs) => Object.fromEntries(FEATURES.map((f, i) => [f, vs[i]!])));
/** A partial assignment plus a completion of it (every unknown replaced by a boolean). */
const partialAndCompletionArb = fc
  .tuple(partialArb, fc.tuple(...FEATURES.map(() => fc.boolean())))
  .map(([partial, fill]) => ({
    partial,
    complete: Object.fromEntries(FEATURES.map((f, i) => [f, typeof partial[f] === "boolean" ? partial[f] : fill[i]!])),
  }));

const truthOf = (p: Predicate, lookup: FeatureLookup) => evaluatePredicate(p, lookup).truth;

describe("checkAction properties", () => {
  it("forbid-only rulebooks: forbid iff some rule forbidding the action is true and none of its overriders is true or unknown", () => {
    fc.assert(
      fc.property(rulebookArb(forbidEffectArb), partialArb, fc.constantFrom(...ACTIONS), (rules, values, a) => {
        const features = lookupFrom(values);
        const action = ActionIdSchema.parse(a);
        const expected = rules.some(
          (r) =>
            r.effect.type === "forbid" &&
            r.effect.action === action &&
            truthOf(r.predicate, features) === true &&
            rules.every((o) => !o.overrides.includes(r.id) || truthOf(o.predicate, features) === false),
        );
        expect(checkAction({ rules, features, action, domain: DOMAIN }).decision === "forbid").toBe(expected);
      }),
      RUNS,
    );
  });

  it("forbid-only rulebooks: filling in unknown features never turns a forbid into anything else", () => {
    fc.assert(
      fc.property(rulebookArb(forbidEffectArb), partialAndCompletionArb, fc.constantFrom(...ACTIONS), (rules, { partial, complete }, a) => {
        const action = ActionIdSchema.parse(a);
        const before = checkAction({ rules, features: lookupFrom(partial), action, domain: DOMAIN });
        fc.pre(before.decision === "forbid");
        expect(checkAction({ rules, features: lookupFrom(complete), action, domain: DOMAIN }).decision).toBe("forbid");
      }),
      { ...RUNS, numRuns: 300 },
    );
  });

  it("any rulebook: every decision except insufficient_information is stable under filling in unknowns", () => {
    fc.assert(
      fc.property(rulebookArb(anyEffectArb), partialAndCompletionArb, fc.constantFrom(...ACTIONS), (rules, { partial, complete }, a) => {
        const action = ActionIdSchema.parse(a);
        const before = checkAction({ rules, features: lookupFrom(partial), action, domain: DOMAIN });
        const after = checkAction({ rules, features: lookupFrom(complete), action, domain: DOMAIN });
        if (before.decision !== "insufficient_information") expect(after.decision).toBe(before.decision);
        // On a complete case the decision is never "insufficient_information".
        expect(after.decision).not.toBe("insufficient_information");
        expect(after.missingFeatures).toEqual([]);
      }),
      RUNS,
    );
  });

  it("supplying the reported missing features always settles insufficient_information", () => {
    fc.assert(
      fc.property(rulebookArb(anyEffectArb), partialAndCompletionArb, fc.constantFrom(...ACTIONS), (rules, { partial, complete }, a) => {
        const action = ActionIdSchema.parse(a);
        const before = checkAction({ rules, features: lookupFrom(partial), action, domain: DOMAIN });
        fc.pre(before.decision === "insufficient_information");
        const supplied = { ...partial, ...Object.fromEntries(before.missingFeatures.map((f) => [f, complete[f]!])) };
        const after = checkAction({ rules, features: lookupFrom(supplied), action, domain: DOMAIN });
        expect(after.decision === "insufficient_information" && after.matchedRules.join() === before.matchedRules.join()).toBe(false);
      }),
      { ...RUNS, numRuns: 300 },
    );
  });
});
