import fc from "fast-check";
import jsonLogic from "json-logic-js";
import { describe, expect, it } from "vitest";
import {
  COMPARISON_OPS,
  evaluatePredicate,
  typecheckPredicate,
  unknown,
  type Feature,
  type FeatureValue,
  type Predicate,
  type Value,
} from "../src";
import { features as parseFeatures, lookupFrom, pred } from "./helpers";

const ENUM_POOL = ["red", "green", "blue", "amber"];
const STRING_POOL = ["alpha", "beta", "gamma", ""];
const RUNS = { seed: 20261004, numRuns: 400 };

const featureBodyArb = fc.oneof(
  fc
    .record({ min: fc.integer({ min: -20, max: 20 }), span: fc.integer({ min: 0, max: 10 }), integer: fc.boolean() })
    .map(({ min, span, integer }) => ({ type: "number", min, max: min + span, integer })),
  fc.constant({ type: "boolean" }),
  fc.subarray(ENUM_POOL, { minLength: 1 }).map((values) => ({ type: "enum", values })),
  fc.constant({ type: "string" }),
);

const featuresArb: fc.Arbitrary<Feature[]> = fc
  .array(featureBodyArb, { minLength: 1, maxLength: 5 })
  .map((bodies) =>
    parseFeatures(bodies.map((b, i) => ({ id: `f${i}`, label: `Feature ${i}`, source: i % 2 === 0 ? "case" : "derived", ...b }))),
  );

/** In-domain values; numbers favour integers so that equality is hit regularly. */
function valueArb(f: Feature): fc.Arbitrary<Value> {
  switch (f.type) {
    case "number": {
      const ints = fc.integer({ min: f.min, max: f.max });
      return f.integer ? ints : fc.oneof(ints, fc.double({ min: f.min, max: f.max, noNaN: true }));
    }
    case "boolean":
      return fc.boolean();
    case "enum":
      return fc.constantFrom(...f.values);
    case "string":
      return fc.constantFrom(...STRING_POOL);
  }
}

const comparable = (f: Feature, g: Feature): boolean =>
  f.type === g.type && (f.type !== "enum" || (g.type === "enum" && f.values.join() === g.values.join()));

function leafArb(fs: readonly Feature[]): fc.Arbitrary<Predicate> {
  return fc.constantFrom(...fs).chain((f) => {
    const v = { var: f.id };
    const peers = fs.filter((g) => comparable(f, g)).map((g) => ({ var: g.id }));
    const ops = f.type === "number" ? COMPARISON_OPS : (["==", "!="] as const);
    const comparison = fc
      .tuple(fc.constantFrom(...ops), fc.oneof(valueArb(f), fc.constantFrom(...peers)), fc.boolean())
      .map(([op, other, swap]) => pred({ [op]: swap ? [other, v] : [v, other] }));
    const membership = fc.array(valueArb(f), { minLength: 1, maxLength: 3 }).map((list) => pred({ in: [v, list] }));
    return fc.oneof(comparison, membership);
  });
}

const nonEmpty = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<[T, ...T[]]> =>
  fc.tuple(a, fc.array(a, { maxLength: 2 })).map(([head, tail]): [T, ...T[]] => [head, ...tail]);

function predicateArb(fs: readonly Feature[]): fc.Arbitrary<Predicate> {
  const leaf = leafArb(fs);
  return fc.letrec<{ p: Predicate }>((tie) => ({
    p: fc.oneof(
      { maxDepth: 4, depthSize: "small", depthIdentifier: "predicate" },
      leaf,
      nonEmpty(tie("p")).map((args): Predicate => ({ and: args })),
      nonEmpty(tie("p")).map((args): Predicate => ({ or: args })),
      tie("p").map((q): Predicate => ({ "!": [q] })),
    ),
  })).p;
}

function assignmentArb(fs: readonly Feature[]): fc.Arbitrary<Record<string, Value>> {
  return fc.record(Object.fromEntries(fs.map((f) => [f.id, valueArb(f)])));
}

const scenarioArb = featuresArb.chain((fs) =>
  fc.record({ features: fc.constant(fs), predicate: predicateArb(fs), values: assignmentArb(fs) }),
);

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
