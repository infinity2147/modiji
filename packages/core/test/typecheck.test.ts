import { describe, expect, it } from "vitest";
import { featuresReferenced, typecheckPredicate } from "../src";
import { features, pred } from "./helpers";

const fs = features([
  { id: "pct", label: "Ownership %", source: "case", type: "number", min: 0, max: 100 },
  { id: "count", label: "Prior escalations", source: "derived", type: "number", min: 0, max: 20, integer: true },
  { id: "pep", label: "PEP", source: "case", type: "boolean" },
  { id: "entity", label: "Entity type", source: "case", type: "enum", values: ["individual", "company", "trust"] },
  { id: "entity2", label: "Counterparty type", source: "case", type: "enum", values: ["trust", "company", "individual"] },
  { id: "tier", label: "Tier", source: "case", type: "enum", values: ["low", "high"] },
  { id: "name", label: "Name", source: "case", type: "string" },
]);

const check = (p: unknown) => typecheckPredicate(pred(p), fs);
const paths = (p: unknown) => check(p).map((i) => i.path);

describe("typecheckPredicate", () => {
  it("accepts a well-typed predicate", () => {
    const p = {
      and: [
        { ">=": [{ var: "pct" }, 25] },
        { "<": [{ var: "count" }, { var: "pct" }] },
        { or: [{ in: [{ var: "entity" }, ["company", "trust"]] }, { "!": [{ "==": [{ var: "pep" }, false] }] }] },
        { "!=": [{ var: "name" }, ""] },
        { "==": ["individual", { var: "entity" }] },
        { "==": [{ var: "entity" }, { var: "entity2" }] },
        { in: [{ var: "count" }, [0, 1, 20]] },
      ],
    };
    expect(check(p)).toEqual([]);
  });

  it("rejects undeclared features", () => {
    expect(check({ or: [{ "==": [{ var: "pep" }, true] }, { "==": [{ var: "ghost" }, 1] }] })).toEqual([
      { path: "/or/1/==/0", message: expect.stringContaining('"ghost"') },
    ]);
    expect(paths({ in: [{ var: "ghost" }, [1]] })).toEqual(["/in/0"]);
  });

  it("rejects constant comparisons and memberships", () => {
    expect(check({ and: [{ "==": [{ var: "pep" }, true] }, { "==": [1, 1] }] })).toEqual([
      { path: "/and/1/==", message: expect.stringContaining("at least one feature") },
    ]);
    expect(paths({ in: ["company", ["company", "trust"]] })).toEqual(["/in/0"]);
  });

  it("rejects ordering on non-numeric operands", () => {
    expect(paths({ "<": [{ var: "pct" }, "50"] })).toEqual(["/</1"]);
    expect(paths({ ">": [{ var: "pep" }, 1] })).toEqual(["/>/0"]);
    expect(paths({ "<=": [{ var: "name" }, { var: "entity" }] })).toEqual(["/<=/0", "/<=/1"]);
  });

  it("rejects equality between different types", () => {
    expect(paths({ "==": [{ var: "pct" }, "25"] })).toEqual(["/==/1"]);
    expect(paths({ "!=": [true, { var: "count" }] })).toEqual(["/!=/0"]);
    expect(paths({ "==": [{ var: "name" }, false] })).toEqual(["/==/1"]);
  });

  it("requires enum literals to be enum members", () => {
    expect(check({ and: [{ ">": [{ var: "pct" }, 0] }, { "==": ["partnership", { var: "entity" }] }] })).toEqual([
      { path: "/and/1/==/0", message: expect.stringContaining('"partnership" is not a value') },
    ]);
    expect(paths({ "==": [{ var: "entity" }, 1] })).toEqual(["/==/1"]);
  });

  it("requires in-list elements to match the operand's type and enum", () => {
    expect(paths({ in: [{ var: "entity" }, ["company", "llc", 3]] })).toEqual(["/in/1/1", "/in/1/2"]);
    expect(paths({ in: [{ var: "pep" }, [true, "false"]] })).toEqual(["/in/1/1"]);
    expect(paths({ in: [{ var: "name" }, ["a", 1]] })).toEqual(["/in/1/1"]);
  });

  it("requires numeric literals within the feature's range, inclusive of the bounds", () => {
    expect(check({ ">=": [{ var: "pct" }, 0] })).toEqual([]);
    expect(check({ "<=": [{ var: "pct" }, 100] })).toEqual([]);
    expect(check({ "==": [20, { var: "count" }] })).toEqual([]);
    expect(check({ ">": [{ var: "pct" }, 100.5] })).toEqual([{ path: "/>/1", message: expect.stringContaining("outside the range") }]);
    expect(paths({ "<": [-1, { var: "pct" }] })).toEqual(["/</0"]);
    expect(paths({ in: [{ var: "count" }, [5, 21]] })).toEqual(["/in/1/1"]);
  });

  it("requires integer literals for integer features", () => {
    expect(check({ ">": [{ var: "count" }, 2.5] })).toEqual([{ path: "/>/1", message: expect.stringContaining("not an integer") }]);
    expect(check({ ">": [{ var: "pct" }, 2.5] })).toEqual([]);
  });

  it("requires compatible types for feature-vs-feature comparisons", () => {
    expect(paths({ "==": [{ var: "pct" }, { var: "pep" }] })).toEqual(["/=="]);
    expect(paths({ "==": [{ var: "entity" }, { var: "name" }] })).toEqual(["/=="]);
    expect(check({ "!=": [{ var: "entity" }, { var: "tier" }] })).toEqual([
      { path: "/!=", message: expect.stringContaining('"tier"') },
    ]);
  });

  it("collects every issue in a predicate", () => {
    const p = { and: [{ "==": [{ var: "ghost" }, 1] }, { "!": [{ "<": [{ var: "name" }, 3] }] }, { "==": [{ var: "count" }, 99] }] };
    expect(paths(p)).toEqual(["/and/0/==/0", "/and/1/!/0/</0", "/and/2/==/1"]);
  });
});

describe("featuresReferenced", () => {
  it("returns sorted, unique feature ids", () => {
    const p = pred({
      or: [
        { "==": [{ var: "pep" }, true] },
        { and: [{ "<": [{ var: "count" }, { var: "pct" }] }, { in: [{ var: "entity" }, ["trust"]] }] },
        { "!": [{ ">": [{ var: "pct" }, 5] }] },
      ],
    });
    expect(featuresReferenced(p)).toEqual(["count", "entity", "pct", "pep"]);
  });
});
