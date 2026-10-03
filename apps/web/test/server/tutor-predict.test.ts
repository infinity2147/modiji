/**
 * P6 predict-then-reveal and the mastery ladder: expected outcomes come from the confirmed rulebook
 * (never the oracle), predictions and mastery changes are ledgered with provenance.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ActionIdSchema, ConfirmedRuleSchema, parseLedgerPayload, recordLookup, type ConfirmedRule } from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, generateBenchCases } from "@vashistha/core/domains/kyc";
import { effectiveDecision, prepareRulebook } from "@vashistha/solver";
import { PredictionResponseSchema, TutorStateSchema } from "../../lib/contracts/tutor";
import { expectedOutcome } from "../../lib/server/tutor/predict";
import { QUOTES, createTutorHarness, demoRules, expertRule } from "../support/tutor-harness";

const HIGH_NEW_CASE = "NS-2026-0201";
const SANCTIONS_CASE = "NS-2026-0202";

async function setup() {
  const h = createTutorHarness();
  const ruleEntries = await h.seedRules(demoRules());
  const sessionId = await h.session();
  return { h, ruleEntries, sessionId };
}

function caseView(body: unknown, caseId: string) {
  return TutorStateSchema.parse(body).cases.find((c) => c.caseId === caseId);
}

describe("predict-then-reveal", () => {
  it("asks at an unmastered decision node; a wrong prediction is revealed with the expert's rule and words", async () => {
    const { h, ruleEntries, sessionId } = await setup();
    expect(caseView((await h.state(sessionId)).body, HIGH_NEW_CASE)?.prompt).toEqual({ ask: true });

    const r = await h.predict(sessionId, HIGH_NEW_CASE, "approve");
    expect(r.status).toBe(200);
    const { prediction, state } = PredictionResponseSchema.parse(r.body);
    expect(prediction).toMatchObject({ predicted: "approve", expected: "enhancedReview", correct: false, ruleIds: ["rule-enhanced"] });
    const rule = state.rules.find((x) => x.ruleId === "rule-enhanced");
    expect(rule).toMatchObject({ then: "send to enhanced review", quote: { text: QUOTES.enhanced, attribution: "The expert, by voice" } });
    expect(rule?.quote.replay.frameUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}\/frames\/[0-9a-f-]{36}\.png$/);
    expect(rule?.quote.replay.audioNote).toMatch(/audio is not stored/);

    const [entry] = h.entries(sessionId, ["tutor.prediction"]);
    expect(entry?.source).toBe("client");
    expect(entry?.parentIds).toContain(ruleEntries.get("rule-enhanced"));
    expect(caseView(state, HIGH_NEW_CASE)).toMatchObject({ prompt: { ask: false }, prediction: { entryId: entry?.id } });
    // One prediction per case.
    expect((await h.predict(sessionId, HIGH_NEW_CASE, "enhancedReview")).body).toMatchObject({ error: "already_predicted" });
  });

  it("no prompt, and no prediction, when the confirmed rules do not decide the case", async () => {
    const { h, sessionId } = await setup();
    const view = caseView((await h.state(sessionId)).body, SANCTIONS_CASE);
    expect(view?.prompt).toEqual({ ask: false, reason: expect.stringContaining("do not decide this case") });
    const r = await h.predict(sessionId, SANCTIONS_CASE, "reject");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "nothing_to_predict" });
    expect(h.entries(sessionId, ["tutor.prediction"])).toEqual([]);
  });

  it("the tutor never imports the hidden-policy oracle (static import graph from every tutor module)", () => {
    const web = resolve(import.meta.dirname, "../..");
    const roots = [
      "lib/server/tutor",
      "lib/client/tutor",
      "components/tutor",
      "lib/contracts/tutor.ts",
      "app/api/sessions/[sessionId]/tutor",
    ].map((p) => join(web, p));
    const files = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : [p]);
    const seen = new Set<string>();
    const specifiers: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/(?:import|export)[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? "";
        specifiers.push(spec);
        const local = spec.startsWith("@/") ? join(web, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(file), spec) : undefined;
        if (local === undefined) continue;
        const found = [`${local}.ts`, `${local}.tsx`, join(local, "index.ts")].find((f) => {
          try {
            return statSync(f).isFile();
          } catch {
            return false;
          }
        });
        if (found !== undefined) visit(found);
      }
    };
    for (const root of roots) for (const f of files(root)) visit(f);
    expect(seen.size).toBeGreaterThan(15);
    expect([...seen].filter((f) => /oracle/i.test(f))).toEqual([]);
    expect(specifiers.filter((s) => /oracle/i.test(s))).toEqual([]);
  });

  it("expected outcomes agree with the solver's effectiveDecision on complete cases (parity)", () => {
    const rules = demoRules();
    const book = prepareRulebook(KYC_DOMAIN, rules);
    const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === "reviewOutcome")!;
    for (const kycCase of generateBenchCases(20261004, 200)) {
      const solver = effectiveDecision(book, family, recordLookup(caseFeatures(kycCase)));
      const tutor = expectedOutcome(rules, kycCase, {});
      if (solver.kind === "decided") expect(tutor).toEqual({ kind: "decided", action: solver.outcome.label, ruleIds: solver.ruleIds });
      else expect(tutor.kind).toBe("none");
    }
  });

  it("parity holds for random rulebooks with priorities and overrides (property, fixed seed)", () => {
    const actions = ["approve", "enhancedReview", "requestDocuments", "reject"] as const;
    const preds = [
      { "==": [{ var: "jurisdictionRisk" }, "high"] },
      { "==": [{ var: "customerStatus" }, "new"] },
      { ">": [{ var: "uboOwnershipPct" }, 25] },
      { "==": [{ var: "uboVerified" }, false] },
      { ">=": [{ var: "expectedMonthlyVolume" }, 50_000] },
      { "==": [{ var: "adverseMedia" }, true] },
    ];
    const ruleArb = fc.record({ pred: fc.nat(preds.length - 1), action: fc.nat(actions.length - 1), priority: fc.nat(2), overrides: fc.boolean() });
    const cases = generateBenchCases(7, 60);
    fc.assert(
      fc.property(fc.array(ruleArb, { minLength: 1, maxLength: 5 }), (specs) => {
        const rules: ConfirmedRule[] = specs.map((s, i) =>
          ConfirmedRuleSchema.parse({
            ...expertRule({ id: `r${i}`, kind: "decision", effect: { type: "recommend", action: actions[s.action]! }, predicate: preds[s.pred]!, quote: "q", priority: s.priority * 10 }),
            overrides: s.overrides && i > 0 ? [`r${i - 1}`] : [],
          }),
        );
        const book = prepareRulebook(KYC_DOMAIN, rules);
        const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === "reviewOutcome")!;
        for (const kycCase of cases) {
          const solver = effectiveDecision(book, family, recordLookup(caseFeatures(kycCase)));
          const tutor = expectedOutcome(rules, kycCase, {});
          if (solver.kind === "decided") expect(tutor).toEqual({ kind: "decided", action: ActionIdSchema.parse(solver.outcome.label), ruleIds: solver.ruleIds });
          else expect(tutor.kind).toBe("none");
        }
      }),
      { seed: 20261004, numRuns: 150 },
    );
  });
});

describe("mastery ladder", () => {
  it("wrong prediction → commit after the reveal: assisted; correct prediction: independent once; ledgered with parents", async () => {
    const { h, ruleEntries, sessionId } = await setup();
    await h.predict(sessionId, HIGH_NEW_CASE, "approve");
    // A wrong first answer leaves an untested rule untested: no rung changes, nothing to record.
    expect(h.entries(sessionId, ["mastery.updated"])).toEqual([]);
    const { commit } = await h.save(sessionId, HIGH_NEW_CASE, "enhancedReview");
    expect(commit.status).toBe(200);
    const [assisted] = h.entries(sessionId, ["mastery.updated"]);
    expect(parseLedgerPayload(assisted!, "mastery.updated")).toEqual({ ruleId: "rule-enhanced", from: "untested", to: "assisted" });
    const [decision] = h.entries(sessionId, ["case.decision"]);
    expect(assisted?.parentIds).toEqual([decision?.id, ruleEntries.get("rule-enhanced")]);

    // Stop-rule on the case: avoided independently (no intervention on this case) → independent once.
    const levels = Object.fromEntries(TutorStateSchema.parse((await h.state(sessionId)).body).rules.map((r) => [r.ruleId, r.level]));
    expect(levels).toMatchObject({ "rule-enhanced": "assisted", "rule-never-approve": "independent_once", "rule-documents": "untested" });

    // The interview engine's view reads the same entries.
    expect((await h.engine(sessionId)).body).toMatchObject({ mastery: expect.arrayContaining([{ ruleId: "rule-enhanced", level: "assisted" }]) });
  });

  it("an intervention moves the stop-rule down; committing correctly after it is assisted", async () => {
    const h = createTutorHarness();
    await h.seedRules(demoRules());
    const sessionId = await h.session();
    // First: get the stop-rule to independent_once on a judge case, then slip on 0201.
    const judge = await h.judge(sessionId, {
      entityType: "company",
      customerStatus: "new",
      accountAgeMonths: 0,
      jurisdictionRisk: "high",
      uboOwnershipPct: 40,
      uboVerified: true,
      pep: false,
      sanctionsHit: false,
      adverseMedia: false,
      sourceOfFunds: "verified",
      expectedMonthlyVolume: 20_000,
    });
    const judgeCase = (judge.body as { case: { id: string } }).case.id;
    await h.predict(sessionId, judgeCase, "enhancedReview");
    expect((await h.save(sessionId, judgeCase, "enhancedReview")).commit.status).toBe(200);
    const level = async (id: string) => TutorStateSchema.parse((await h.state(sessionId)).body).rules.find((r) => r.ruleId === id)?.level;
    expect(await level("rule-enhanced")).toBe("independent_once");
    expect(await level("rule-never-approve")).toBe("independent_once");

    await h.intent(sessionId, HIGH_NEW_CASE, "approve");
    expect(await level("rule-never-approve")).toBe("assisted");
    const [intervention] = h.entries(sessionId, ["tutor.intervention"]);
    const down = h.entries(sessionId, ["mastery.updated"]).at(-1);
    expect(down?.parentIds[0]).toBe(intervention?.id);
    await h.predict(sessionId, HIGH_NEW_CASE, "enhancedReview");
    expect((await h.save(sessionId, HIGH_NEW_CASE, "enhancedReview")).commit.status).toBe(200);
    // Help proves nothing new: assisted stays assisted.
    expect(await level("rule-never-approve")).toBe("assisted");
  });

  it("a correct answer on a boundary practice case lifts a rule to boundary_correct, then mastered; mastered rules are not asked about", async () => {
    const h = createTutorHarness();
    await h.seedRules([demoRules()[2]!]); // largest owner > 25 % and unverified → request documents
    const sessionId = await h.session();
    const judgeCase = async (uboOwnershipPct: number) => {
      const r = await h.judge(sessionId, {
        entityType: "company",
        customerStatus: "existing",
        accountAgeMonths: 12,
        jurisdictionRisk: "low",
        uboOwnershipPct,
        uboVerified: false,
        pep: false,
        sanctionsHit: false,
        adverseMedia: false,
        sourceOfFunds: "verified",
        expectedMonthlyVolume: 9_000,
      });
      expect(r.status).toBe(201);
      return (r.body as { case: { id: string } }).case.id;
    };
    const view = async (caseId: string) => TutorStateSchema.parse((await h.state(sessionId)).body).cases.find((c) => c.caseId === caseId);
    const level = () => h.entries(sessionId, ["mastery.updated"]).map((e) => parseLedgerPayload(e, "mastery.updated").to).at(-1);

    await h.predict(sessionId, await judgeCase(40), "requestDocuments");
    expect(level()).toBe("independent_once");

    // The solver's boundary cases of the rule: 24.9 %, 25 %, 25.1 % — only "above" is decided by the rule.
    const made = (await h.practice(sessionId)).body as { cases: { id: string; owners: { sharePct: number }[] }[] };
    expect(made.cases.map((c) => Math.max(...c.owners.map((o) => o.sharePct))).sort()).toEqual([24.9, 25, 25.1]);
    const views = await Promise.all(made.cases.map((c) => view(c.id)));
    expect(views.every((v) => v?.origin === "boundary_practice")).toBe(true);
    const askable = views.filter((v) => v?.prompt.ask === true);
    expect(askable).toHaveLength(1);
    await h.predict(sessionId, askable[0]!.caseId, "requestDocuments");
    expect(level()).toBe("boundary_correct");

    await h.predict(sessionId, await judgeCase(60), "requestDocuments");
    expect(level()).toBe("mastered");
    expect((await view(await judgeCase(70)))?.prompt).toEqual({ ask: false, reason: expect.stringContaining("mastered") });
  });
});
