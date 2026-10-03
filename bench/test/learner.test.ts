import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { episodeData } from "../src/episode";
import { SimulatedExpert } from "../src/expert";
import { absorb, EMPTY_KNOWLEDGE, fitPolicy, observe, type Knowledge } from "../src/learner";
import { behaviouralMetrics, rulesRecovered, SIMPLE_ORACLE_RULES } from "../src/metrics";
import { FAMILY_RULES } from "../src/oracle";

describe("shared learner", () => {
  it("reaches the sanity ceiling from the oracle's own stated rules (vagueness 0, full why answers)", async () => {
    const data = episodeData(11, 120, 500);
    const expert = new SimulatedExpert({ settings: { noise: 0, vagueness: 0 }, budget: data.stream.length, seed: 11 });
    let k: Knowledge = EMPTY_KNOWLEDGE;
    for (const c of data.stream) {
      k = observe(k, c.caseId, c.features, expert.decide(c.caseId, c.features));
      const q = { kind: "why", caseId: c.caseId } as const;
      k = absorb(k, q, expert.ask(q, { phase: "live", pause: 0 }));
    }
    expect(k.statements).toHaveLength(FAMILY_RULES.length);
    expect(k.statedDefault).toBe("approve");
    const policy = fitPolicy(k);
    const m = behaviouralMetrics(policy, data.heldout);
    expect(m.fidelity).toBeGreaterThanOrEqual(0.99);
    expect(m.unsafeFnRate).toBe(0);
    expect(m.guardrailRecall).toBe(1);
    expect(await rulesRecovered(policy, new Map())).toBe(SIMPLE_ORACLE_RULES.length);
  });

  it("is a pure function of its knowledge", () => {
    const data = episodeData(12, 30, 10);
    const expert = new SimulatedExpert({ settings: { noise: 0, vagueness: 0 }, budget: 0, seed: 12 });
    const k = data.stream.reduce<Knowledge>((acc, c) => observe(acc, c.caseId, c.features, expert.decide(c.caseId, c.features)), EMPTY_KNOWLEDGE);
    expect(JSON.stringify(fitPolicy(k))).toBe(JSON.stringify(fitPolicy(structuredClone(k))));
    expect(fitPolicy(k).induced.length).toBeGreaterThan(0);
  });

  it("never sees the hidden policy: the learner and strategies do not import the oracle", () => {
    const files = ["learner.ts", "domain.ts", ...readdirSync(new URL("../src/strategies/", import.meta.url)).map((f) => `strategies/${f}`)];
    for (const f of files) {
      const source = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(source, f).not.toMatch(/from\s+"[^"]*oracle[^"]*"/);
    }
  });
});
