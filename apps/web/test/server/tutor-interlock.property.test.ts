/**
 * P6 acceptance: the Save interlock blocks 100% of violating commits. Property test (fast-check,
 * fixed seed) through the real handlers end to end on an in-memory ledger: random valid KYC cases
 * (entered through the judge-case route, so they are session cases like any other), random confirmed
 * rulebooks containing forbid rules (confirmed in an expert session, read back by the ledger-backed
 * rulebook store), random reviewer edits, every review action, with and without an override note.
 *
 * Ground truth is computed independently of `checkAction`: an action is forbidden when some forbid
 * rule for it has a true predicate and no rule overriding it has a true predicate.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FeatureIdSchema, evaluatePredicate, recordLookup, type ConfirmedRule, type Predicate } from "@vashistha/core";
import { KycCaseSchema, caseFeatures } from "@vashistha/core/domains/kyc";
import { REVIEW_OUTCOME_ACTIONS } from "../../lib/server/casedesk/session";
import { createTutorHarness, expertRule } from "../support/tutor-harness";

const ACTIONS = [...REVIEW_OUTCOME_ACTIONS];
const SEED = 20261004;

const featuresArb = fc
  .record({
    entityType: fc.constantFrom("individual", "company", "trust"),
    customerStatus: fc.constantFrom("new", "existing"),
    accountAgeMonths: fc.integer({ min: 1, max: 600 }),
    jurisdictionRisk: fc.constantFrom("low", "medium", "high"),
    uboOwnershipPct: fc.constantFrom(5, 24.9, 25, 25.1, 26, 50, 75.5, 100),
    uboVerified: fc.boolean(),
    pep: fc.boolean(),
    sanctionsHit: fc.boolean(),
    adverseMedia: fc.boolean(),
    sourceOfFunds: fc.constantFrom("verified", "unverified", "not_provided"),
    expectedMonthlyVolume: fc.constantFrom(0, 9_500, 49_500, 50_000, 50_500, 250_000),
  })
  .map((f) => ({
    ...f,
    // The domain constraints: an individual owns 100 %; a new customer has no relationship history.
    uboOwnershipPct: f.entityType === "individual" ? 100 : f.uboOwnershipPct,
    accountAgeMonths: f.customerStatus === "new" ? 0 : f.accountAgeMonths,
  }));

const ref = (feature: string) => ({ var: FeatureIdSchema.parse(feature) });

const atomArb: fc.Arbitrary<Predicate> = fc.oneof(
  fc.constantFrom("low", "medium", "high").map((v): Predicate => ({ "==": [ref("jurisdictionRisk"), v] })),
  fc.constantFrom("new", "existing").map((v): Predicate => ({ "==": [ref("customerStatus"), v] })),
  fc.constantFrom("individual", "company", "trust").map((v): Predicate => ({ "!=": [ref("entityType"), v] })),
  fc.constantFrom("uboVerified", "pep", "sanctionsHit", "adverseMedia").chain((f) => fc.boolean().map((v): Predicate => ({ "==": [ref(f), v] }))),
  fc.constantFrom("verified", "unverified", "not_provided").map((v): Predicate => ({ "==": [ref("sourceOfFunds"), v] })),
  fc.constantFrom("unrated", "low", "medium", "high").map((v): Predicate => ({ "==": [ref("riskRating"), v] })),
  fc.constantFrom(24.9, 25, 25.1, 50).map((t): Predicate => ({ ">": [ref("uboOwnershipPct"), t] })),
  fc.constantFrom(49_500, 50_000).map((t): Predicate => ({ ">=": [ref("expectedMonthlyVolume"), t] })),
  fc.constantFrom(12, 24).map((t): Predicate => ({ "<": [ref("accountAgeMonths"), t] })),
);

const predicateArb: fc.Arbitrary<Predicate> = fc.oneof(
  atomArb,
  fc.tuple(atomArb, atomArb).map(([a, b]): Predicate => ({ and: [a, b] })),
  fc.tuple(atomArb, atomArb).map(([a, b]): Predicate => ({ or: [a, b] })),
);

type Effect = Parameters<typeof expertRule>[0]["effect"];
const effectArb: fc.Arbitrary<Effect> = fc.oneof(
  fc.constantFrom(...ACTIONS).map((action): Effect => ({ type: "forbid", action })),
  fc.constantFrom(...ACTIONS).map((action): Effect => ({ type: "forbid", action })),
  fc.constant<Effect>({ type: "require_approval", role: "compliance_officer" }),
  fc.constantFrom(...ACTIONS).map((action): Effect => ({ type: "recommend", action })),
);

const rulebookArb = fc
  .tuple(
    fc.constantFrom(...ACTIONS),
    predicateArb,
    fc.array(fc.record({ effect: effectArb, predicate: predicateArb, overridesPrevious: fc.boolean() }), { maxLength: 4 }),
  )
  .map(([firstAction, firstPredicate, rest]): ConfirmedRule[] => [
    expertRule({ id: "r0", kind: "guardrail", effect: { type: "forbid", action: firstAction }, predicate: firstPredicate, quote: "Never do that here." }),
    ...rest.map((r, i) =>
      expertRule({
        id: `r${i + 1}`,
        kind: r.effect.type === "forbid" ? "guardrail" : r.effect.type === "require_approval" ? "escalation" : "decision",
        effect: r.effect,
        predicate: r.predicate,
        quote: `Rule ${i + 1} in the expert's words.`,
        overrides: r.overridesPrevious ? [`r${i}`] : [],
      }),
    ),
  ]);

/** Independent ground truth: a firing forbid rule for `action` that nothing true overrides. */
function forbidden(rules: readonly ConfirmedRule[], features: Record<string, string | number | boolean>, action: string): boolean {
  const lookup = recordLookup(features);
  const holds = (p: Predicate): boolean => evaluatePredicate(p, lookup).truth === true;
  return rules.some(
    (r) => r.effect.type === "forbid" && r.effect.action === action && holds(r.predicate) && !rules.some((o) => o.overrides.includes(r.id) && holds(o.predicate)),
  );
}

