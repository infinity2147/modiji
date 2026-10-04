import fc from "fast-check";
import jsonLogic from "json-logic-js";
import { describe, expect, it } from "vitest";
import { evaluatePredicate, typecheckPredicate, unknown, type FeatureValue, type Value } from "../src";
import { lookupFrom } from "./helpers";
import { assignmentArb, scenarioArb } from "./predicate-arb";

const RUNS = { seed: 20261004, numRuns: 400 };

describe("evaluatePredicate properties", () => {
  it("agrees with json-logic-js on well-typed predicates over fully known data", () => {
    fc.assert(
      fc.property(scenarioArb, ({ features, predicate, values }) => {
        expect(typecheckPredicate(predicate, features)).toEqual([]);
        const ours = evaluatePredicate(predicate, lookupFrom(values));
        expect(ours).toEqual({ truth: jsonLogic.truthy(jsonLogic.apply(predicate, values)), unknownFeatures: [] });
      }),
      RUNS,
    );
  });

  it("is sound and monotone under partial information, and unknownFeatures suffices to decide", () => {
    const partialArb = scenarioArb.chain((s) =>
      fc.record({
        scenario: fc.constant(s),
        hidden: fc.subarray(s.features.map((f) => f.id)),
        completions: fc.array(assignmentArb(s.features), { minLength: 1, maxLength: 4 }),
      }),
    );
    fc.assert(
      fc.property(partialArb, ({ scenario: { predicate, values }, hidden, completions }) => {
        const withHidden = (fill: (id: string) => FeatureValue): Record<string, FeatureValue> => ({
          ...values,
          ...Object.fromEntries(hidden.map((id) => [id, fill(id)])),
        });
        const partial = evaluatePredicate(predicate, lookupFrom(withHidden(() => unknown("not_visible"))));

        for (const completion of completions) {
          const pick = (id: string): Value => completion[id] ?? fail(id);
          if (partial.truth === "unknown") {
            expect(partial.unknownFeatures.length).toBeGreaterThan(0);
            expect(hidden).toEqual(expect.arrayContaining(partial.unknownFeatures));
            // Revealing only the reported features is enough to reach a boolean.
            const missing = new Set<string>(partial.unknownFeatures);
            const revealed = withHidden((id) => (missing.has(id) ? pick(id) : unknown("not_visible")));
            expect(typeof evaluatePredicate(predicate, lookupFrom(revealed)).truth).toBe("boolean");
          } else {
            expect(partial.unknownFeatures).toEqual([]);
            expect(evaluatePredicate(predicate, lookupFrom(withHidden(pick))).truth).toBe(partial.truth);
          }
        }
      }),
      RUNS,
    );
  });
});

function fail(id: string): never {
  throw new Error(`no generated value for ${id}`);
}
