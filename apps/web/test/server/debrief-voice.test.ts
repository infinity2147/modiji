/**
 * The debrief through voice and without a model: answers to debrief questions arrive as utterances
 * (asked through the gate), the answer parser's `answeredAction` closes an unresolved witness with the
 * expert's spoken words as evidence, a plain "yes" confirms the teach-back, a hedged one does not; and
 * with no Claude, prose is a labelled template.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmedRuleSchema, parseLedgerPayload, type LedgerEntry } from "@vashistha/core";
import { DebriefStateSchema, WorkMapResponseSchema } from "../../lib/contracts/debrief";
import { isAffirmative } from "../../lib/server/debrief/actions";
import { handleGenerateTeachBack, handleGetWorkMap } from "../../lib/server/debrief/handlers";
import { TEACHBACK_MAX_CHARS, templateTeachBack, writeTeachBack } from "../../lib/server/debrief/teachback";
import { CLAUDE_MODELS, createClaude } from "@vashistha/core/server";
import { T0, getState, message, rebuild, reply, world, type World } from "../support/debrief-harness";

let current: World | undefined;
afterEach(() => current?.opened.close());

async function setup(withModel = true): Promise<World> {
  const w = await world();
  if (!withModel) w.deps.claude = null;
  current = w;
  return w;
}

/** The interviewer asks a queued question (gate) and the expert answers it (voice). */
function askAndAnswer(w: World, questionId: string, text: string): LedgerEntry {
  const queued = w.ledger.list(w.sessionId, { kinds: ["question.queued"] }).findLast((e) => parseLedgerPayload(e, "question.queued").id === questionId);
  if (queued === undefined) throw new Error(`question ${questionId} not queued`);
  const base = { sessionId: w.sessionId, occurredAt: T0, traceId: "voice", schemaVersion: 1, privacyEpoch: 0 };
  const authorized = w.ledger.append({ ...base, source: "engine", kind: "gate.authorized", parentIds: [queued.id], payload: { questionId, contextVersion: 0, becameValidAt: T0, decidedAt: T0, conditions: {} } });
  return w.ledger.append({ ...base, source: "voice", kind: "utterance.transcript", parentIds: [authorized.id], payload: { conversationId: "conv-2", text, t0Ms: 10_000, t1Ms: 12_500, frameIds: [] } });
}

describe("debrief by voice", () => {
  it("an answered unresolved witness gains the rule for its cell, quoted from the utterance", async () => {
    const w = await setup();
    let s = await rebuild(w);
    const target = s.witnesses.find((v) => v.witness.kind === "unresolved" && v.conditions.includes("largest owner identity verified: no") && v.conditions.some((c) => c.includes("at most 25%")));
    const questionId = target?.question?.id ?? "";
    const utterance = askAndAnswer(w, questionId, "Small owner, long-standing customer? Approve it.");
    w.ledger.append({
      sessionId: w.sessionId,
      source: "engine",
      kind: "answer.parsed",
      occurredAt: T0,
      traceId: "voice",
      parentIds: [utterance.id],
      schemaVersion: 1,
      privacyEpoch: 0,
      payload: { questionId, utteranceId: utterance.id, survivingCandidateIds: [], eliminatedCandidateIds: [], statedRules: [], newConcepts: [], answeredAction: "approve", confidence: 0.9 },
    });
    expect((await getState(w)).pendingVoiceAnswers).toBe(1);
    expect(s.witnesses.find((v) => v.witness.id === target?.witness.id)?.status).toBe("queued");
    s = await rebuild(w);
    expect(s.pendingVoiceAnswers).toBe(0);
    expect(s.witnesses.find((v) => v.witness.id === target?.witness.id)?.status).toBe("resolved");
    const confirmed = w.ledger.list(w.sessionId, { kinds: ["rule.confirmed"] }).at(-1);
    const rule = ConfirmedRuleSchema.parse((confirmed?.payload as { rule: unknown }).rule);
    expect(rule.evidence[0]).toMatchObject({ utteranceId: utterance.id, provenance: "human_voice", exactQuote: "Small owner, long-standing customer? Approve it.", t0Ms: 10_000, t1Ms: 12_500 });
    expect(rule.confirmedBy[0]).toMatchObject({ method: "debrief", ledgerEntryId: utterance.id });
    expect(s.decisions.find((d) => d.caseId === "NS-2026-0102")?.explained).toBe(true);
  }, 60_000);

  it("confirms the teach-back on a plain yes, never on a hedged one", async () => {
    const w = await setup();
    await rebuild(w);
    let s = DebriefStateSchema.parse((await reply(await handleGenerateTeachBack(w.sessionId, w.deps))).body);
    const questionId = s.teachBack?.questionId ?? "";
    askAndAnswer(w, questionId, "Yes, but only for companies.");
    s = await rebuild(w);
    expect(s.teachBack?.confirmedEntryId).toBeNull();
    s = DebriefStateSchema.parse((await reply(await handleGenerateTeachBack(w.sessionId, w.deps))).body);
    const yes = askAndAnswer(w, s.teachBack?.questionId ?? "", "Yes, that's right.");
    s = await rebuild(w);
    expect(s.teachBack?.confirmedEntryId).not.toBeNull();
    expect(w.ledger.get(s.teachBack?.confirmedEntryId ?? "")?.payload).toMatchObject({ utteranceId: yes.id });
  }, 60_000);
});

