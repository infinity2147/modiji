import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PredicateSchema,
  canonicalJson,
  canonicalPredicate,
  evaluatePredicate,
  predicateNode,
  typecheckPredicate,
  unknown,
  type ComparisonOp,
  type FeatureValue,
  type Predicate,
} from "../src";
import { lookupFrom, pred } from "./helpers";
import { assignmentArb, scenarioArb } from "./predicate-arb";

const RUNS = { seed: 20261004, numRuns: 400 };

const FLIP: Record<ComparisonOp, ComparisonOp> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** A seeded linear congruential generator: scrambles are reproducible from the fast-check seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The same condition written differently: children shuffled and repeated, nested, literals flipped, double negations. */
function scramble(p: Predicate, next: () => number): Predicate {
  const node = predicateNode(p);
  let out: Predicate;
  switch (node.key) {
    case "and":
    case "or": {
      const children = node.args.map((c) => scramble(c, next)).sort(() => next() - 0.5);
      const [first, ...rest] = next() < 0.3 ? [...children, children[0] ?? p] : children;
      if (first === undefined) throw new Error("unreachable");
      const nested: Predicate = node.key === "and" ? { and: [first, ...rest] } : { or: [first, ...rest] };
      out = next() < 0.2 ? (node.key === "and" ? { and: [nested] } : { or: [nested] }) : nested;
      break;
    }
    case "!":
      out = { "!": [scramble(node.args[0], next)] };
      break;
    case "in": {
      const [head, ...tail] = [...node.args[1]].reverse();
      out = { in: [node.args[0], [head ?? node.args[1][0], ...tail]] };
      break;
    }
    default:
      out = next() < 0.5 ? pred({ [FLIP[node.key]]: [node.args[1], node.args[0]] }) : p;
  }
  return next() < 0.15 ? { "!": [{ "!": [out] }] } : out;
}

const partialArb = scenarioArb.chain((s) =>
  fc.record({ scenario: fc.constant(s), hidden: fc.subarray(s.features.map((f) => f.id)), seed: fc.integer(), more: fc.array(assignmentArb(s.features), { maxLength: 3 }) }),
);

describe("canonicalPredicate", () => {
  it("evaluates identically to the original (truth and unknownFeatures), under full and partial information", () => {
    fc.assert(
      fc.property(partialArb, ({ scenario: { features, predicate, values }, hidden, more }) => {
        const canonical = canonicalPredicate(predicate);
        expect(PredicateSchema.safeParse(canonical).success).toBe(true);
        expect(typecheckPredicate(canonical, features)).toEqual([]);
        for (const assignment of [values, ...more]) {
          const partial: Record<string, FeatureValue> = { ...assignment, ...Object.fromEntries(hidden.map((id) => [id, unknown("not_visible")])) };
          for (const lookup of [lookupFrom(assignment), lookupFrom(partial)])
            expect(evaluatePredicate(canonical, lookup)).toEqual(evaluatePredicate(predicate, lookup));
        }
      }),
      RUNS,
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(scenarioArb, ({ predicate }) => {
        const once = canonicalPredicate(predicate);
        expect(canonicalPredicate(once)).toEqual(once);
      }),
      RUNS,
    );
  });

  it("gives one form to every rewriting (shuffled, repeated and nested children, flipped literals, double negation)", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer(), ({ predicate }, seed) => {
        const rewritten = scramble(predicate, rng(seed));
        expect(canonicalJson(canonicalPredicate(rewritten))).toBe(canonicalJson(canonicalPredicate(predicate)));
      }),
      RUNS,
    );
  });

  it("normalises the production duplicate written two ways, and keeps a negated membership", () => {
    const a = pred({ and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] });
    const b = pred({ and: [{ "==": [false, { var: "uboVerified" }] }, { "<": [25, { var: "uboOwnershipPct" }] }] });
    expect(canonicalPredicate(b)).toEqual(canonicalPredicate(a));
    expect(canonicalPredicate(pred({ "!": [{ and: [{ "<": [{ var: "x" }, 5] }, { in: [{ var: "c" }, ["b", "a", "b"]] }] }] }))).toEqual({
      or: [{ "!": [{ in: [{ var: "c" }, ["a", "b"]] }] }, { ">=": [{ var: "x" }, 5] }],
    });
    expect(canonicalPredicate(pred({ and: [{ "==": [{ var: "x" }, 1] }, { and: [{ "==": [{ var: "x" }, 1] }] }] }))).toEqual({ "==": [{ var: "x" }, 1] });
  });
});
