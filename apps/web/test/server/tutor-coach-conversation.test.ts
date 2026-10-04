/**
 * The voice coach as a conversation: what a trainee says in a novice session (or types) gets a spoken reply,
 * grounded in the confirmed rulebook and the case on screen. The model's reply is checked by code (cited rules,
 * verbatim quotes, no outcome given away before a prediction); a failed check, a failed call or no model falls back
 * to a template, so the coach always answers. Nothing is said off the record; newer words supersede a reply in
 * progress; the ledger cites the trainee's words. Real ledger, real rulebook store, real handlers, fake model behind
 * the real `createClaude` (oracle guard on).
 */
import { describe, expect, it } from "vitest";
import { QuestionSchema, parseLedgerPayload, type LedgerEntry } from "@vashistha/core";
import { createClaude, type ClaudeClient } from "@vashistha/core/server";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { CoachChatResponseSchema, TutorStateSchema } from "../../lib/contracts/tutor";
import { handlePostUtterance } from "../../lib/server/interview/handlers";
import { entry } from "../../lib/server/interview/ledger";
import { waitingCoachTurns } from "../../lib/server/tutor/coach";
import { COACH_REPLY_WINDOW_MS, closeCoachWords } from "../../lib/server/interview/orchestrator";
import { COACH_SYSTEM, MAX_REPLY_WORDS, type LlmCoachReply, replyBySpeech } from "../../lib/server/tutor/conversation";
import type { TutorDeps } from "../../lib/server/tutor/deps";
import { handleCoachChat } from "../../lib/server/tutor/handlers";
import { jsonRequest } from "../support/casedesk-harness";
import { message } from "../support/debrief-harness";
import { QUOTES, createTutorHarness, demoRules, type TutorHarness } from "../support/tutor-harness";

const HIGH_NEW_CASE = "NS-2026-0201";

type Prompted = { system: string; user: string };
type Answer = LlmCoachReply | Error | ((user: string) => LlmCoachReply | Promise<LlmCoachReply>);

/** Fake model: answers coach prompts in order (a reply, a thrown error, or a function of the prompt). */
function fakeModel(answers: Answer[], seen: Prompted[]): ClaudeClient {
  return {
    messages: {
      create: async (params) => {
        const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
        const user = params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("");
        if (system !== COACH_SYSTEM) throw new Error("unexpected prompt");
        seen.push({ system, user });
        const next = answers.shift();
        if (next === undefined) throw new Error("no answer scripted");
        if (next instanceof Error) throw next;
        const output = typeof next === "function" ? await next(user) : next;
        return message(JSON.stringify(output));
      },
    },
  };
}

/** The label (R1, R2 …) the prompt gives the rule quoting `quote`. */
function labelOf(user: string, quote: string): string {
  const line = user.split("\n").find((l) => l.includes(quote));
  const label = line?.match(/^(R\d+)/)?.[1];
  if (label === undefined) throw new Error(`no rule line quotes ${quote}`);
  return label;
}

/** Timers the test fires by hand (the coach's idle window). */
function manualTimers() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    live: () => timers.filter((t) => !t.cancelled),
  };
}

type Setup = { h: TutorHarness; s: string; coach: TutorDeps; seen: Prompted[]; ruleEntries: Map<string, string>; timers: ReturnType<typeof manualTimers> };

async function setup(answers: Answer[] | null): Promise<Setup> {
  const h = createTutorHarness();
  const ruleEntries = await h.seedRules(demoRules());
  const s = await h.session();
  const seen: Prompted[] = [];
  const claude = answers === null ? null : createClaude({ client: fakeModel(answers, seen), forbiddenMarkers: [ORACLE_MARKER] });
  const coach: TutorDeps = { ...h.tutor, claude };
  const timers = manualTimers();
  h.interview.schedule = timers.schedule;
  h.interview.coachReply = (input) => replyBySpeech(coach, input);
  return { h, s, coach, seen, ruleEntries, timers };
}

async function say(h: TutorHarness, s: string, text: string, over: Record<string, unknown> = {}): Promise<{ status: number; body: { utteranceId?: string; error?: string } }> {
  const r = await handlePostUtterance(
    jsonRequest(`/api/sessions/${s}/utterances`, { conversationId: "conv-1", text, t0Ms: 1_000, t1Ms: 2_000, privacyEpoch: h.epoch(s), ...over }),
    s,
    h.interview,
  );
  return { status: r.status, body: (await r.json()) as { utteranceId?: string; error?: string } };
}