describe("Save interlock — 100% of violating commits blocked (property)", () => {
  it("never commits an action the confirmed rulebook forbids, for every action, with or without an override; commits everything else", async () => {
    let violatingAttempts = 0;
    let allowedCommits = 0;
    await fc.assert(
      fc.asyncProperty(featuresArb, rulebookArb, fc.constantFrom("unrated", "low", "medium", "high"), async (features, rules, riskRating) => {
        const h = createTutorHarness();
        await h.seedRules(rules);
        for (const action of ACTIONS) {
          const sessionId = await h.session();
          const judged = await h.judge(sessionId, features);
          expect(judged.status).toBe(201);
          const kycCase = KycCaseSchema.parse((judged.body as { case: unknown }).case);
          const edits = { riskRating };
          const truth = forbidden(rules, caseFeatures(kycCase, edits), action);

          const plain = await h.save(sessionId, kycCase.id, action, { edits });
          const overridden = await h.save(sessionId, kycCase.id, action, { edits, override: { kind: "acknowledged", note: "I accept the risk." } });
          const decisions = h.entries(sessionId, ["case.decision"]);
          if (truth) {
            violatingAttempts += 2;
            expect(plain.check.body).toMatchObject({ result: { decision: "forbid" } });
            expect(plain.commit).toMatchObject({ status: 409, body: { status: "blocked" } });
            expect(overridden.commit).toMatchObject({ status: 409, body: { status: "blocked" } });
            expect(decisions).toEqual([]);
          } else {
            const committed = plain.commit.status === 200 ? plain.commit : overridden.commit;
            expect(committed.status).toBe(200);
            expect(decisions).toHaveLength(1);
            allowedCommits += 1;
          }
        }
      }),
      { seed: SEED, numRuns: 80 },
    );
    console.info(`[P6 interlock property] violating commit attempts: ${violatingAttempts}, blocked: ${violatingAttempts} (100%); allowed commits: ${allowedCommits}`);
    expect(violatingAttempts).toBeGreaterThan(100);
    expect(allowedCommits).toBeGreaterThan(100);
  }, 120_000);
});
