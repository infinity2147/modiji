import { describe, expect, it } from "vitest";
import { PredicateEvaluationError, evaluatePredicate, unknown, type FeatureValue } from "../src";
import { leaf, lookupFrom, pred } from "./helpers";

const U = unknown("not_visible");
const values: Record<string, FeatureValue> = {
  pct: 25,
  count: 3,
  country: "XA",
  name: "Acme Ltd",
  pep: true,
  sanctioned: false,
  hidden: U,
  hidden2: unknown("off_record"),
};
const lookup = lookupFrom(values);
const evalP = (p: unknown) => evaluatePredicate(pred(p), lookup);
const truth = (p: unknown) => evalP(p).truth;

describe("evaluatePredicate: comparisons", () => {
  it.each([
    [{ ">=": [{ var: "pct" }, 25] }, true],
    [{ ">": [{ var: "pct" }, 25] }, false],
    [{ "<=": [{ var: "pct" }, 25] }, true],
    [{ "<": [{ var: "pct" }, 25] }, false],
    [{ ">": [{ var: "pct" }, 24.999] }, true],
    [{ ">=": [26, { var: "pct" }] }, true],
    [{ "<": [{ var: "count" }, { var: "pct" }] }, true],
    [{ "==": [{ var: "pct" }, 25] }, true],
    [{ "!=": [{ var: "pct" }, 25] }, false],
    [{ "==": [{ var: "count" }, { var: "pct" }] }, false],
  ])("numbers: %j -> %s", (p, r) => expect(truth(p)).toBe(r));

  it.each([
    [{ "==": [{ var: "country" }, "XA"] }, true],
    [{ "==": ["XB", { var: "country" }] }, false],
    [{ "!=": [{ var: "country" }, "XB"] }, true],
    [{ "==": [{ var: "name" }, "Acme Ltd"] }, true],
    [{ "==": [{ var: "name" }, "acme ltd"] }, false],
    [{ "==": [{ var: "name" }, { var: "country" }] }, false],
  ])("strings and enums: %j -> %s", (p, r) => expect(truth(p)).toBe(r));

  it.each([
    [{ "==": [{ var: "pep" }, true] }, true],
    [{ "==": [{ var: "pep" }, false] }, false],
    [{ "!=": [{ var: "sanctioned" }, true] }, true],
    [{ "==": [{ var: "pep" }, { var: "sanctioned" }] }, false],
  ])("booleans: %j -> %s", (p, r) => expect(truth(p)).toBe(r));

  it.each([
    [{ in: [{ var: "country" }, ["XA", "XB"]] }, true],
    [{ in: [{ var: "country" }, ["XC"]] }, false],
    [{ in: [{ var: "pct" }, [10, 25, 50]] }, true],
    [{ in: [{ var: "pct" }, [24, 26]] }, false],
    [{ in: [{ var: "pep" }, [true]] }, true],
    [{ in: [{ var: "sanctioned" }, [true]] }, false],
  ])("in: %j -> %s", (p, r) => expect(truth(p)).toBe(r));

  it.each([
    [{ ">": [{ var: "hidden" }, 10] }, ["hidden"]],
    [{ "==": ["XA", { var: "hidden" }] }, ["hidden"]],
    [{ "<": [{ var: "pct" }, { var: "hidden" }] }, ["hidden"]],
    [{ "==": [{ var: "hidden2" }, { var: "hidden" }] }, ["hidden", "hidden2"]],
    [{ in: [{ var: "hidden" }, ["XA"]] }, ["hidden"]],
  ])("an unknown operand makes %j unknown", (p, missing) => {
    expect(evalP(p)).toEqual({ truth: "unknown", unknownFeatures: missing });
  });
});

describe("evaluatePredicate: type mismatches throw", () => {
  const thrown = (p: unknown): unknown => {
    try {
      evalP(p);
    } catch (e) {
      return e;
    }
    throw new Error("expected evaluation to throw");
  };

  it.each([
    [{ "==": [{ var: "pct" }, "25"] }, "/=="],
    [{ "!=": [{ var: "pep" }, 1] }, "/!="],
    [{ "==": [{ var: "name" }, { var: "pep" }] }, "/=="],
    [{ and: [leaf("pep"), { "<": [{ var: "country" }, 5] }] }, "/and/1/</0"],
    [{ or: [leaf("pep"), { "!": [{ ">=": [10, { var: "name" }] }] }] }, "/or/1/!/0/>=/1"],
    [{ in: [{ var: "pct" }, [25, "25"]] }, "/in/1/1"],
    [{ in: [{ var: "country" }, [1]] }, "/in/1/0"],
  ])("%j at %s", (p, path) => {
    const e = thrown(p);
    expect(e).toBeInstanceOf(PredicateEvaluationError);
    expect(e).toMatchObject({ path });
  });

  it("does not let a deciding sibling hide a mismatch", () => {
    const bad = { "==": [{ var: "pct" }, true] };
    expect(() => evalP({ and: [leaf("sanctioned"), bad] })).toThrow(PredicateEvaluationError);
    expect(() => evalP({ or: [leaf("pep"), bad] })).toThrow(PredicateEvaluationError);
  });

  it("reports the comparison as unknown, not as an error, when its variable is unknown", () => {
    expect(truth({ "==": [{ var: "hidden" }, "x"] })).toBe("unknown");
  });
});

describe("evaluatePredicate: unknownFeatures", () => {
  const unknownLeaf = (id: string) => ({ "==": [{ var: id }, true] });
  const vals = lookupFrom({ t: true, f: false, a: U, b: U, c: U });
  const run = (p: unknown) => evaluatePredicate(pred(p), vals);

  it("is empty when a deciding child short-circuits the unknowns", () => {
    expect(run({ and: [unknownLeaf("a"), unknownLeaf("f")] })).toEqual({ truth: false, unknownFeatures: [] });
    expect(run({ or: [unknownLeaf("a"), unknownLeaf("b"), unknownLeaf("t")] })).toEqual({ truth: true, unknownFeatures: [] });
    expect(run({ "!": [{ or: [unknownLeaf("t"), unknownLeaf("a")] }] })).toEqual({ truth: false, unknownFeatures: [] });
  });

  it("is empty for fully known predicates", () => {
    expect(run({ and: [unknownLeaf("t"), { "!": [unknownLeaf("f")] }] })).toEqual({ truth: true, unknownFeatures: [] });
  });

  it("unions nested unknowns, deduplicated and sorted", () => {
    const p = { or: [{ and: [unknownLeaf("c"), unknownLeaf("t")] }, { and: [unknownLeaf("b"), unknownLeaf("c")] }, unknownLeaf("f")] };
    expect(run(p)).toEqual({ truth: "unknown", unknownFeatures: ["b", "c"] });
  });

  it("leaves out unknowns inside a sub-predicate that was decided anyway", () => {
    const p = { and: [{ or: [unknownLeaf("t"), unknownLeaf("b")] }, unknownLeaf("a")] };
    expect(run(p)).toEqual({ truth: "unknown", unknownFeatures: ["a"] });
  });

  it("is preserved by negation", () => {
    const inner = { and: [unknownLeaf("b"), unknownLeaf("a")] };
    expect(run({ "!": [inner] })).toEqual({ truth: "unknown", unknownFeatures: ["a", "b"] });
    expect(run({ "!": [{ "!": [inner] }] })).toEqual(run(inner));
  });
});