/** Says `text` and lets the coach's window close: resolves once the coach has answered. */
async function sayAndWait(h: TutorHarness, s: string, text: string): Promise<string> {
  const r = await say(h, s, text);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await closeCoachWords(h.interview, s);
  return r.body.utteranceId ?? "";
}

async function openCase(h: TutorHarness, s: string, caseId = HIGH_NEW_CASE): Promise<void> {
  expect((await h.events(s, [{ kind: "open_case", caseId }])).status).toBe(200);
}

function replies(h: TutorHarness, s: string): { entry: LedgerEntry; payload: ReturnType<typeof parseLedgerPayload<"tutor.coached">>; text: string }[] {
  const texts = new Map(
    h.entries(s, ["question.queued"]).flatMap((e) => {
      const q = QuestionSchema.parse(e.payload);
      return q.kind === "coach_turn" ? [[q.id, q.text] as const] : [];
    }),
  );
  return h
    .entries(s, ["tutor.coached"])
    .map((entry) => ({ entry, payload: parseLedgerPayload(entry, "tutor.coached") }))
    .filter((r) => r.payload.trigger === "reply")
    .map((r) => ({ ...r, text: texts.get(r.payload.questionId) ?? "" }));
}

describe("the coach answers what the trainee says", () => {
  it("a novice utterance gets a grounded, model-written coach turn with provenance to the words, the case and the rule", async () => {
    let reply: LlmCoachReply | undefined;
    const { h, s, seen, ruleEntries } = await setup([
      (user) => {
        const r1 = labelOf(user, QUOTES.enhanced);
        reply = {
          reply: `Look at the country risk and that the customer is new. The expert said: "${QUOTES.enhanced}" What did you see on the screening?`,
          citedRules: [r1],
          intent: "correct_misconception",
        };
        return reply;
      },
    ]);
    await openCase(h, s);
    expect((await h.predict(s, HIGH_NEW_CASE, "approve")).status).toBe(200);
    const utteranceId = await sayAndWait(h, s, "Why not approve it? It looks fine to me.");

    // The prompt: the confirmed rules with the expert's words, the case on screen, the prediction, the words.
    const [prompt] = seen;
    expect(prompt?.user).toContain(QUOTES.enhanced);
    expect(prompt?.user).toContain(`CURRENT CASE ${HIGH_NEW_CASE}`);
    expect(prompt?.user).toContain("Trainee's prediction: approve onboarding (wrong");
    expect(prompt?.user).toContain("THE TRAINEE JUST SAID: Why not approve it? It looks fine to me.");

    const [coached, ...more] = replies(h, s);
    expect(more).toEqual([]);
    expect(coached?.payload).toMatchObject({ caseId: HIGH_NEW_CASE, origin: "llm", ruleIds: ["rule-enhanced"], utteranceId, trigger: "reply" });
    expect(coached?.text).toBe(reply?.reply);
    expect(coached?.entry.parentIds).toEqual(expect.arrayContaining([utteranceId, ruleEntries.get("rule-enhanced")]));
    // The case on screen, as of its latest entry (here the prediction made on it).
    const predicted = h.entries(s, ["tutor.prediction"]).at(-1);
    expect(coached?.entry.parentIds).toContain(predicted?.id);

    // The coach turn is queued for the tutor's authorized speech, and the captions show both turns.
    const queued = h.entries(s, ["question.queued"]).map((e) => QuestionSchema.parse(e.payload)).find((q) => q.id === coached?.payload.questionId);
    expect(queued).toMatchObject({ kind: "coach_turn", ephemeral: true, target: { caseId: HIGH_NEW_CASE, ruleId: "rule-enhanced" } });
    const state = TutorStateSchema.parse((await h.state(s)).body);
    const tail = state.coach.slice(-2);
    expect(tail).toMatchObject([
      { id: utteranceId, role: "trainee", text: "Why not approve it? It looks fine to me.", caseId: HIGH_NEW_CASE, spoken: true },
      { id: coached?.payload.questionId, role: "coach", text: reply?.reply, trigger: "reply", spoken: false },
    ]);

    // Once the gate authorizes it, the caption says it was spoken.
    const granted = await h.authorize(s, coached?.payload.questionId ?? "", h.authorizations.getContextVersion(s));
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const after = TutorStateSchema.parse((await h.state(s)).body);
    expect(after.coach.find((t) => t.id === coached?.payload.questionId)?.spoken).toBe(true);
  });

  it("segments within the idle window are one turn; the window is short", async () => {
    const { h, s, timers, seen } = await setup([{ reply: "Good question. What does the screening show?", citedRules: [], intent: "check_understanding" }]);
    const first = await say(h, s, "So the country is high risk,");
    const second = await say(h, s, "and the customer is new.");
    const [window] = timers.live();
    expect(window?.ms).toBe(COACH_REPLY_WINDOW_MS);
    expect(COACH_REPLY_WINDOW_MS).toBeLessThanOrEqual(1_500);
    expect(timers.live()).toHaveLength(1);
    await closeCoachWords(h.interview, s);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain("THE TRAINEE JUST SAID: So the country is high risk, and the customer is new.");
    const [coached] = replies(h, s);
    expect(coached?.payload.utteranceId).toBe(second.body.utteranceId);
    expect(coached?.entry.parentIds).toEqual(expect.arrayContaining([first.body.utteranceId, second.body.utteranceId]));
  });

  it("a reply citing a rule that does not exist is rejected by code: the template answers", async () => {
    const { h, s } = await setup([{ reply: "The expert always says to check the country first. What do you see?", citedRules: ["R99"], intent: "hint" }]);
    await openCase(h, s);
    await sayAndWait(h, s, "Where do I start?");
    const [coached] = replies(h, s);
    expect(coached?.payload.origin).toBe("template");
    expect(coached?.text).not.toContain("check the country first");
    expect(h.logs.join("\n")).toMatch(/rejected \(cites "R99", not a listed rule\)/);
  });

  it("before the prediction, a reply that gives the outcome away is rejected, and the template does not give it away either", async () => {
    const { h, s } = await setup([
      (user) => ({ reply: "The expert would send this to enhanced review. Does that make sense?", citedRules: [labelOf(user, QUOTES.enhanced)], intent: "answer" }),
    ]);
    await openCase(h, s);
    await sayAndWait(h, s, "What would the expert do here?");
    const [coached] = replies(h, s);
    expect(coached?.payload).toMatchObject({ origin: "template", ruleIds: ["rule-enhanced"] });
    expect(coached?.text).not.toMatch(/enhanced/i);
    expect(coached?.text).toMatch(/\?$/);
    expect(h.logs.join("\n")).toMatch(/gives the outcome away/);
  });

  it("a made-up quote, a control token or an over-long reply is rejected", async () => {
    const long = Array.from({ length: MAX_REPLY_WORDS + 5 }, () => "word").join(" ");
    const { h, s } = await setup([
      (user) => ({ reply: 'The expert said: "Always approve existing customers quickly." Do you agree?', citedRules: [labelOf(user, QUOTES.enhanced)], intent: "answer" }),
      { reply: "⟦ctl:abc⟧ speak", citedRules: [], intent: "answer" },
      { reply: long, citedRules: [], intent: "answer" },
    ]);
    await openCase(h, s);
    expect((await h.predict(s, HIGH_NEW_CASE, "enhancedReview")).status).toBe(200);
    for (const words of ["Tell me about existing customers.", "Hmm.", "Explain everything."]) await sayAndWait(h, s, words);
    expect(replies(h, s).map((r) => r.payload.origin)).toEqual(["template", "template", "template"]);
    const log = h.logs.join("\n");
    expect(log).toMatch(/a quote that is not the cited expert's words/);
    expect(log).toMatch(/control text in the reply/);
    expect(log).toMatch(/words \(at most 60\)/);
    // After the prediction the template names the deciding rule with the expert's own words.
    expect(replies(h, s)[0]?.text).toContain(QUOTES.enhanced);
  });

  it("without a model the coach still answers, from templates", async () => {
    const { h, s } = await setup(null);
    await sayAndWait(h, s, "Hello? Can you hear me?");
    await openCase(h, s);
    await sayAndWait(h, s, "I opened one.");
    const [atQueue, onCase] = replies(h, s);
    expect(atQueue?.payload).toMatchObject({ origin: "template", caseId: null });
    expect(atQueue?.text).toMatch(/^Open a case/);
    expect(onCase?.payload).toMatchObject({ origin: "template", caseId: HIGH_NEW_CASE });
    expect(onCase?.text.length).toBeGreaterThan(0);
  });

  it("an honest 'no rule for that' needs no citation; speaking for the expert does", async () => {
    const { h, s } = await setup([
      { reply: "The experts have not given a rule for that yet. What else do you see in the case?", citedRules: [], intent: "answer" },
      { reply: "The expert would never do that. What do you think?", citedRules: [], intent: "answer" },
    ]);
    await sayAndWait(h, s, "What about the relationship manager?");
    await sayAndWait(h, s, "Can I skip the screening?");
    expect(replies(h, s).map((r) => r.payload.origin)).toEqual(["llm", "template"]);
    expect(h.logs.join("\n")).toMatch(/speaks for the expert without citing a rule/);
  });

  it("a failed model call falls back to the template", async () => {
    const { h, s } = await setup([new Error("overloaded")]);
    await openCase(h, s);
    await sayAndWait(h, s, "Is this one risky?");
    expect(replies(h, s).map((r) => r.payload.origin)).toEqual(["template"]);
    expect(h.logs.join("\n")).toMatch(/coach model failed/);
  });

  it("newer words supersede a reply still being drafted: only the latest is queued", async () => {
    const gates: (() => void)[] = [];
    const held = (text: string) => () =>
      new Promise<LlmCoachReply>((resolve) => gates.push(() => resolve({ reply: text, citedRules: [], intent: "answer" })));
    const { h, s } = await setup([held("Reply to the first."), held("Reply to the second.")]);
    await openCase(h, s);
    await say(h, s, "First thought.");
    const firstReply = closeCoachWords(h.interview, s);
    await expect.poll(() => gates.length).toBe(1);
    const second = await say(h, s, "Actually, second thought.");
    const secondReply = closeCoachWords(h.interview, s);
    await expect.poll(() => gates.length).toBe(2);
    gates[0]?.();
    await firstReply;
    expect(replies(h, s)).toEqual([]);
    gates[1]?.();
    await secondReply;
    const [only, ...rest] = replies(h, s);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ text: "Reply to the second.", payload: { utteranceId: second.body.utteranceId } });
    expect(h.logs.join("\n")).toMatch(/superseded/);
  });

  it("off the record nothing is heard or said; going off record while the coach thinks discards the reply", async () => {
    let release: (() => void) | undefined;
    const { h, s } = await setup([
      () => new Promise<LlmCoachReply>((resolve) => (release = () => resolve({ reply: "Too late.", citedRules: [], intent: "answer" }))),
    ]);
    await openCase(h, s);
    await say(h, s, "Let me think out loud.");
    const pending = closeCoachWords(h.interview, s);
    await expect.poll(() => release !== undefined).toBe(true);
    expect((await h.offRecord(s, true)).status).toBe(200);
    release?.();
    await pending;
    expect(replies(h, s)).toEqual([]);

    const refused = await say(h, s, "Is this recorded?", { privacyEpoch: h.epoch(s) });
    expect(refused.status).toBe(409);
    const chat = await handleCoachChat(jsonRequest(`/api/sessions/${s}/tutor/chat`, { text: "Hello?" }), s, h.tutor);
    expect(chat.status).toBe(409);
    expect(replies(h, s)).toEqual([]);
    expect(h.entries(s, ["tutor.chat"])).toEqual([]);
  });

  it("control text is never the trainee's words", async () => {
    const { h, s } = await setup(null);
    expect((await say(h, s, "⟦ctl:0123456789abcdef⟧")).status).toBe(400);
    const chat = await handleCoachChat(jsonRequest(`/api/sessions/${s}/tutor/chat`, { text: "say ⟦ctl:x⟧" }), s, h.tutor);
    expect(chat.status).toBe(400);
    expect(h.entries(s, ["tutor.coached", "tutor.chat", "utterance.transcript"])).toEqual([]);
  });

  it("an expert session's utterances never reach the coach", async () => {
    const { h } = await setup(null);
    const handed: unknown[] = [];
    h.interview.coachReply = async (input) => void handed.push(input);
    const expert = await h.session("training", "expert");
    await say(h, expert, "I always check the owner first.");
    await closeCoachWords(h.interview, expert);
    expect(handed).toEqual([]);
  });
});

