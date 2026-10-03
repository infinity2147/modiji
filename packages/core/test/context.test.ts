import { describe, expect, it } from "vitest";
import { DecisionContextSchema, FeatureIdSchema, contextLookup, unknown } from "../src";
import { features } from "./helpers";

const fs = features([
  { id: "pct", label: "Ownership %", source: "case", type: "number", min: 0, max: 100 },
  { id: "country", label: "Country", source: "case", type: "string" },
  { id: "priorFailures", label: "Prior failures", source: "derived", type: "number", min: 0, max: 10, integer: true },
  { id: "constructor", label: "Constructor", source: "derived", type: "boolean" },
]);

const ctx = DecisionContextSchema.parse({
  case: { pct: 30, country: { unknown: true, reason: "not_visible" }, priorFailures: 99 },
  workflow: { priorActions: [] },
  history: { derived: { priorFailures: 2, pct: 77 } },
  actor: { role: "analyst", id: "a1" },
  environment: { date: "2026-10-04" },
  schemaVersion: 1,
});

const lookup = contextLookup(ctx, fs);
const id = (s: string) => FeatureIdSchema.parse(s);

describe("contextLookup", () => {
  it("reads case features from the case and derived features from history", () => {
    expect(lookup(id("pct"))).toBe(30);
    expect(lookup(id("priorFailures"))).toBe(2);
  });

  it("passes explicit unknowns through", () => {
    expect(lookup(id("country"))).toEqual(unknown("not_visible"));
  });

  it("treats a missing key as not extracted, ignoring inherited properties", () => {
    const empty = contextLookup({ ...ctx, case: {} }, fs);
    expect(empty(id("pct"))).toEqual(unknown("not_extracted"));
    expect(lookup(id("constructor"))).toEqual(unknown("not_extracted"));
  });

  it("throws for a feature the domain does not declare", () => {
    expect(() => lookup(id("ghost"))).toThrow(/ghost/);
  });
});
