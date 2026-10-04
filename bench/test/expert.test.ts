import { canonicalJson } from "@vashistha/core";
import { describe, expect, it } from "vitest";
import { episodeData } from "../src/episode";
import { BudgetExhaustedError, SimulatedExpert, statementId, type ExpertAnswer } from "../src/expert";
import { FAMILY_RULES, oracleVerdict } from "../src/oracle";

const PRECISE = { noise: 0, vagueness: 0 };
const data = episodeData(7, 40, 200);
const cases = [...data.stream, ...data.heldout.map(({ caseId, features }) => ({ caseId, features }))];

function why(expert: SimulatedExpert, caseId: string): Extract<ExpertAnswer, { kind: "why" }> {
  const a = expert.ask({ kind: "why", caseId }, { phase: "debrief" });
  if (a.kind !== "why") throw new Error("expected a why answer");
  return a;
}

describe("simulated expert", () => {
  it("answers counterfactuals and decides cases exactly as the oracle does (noise 0)", () => {
    const expert = new SimulatedExpert({ settings: PRECISE, budget: cases.length, seed: 1 });
    for (const c of cases) {
      const truth = oracleVerdict(c.features).action;
      expect(expert.decide(`obs-${c.caseId}`, c.features)).toBe(truth);
      expect(expert.ask({ kind: "counterfactual", caseId: c.caseId, features: c.features }, { phase: "debrief" })).toEqual({ kind: "counterfactual", action: truth });
    }
  });

  it("explains a decision with the rules behind it and never any other rule", () => {
    const expert = new SimulatedExpert({ settings: PRECISE, budget: cases.length, seed: 1 });
    let defaults = 0;
    for (const c of cases) {
      expert.decide(c.caseId, c.features);
      const verdict = oracleVerdict(c.features);
      const answer = why(expert, c.caseId);
      const fired = FAMILY_RULES.filter((r) => verdict.firedRuleIds.includes(r.id));
      const exceptedFrom = FAMILY_RULES.filter((r) => fired.some((f) => f.overrides.includes(r.id)));
      const allowed = new Map([...fired, ...exceptedFrom].map((r) => [statementId(r.id), r]));
      for (const s of answer.statements) {
        const rule = allowed.get(s.id);
        expect(rule, `statement ${s.rule.exactQuote} on ${c.caseId}`).toBeDefined();
        // Vagueness 0: the statement is the oracle rule itself.
        expect(canonicalJson(s.rule.predicate)).toBe(canonicalJson(rule?.predicate));
        expect(s.rule.effect).toEqual(rule?.effect);
        expect(s.priority).toBe(rule?.priority);
      }
      // The decisive rule is always among them, unless no rule decided (then the default is stated).
      if (verdict.firedRuleIds.length === 0) {
        defaults++;
        expect(answer).toEqual({ kind: "why", statements: [], defaultAction: verdict.action });
      } else expect(answer.statements.some((s) => s.rule.effect.type === "recommend" && s.rule.effect.action === verdict.action)).toBe(true);
    }
    expect(defaults).toBeGreaterThan(0);
  });

  it("charges one unit per question of any kind and refuses past the budget", () => {
    const [c] = cases;
    if (c === undefined) throw new Error("no cases");
    const expert = new SimulatedExpert({ settings: PRECISE, budget: 2, seed: 1 });
    expert.decide(c.caseId, c.features);
    expect(expert.remaining).toBe(2);
    why(expert, c.caseId);
    expect(expert.remaining).toBe(1);
    expert.ask({ kind: "counterfactual", caseId: "x", features: c.features }, { phase: "debrief" });
    expect(expert.remaining).toBe(0);
    expect(() => why(expert, c.caseId)).toThrow(BudgetExhaustedError);
    expect(expert.transcript).toHaveLength(2);
  });

  it("refuses a why-question about a case it never decided", () => {
    const expert = new SimulatedExpert({ settings: PRECISE, budget: 5, seed: 1 });
    expect(() => why(expert, "NS-2026-0101")).toThrow(/not decided/);
  });

  it("noise replaces answers with another action at the configured rate, deterministically", () => {
    const run = (seed: number): number => {
      const expert = new SimulatedExpert({ settings: { noise: 0.3, vagueness: 0 }, budget: cases.length, seed });
      return cases.filter((c) => {
        const a = expert.ask({ kind: "counterfactual", caseId: c.caseId, features: c.features }, { phase: "debrief" });
        return a.kind === "counterfactual" && a.action !== oracleVerdict(c.features).action;
      }).length;
    };
    const flips = run(3);
    expect(flips).toBe(run(3));
    expect(flips / cases.length).toBeGreaterThan(0.2);
    expect(flips / cases.length).toBeLessThan(0.4);
  });

  it("vagueness blurs the stated condition but never the effect or the decision", () => {
    const expert = new SimulatedExpert({ settings: { noise: 0, vagueness: 1 }, budget: cases.length, seed: 5 });
    let blurred = 0;
    for (const c of cases) {
      expect(expert.decide(c.caseId, c.features)).toBe(oracleVerdict(c.features).action);
      for (const s of why(expert, c.caseId).statements) {
        const rule = FAMILY_RULES.find((r) => statementId(r.id) === s.id);
        expect(s.rule.effect).toEqual(rule?.effect);
        if (canonicalJson(s.rule.predicate) !== canonicalJson(rule?.predicate)) blurred++;
      }
    }
    expect(blurred).toBeGreaterThan(0);
  });
});