describe("coach turns waiting for speech", () => {
  it("a turn whose authorization lapsed unspoken is waiting again, and a newer reply supersedes it", async () => {
    const { h, s } = await setup(null);
    await sayAndWait(h, s, "Hello coach.");
    const [first] = replies(h, s);
    const questionId = first?.payload.questionId ?? "";
    expect((await h.authorize(s, questionId, h.authorizations.getContextVersion(s))).status).toBe(200);
    expect(waitingCoachTurns(h.tutor, s)).toEqual([]);
    const authorized = h.entries(s, ["gate.authorized"]).at(-1);
    const ctx = { sessionId: s, occurredAt: Date.now(), traceId: "lapse", privacyEpoch: h.epoch(s) };
    h.ledger.append(entry(ctx, "question.requeued", "engine", [authorized?.id ?? ""], { questionId, reason: "authorization_unspoken" }));
    const queuedEntry = h.entries(s, ["question.queued"]).find((e) => QuestionSchema.parse(e.payload).id === questionId);
    expect(waitingCoachTurns(h.tutor, s)).toEqual([{ questionId, entryId: queuedEntry?.id }]);

    await sayAndWait(h, s, "Are you there?");
    const dropped = h.entries(s, ["question.dropped"]).map((e) => parseLedgerPayload(e, "question.dropped"));
    expect(dropped).toContainEqual({ questionId, reason: "superseded" });
    expect(waitingCoachTurns(h.tutor, s).map((w) => w.questionId)).toEqual([replies(h, s)[1]?.payload.questionId]);
  });
});