describe("without a model", () => {
  it("writes a labelled template teach-back and template Work Map prose", async () => {
    const w = await setup(false);
    const s = DebriefStateSchema.parse((await reply(await handleGenerateTeachBack(w.sessionId, w.deps))).body);
    expect(s.llmAvailable).toBe(false);
    expect(s.teachBack?.origin).toBe("template");
    expect(s.teachBack?.text).toMatch(/^Here is what I learned\. When .* Did I get that right\?$/);
    expect(w.calls).toEqual([]);
    const wm = WorkMapResponseSchema.parse((await reply(await handleGetWorkMap(w.sessionId, w.deps))).body);
    expect(wm.proseOrigin).toBe("template");
    expect(wm.workMap.steps[0]?.title).toBe("NS-2026-0101 — Request documents");
  }, 60_000);

  it("keeps the template within 600 characters, saying how many rules it left out", () => {
    const w = { rules: Array.from({ length: 12 }, (_, i) => i) };
    const rules = w.rules.map((i) =>
      ConfirmedRuleSchema.parse({
        id: `r-${i}`,
        decisionFamily: "reviewOutcome",
        kind: "decision",
        predicate: { ">": [{ var: "expectedMonthlyVolume" }, 1000 * (i + 1)] },
        effect: { type: "recommend", action: "enhancedReview" },
        priority: 10,
        overrides: [],
        evidence: [{ kind: "expert_quote", utteranceId: "u", exactQuote: "q", t0Ms: 0, t1Ms: 0, frameIds: ["f"], eventIds: [], relation: "supports", provenance: "human_text" }],
        confirmedBy: [{ expertId: "e", at: T0, method: "debrief", ledgerEntryId: "u" }],
        revision: 1,
        schemaVersion: 1,
        expertId: "e",
      }),
    );
    const text = templateTeachBack(rules);
    expect(text.length).toBeLessThanOrEqual(TEACHBACK_MAX_CHARS);
    expect(text).toMatch(/And \d+ more rules, shown on screen\. Did I get that right\?$/);
  });

  it("rejects over-long model prose in favour of the template", async () => {
    const long = createClaude({ client: { messages: { create: async () => message("word ".repeat(400)) } }, forbiddenMarkers: [] });
    const out = await writeTeachBack(long, CLAUDE_MODELS.prose, []);
    expect(out.origin).toBe("template");
    expect(out.note).toMatch(/rejected/);
  });
});

describe("isAffirmative", () => {
  it.each([
    ["Yes, that's right.", true],
    ["yeah", true],
    ["That's correct", true],
    ["Correct.", true],
    ["Yes, but not for trusts", false],
    ["No, the threshold is 30%", false],
    ["Mostly right", false],
  ])("%s → %s", (text, expected) => expect(isAffirmative(text)).toBe(expected));
});
