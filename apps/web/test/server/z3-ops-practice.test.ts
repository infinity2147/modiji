/** The Z3 worker's practice op carries both solver witness kinds across the thread boundary: boundary and contrast cases. */
import { describe, expect, it } from "vitest";
import { PredicateSchema, RuleEffectSchema } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { practiceCases, type SolverRule } from "@vashistha/solver";
import { Z3_OPS } from "../../lib/server/workers/z3-ops";

const rule = (id: string, predicate: unknown): SolverRule => ({
  id,
  decisionFamily: "reviewOutcome",
  kind: "decision",
  predicate: PredicateSchema.parse(predicate),
  effect: RuleEffectSchema.parse({ type: "recommend", action: "enhancedReview" }),
  priority: 10,
  overrides: [],
});

describe("Z3 worker practice op", () => {
  it("accepts boundary and contrast witnesses as the solver returns them, and rejects unknown kinds", async () => {
    const rules = [
      rule("ubo", { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] }),
      rule("pep", { "==": [{ var: "pep" }, true] }),
    ];
    const ws = await practiceCases({ domain: KYC_DOMAIN, rules, ruleIds: ["ubo", "pep"], count: 4, schemaVersion: 1 });
    expect(new Set(ws.map((w) => w.kind))).toEqual(new Set(["boundary", "contrast"]));
    expect(Z3_OPS.practice.output.parse(ws)).toEqual(ws);
    expect(Z3_OPS.practice.output.safeParse([{ ...ws.find((w) => w.kind === "contrast"), kind: "other" }]).success).toBe(false);
  });
});