describe("typed chat with the coach", () => {
  it("records the trainee's words, answers like speech and returns the reply as text", async () => {
    const { h, s, coach, ruleEntries } = await setup([
      (user) => ({ reply: `Yes: the country is high risk and the customer is new. The expert said: "${QUOTES.neverApprove}" What will you choose?`, citedRules: [labelOf(user, QUOTES.neverApprove)], intent: "answer" }),
    ]);
    await openCase(h, s);
    expect((await h.predict(s, HIGH_NEW_CASE, "approve")).status).toBe(200);
    const r = await handleCoachChat(jsonRequest(`/api/sessions/${s}/tutor/chat`, { text: "Can I approve it anyway?" }), s, coach);
    expect(r.status).toBe(200);
    const body = CoachChatResponseSchema.parse(await r.json());
    expect(body.text).toContain(QUOTES.neverApprove);
    expect(body.questionId).not.toBeNull();

    const [said] = h.entries(s, ["tutor.chat"]);
    expect(said).toMatchObject({ source: "client", payload: { text: "Can I approve it anyway?" } });
    const [coached] = replies(h, s);
    expect(coached?.payload).toMatchObject({ questionId: body.questionId, utteranceId: said?.id, origin: "llm", ruleIds: ["rule-never-approve"] });
    expect(coached?.entry.parentIds).toEqual(expect.arrayContaining([said?.id, ruleEntries.get("rule-never-approve")]));

    const state = TutorStateSchema.parse((await h.state(s)).body);
    expect(state.coach.slice(-2)).toMatchObject([
      { role: "trainee", text: "Can I approve it anyway?", spoken: false, trigger: null },
      { role: "coach", id: body.questionId, text: body.text, trigger: "reply" },
    ]);
  });

  it("works without a model, and only in novice sessions", async () => {
    const { h, s } = await setup(null);
    const r = await handleCoachChat(jsonRequest(`/api/sessions/${s}/tutor/chat`, { text: "What should I look at?" }), s, h.tutor);
    expect(r.status).toBe(200);
    const body = CoachChatResponseSchema.parse(await r.json());
    expect(body.text.length).toBeGreaterThan(0);
    const expert = await h.session("training", "expert");
    const refused = await handleCoachChat(jsonRequest(`/api/sessions/${expert}/tutor/chat`, { text: "Hi" }), expert, h.tutor);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "not_novice" });
    const empty = await handleCoachChat(jsonRequest(`/api/sessions/${s}/tutor/chat`, { text: "   " }), s, h.tutor);
    expect(empty.status).toBe(400);
  });
});
