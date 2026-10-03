import { describe, expect, it } from "vitest";
import { and, evaluatePredicate, not, or, type Truth } from "../src";
import { TRUTHS, forcing, leaf, lookupFrom } from "./helpers";

const U = "unknown";

const AND: [Truth, Truth, Truth][] = [
  [true, true, true],
  [true, false, false],
  [true, U, U],
  [false, true, false],
  [false, false, false],
  [false, U, false],
  [U, true, U],
  [U, false, false],
  [U, U, U],
];

const OR: [Truth, Truth, Truth][] = [
  [true, true, true],
  [true, false, true],
  [true, U, true],
  [false, true, true],
  [false, false, false],
  [false, U, U],
  [U, true, true],
  [U, false, U],
  [U, U, U],
];

const NOT: [Truth, Truth][] = [
  [true, false],
  [false, true],
  [U, U],
];

const triples: [Truth, Truth, Truth][] = TRUTHS.flatMap((a) => TRUTHS.flatMap((b) => TRUTHS.map((c): [Truth, Truth, Truth] => [a, b, c])));

const truthOf = (p: Parameters<typeof evaluatePredicate>[0], values: Record<string, Truth>): Truth =>
  evaluatePredicate(p, lookupFrom(Object.fromEntries(Object.entries(values).map(([k, t]) => [k, forcing(t)])))).truth;

describe("Kleene connectives", () => {
  it.each(AND)("and(%s, %s) = %s", (a, b, r) => expect(and(a, b)).toBe(r));
  it.each(OR)("or(%s, %s) = %s", (a, b, r) => expect(or(a, b)).toBe(r));
  it.each(NOT)("not(%s) = %s", (a, r) => expect(not(a)).toBe(r));

  it("has the identities as empty and/or and is the identity on one argument", () => {
    expect(and()).toBe(true);
    expect(or()).toBe(false);
    for (const t of TRUTHS) {
      expect(and(t)).toBe(t);
      expect(or(t)).toBe(t);
    }
  });

  it("n-ary and/or are associative and commutative over all triples", () => {
    for (const [a, b, c] of triples) {
      for (const op of [and, or]) {
        const r = op(a, b, c);
        expect(op(op(a, b), c)).toBe(r);
        expect(op(a, op(b, c))).toBe(r);
        for (const [x, y, z] of [[a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]] as const) expect(op(x, y, z)).toBe(r);
      }
    }
  });

  it("satisfies De Morgan's laws", () => {
    for (const [a, b] of AND) {
      expect(not(and(a, b))).toBe(or(not(a), not(b)));
      expect(not(or(a, b))).toBe(and(not(a), not(b)));
    }
  });
});

describe("Kleene connectives through evaluatePredicate", () => {
  it.each(AND)("{and: [%s, %s]} = %s", (a, b, r) => expect(truthOf({ and: [leaf("a"), leaf("b")] }, { a, b })).toBe(r));
  it.each(OR)("{or: [%s, %s]} = %s", (a, b, r) => expect(truthOf({ or: [leaf("a"), leaf("b")] }, { a, b })).toBe(r));
  it.each(NOT)("{!: [%s]} = %s", (a, r) => expect(truthOf({ "!": [leaf("a")] }, { a })).toBe(r));

  it("forced leaves evaluate to the forced value", () => {
    for (const t of TRUTHS) expect(truthOf(leaf("a"), { a: t })).toBe(t);
  });

  it("n-ary and/or match the connectives, in every nesting, over all triples", () => {
    const [la, lb, lc] = [leaf("a"), leaf("b"), leaf("c")];
    for (const [a, b, c] of triples) {
      const v = { a, b, c };
      expect(truthOf({ and: [la, lb, lc] }, v)).toBe(and(a, b, c));
      expect(truthOf({ or: [la, lb, lc] }, v)).toBe(or(a, b, c));
      expect(truthOf({ and: [{ and: [la, lb] }, lc] }, v)).toBe(and(a, b, c));
      expect(truthOf({ or: [la, { or: [lb, lc] }] }, v)).toBe(or(a, b, c));
      expect(truthOf({ and: [lc, la, lb] }, v)).toBe(and(a, b, c));
      expect(truthOf({ or: [lb, lc, la] }, v)).toBe(or(a, b, c));
    }
  });
});
