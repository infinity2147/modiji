/** fast-check arbitraries of well-typed predicates over random feature models (shared by the logic property tests). */
import fc from "fast-check";
import { COMPARISON_OPS, type Feature, type Predicate, type Value } from "../src";
import { features as parseFeatures, pred } from "./helpers";

const ENUM_POOL = ["red", "green", "blue", "amber"];
const STRING_POOL = ["alpha", "beta", "gamma", ""];

const featureBodyArb = fc.oneof(
  fc
    .record({ min: fc.integer({ min: -20, max: 20 }), span: fc.integer({ min: 0, max: 10 }), integer: fc.boolean() })
    .map(({ min, span, integer }) => ({ type: "number", min, max: min + span, integer })),
  fc.constant({ type: "boolean" }),
  fc.subarray(ENUM_POOL, { minLength: 1 }).map((values) => ({ type: "enum", values })),
  fc.constant({ type: "string" }),
);

export const featuresArb: fc.Arbitrary<Feature[]> = fc
  .array(featureBodyArb, { minLength: 1, maxLength: 5 })
  .map((bodies) =>
    parseFeatures(bodies.map((b, i) => ({ id: `f${i}`, label: `Feature ${i}`, source: i % 2 === 0 ? "case" : "derived", ...b }))),
  );

/** In-domain values; numbers favour integers so that equality is hit regularly. */
export function valueArb(f: Feature): fc.Arbitrary<Value> {
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

export function predicateArb(fs: readonly Feature[]): fc.Arbitrary<Predicate> {
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

export function assignmentArb(fs: readonly Feature[]): fc.Arbitrary<Record<string, Value>> {
  return fc.record(Object.fromEntries(fs.map((f) => [f.id, valueArb(f)])));
}

export const scenarioArb = featuresArb.chain((fs) =>
  fc.record({ features: fc.constant(fs), predicate: predicateArb(fs), values: assignmentArb(fs) }),
);
