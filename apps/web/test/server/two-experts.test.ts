/**
 * P10 acceptance, two experts (plan §7.10, §11 "disagreement witness shown"): two expert sessions whose
 * rulebooks differ on the long-standing high-risk exception → Z3 finds a valid case where they decide
 * differently → each expert is asked → both answer → the resolution is a revision carrying both
 * experts' exact quotes → the solver reruns and finds no disagreement. Safety: a forbid from one expert
 * stays enforced while the disagreement is open.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAction,
  evaluatePredicate,
  parseLedgerPayload,
  recordLookup,
  ruleExperts,
  type ActionId,
  type ConfirmedRule,
  type ExpertQuoteEvidence,
} from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { handleGetDebrief } from "../../lib/server/debrief/handlers";
import { createDebriefStore, type DebriefDeps } from "../../lib/server/debrief/deps";
import { searchWitnesses } from "@vashistha/solver";
import { DebriefStateSchema } from "../../lib/contracts/debrief";
import { compileProcedure, exportWorkMapJson } from "@vashistha/mcp-guardrails";
import { CLAUDE_MODELS } from "@vashistha/core/server";
import { ASHA, HIGH, LONG_STANDING_HIGH, PRIYA, createExpertsHarness, type ExpertsHarness } from "../support/experts-harness";

const QUOTES = {
  ashaEdd: "Anything from a high-risk country goes to enhanced review.",
  ashaExc: "Unless they have banked with us for two years or more; then I approve.",
  priyaEdd: "High-risk country means enhanced review, every time.",
  priyaForbid: "If the country is on the high-risk list, I never approve at desk level.",
  ashaAnswer: "Fair point: even a long-standing customer from a high-risk country should get enhanced review.",
  priyaAnswer: "Enhanced review. Two years of history does not change the country risk.",
} as const;

let h: ExpertsHarness;
let sessions: { asha: string; priya: string };
let rules: Record<"ashaEdd" | "ashaExc" | "priyaEdd" | "priyaForbid", ConfirmedRule>;

beforeEach(async () => {
  h = createExpertsHarness();
  const asha = await h.expertSession({ name: ASHA.name });
  const priya = await h.expertSession({ name: PRIYA.name, language: "hi" });
  sessions = { asha: asha.sessionId, priya: priya.sessionId };
  const enhanced = { action: "enhancedReview" as ActionId, kind: "decision" as const, effect: { type: "recommend" as const, action: "enhancedReview" as ActionId } };
  const ashaEdd = h.stateRule(sessions.asha, ASHA.id, { id: "rule-asha-edd", quote: QUOTES.ashaEdd, rule: { predicate: HIGH, ...enhanced } });
  rules = {
    ashaEdd,
    ashaExc: h.stateRule(sessions.asha, ASHA.id, {
      id: "rule-asha-exception",
      quote: QUOTES.ashaExc,
      rule: { predicate: LONG_STANDING_HIGH, action: "approve" as ActionId, kind: "exception", effect: { type: "recommend", action: "approve" as ActionId } },
      overrides: [ashaEdd.id],
    }),
    priyaEdd: h.stateRule(sessions.priya, PRIYA.id, { id: "rule-priya-edd", quote: QUOTES.priyaEdd, rule: { predicate: HIGH, ...enhanced } }),
    priyaForbid: h.stateRule(sessions.priya, PRIYA.id, {
      id: "rule-priya-forbid",
      quote: QUOTES.priyaForbid,
      rule: { predicate: HIGH, action: "approve" as ActionId, kind: "guardrail", effect: { type: "forbid", action: "approve" as ActionId } },
    }),
  };
});
afterEach(() => h.cleanup());

const quotesOf = (rule: ConfirmedRule): ExpertQuoteEvidence[] => rule.evidence.filter((e): e is ExpertQuoteEvidence => e.kind === "expert_quote");

describe("expert identity (session start)", () => {
  it("names the expert in session.started; sessions of one name share one expert; the directory lists both", async () => {
    const [started] = h.ledger.list(sessions.priya, { kinds: ["session.started"] });
    expect(started && parseLedgerPayload(started, "session.started").expert).toEqual({ id: PRIYA.id, name: PRIYA.name, language: "hi" });
    const again = await h.expertSession({ name: "asha rao" });
    const { state } = await h.get("");
    expect(state.experts.map((e) => [e.id, e.sessionIds.length])).toEqual([
      [ASHA.id, 2],
      [PRIYA.id, 1],
    ]);
    expect(state.experts[0]?.sessionIds.at(-1)).toBe(again.sessionId);
    expect(state.pair).toBeNull();
    // Identity is the signed-in account's; the request states only the expert's language, and only for an expert session.
    const refused = await h.createSession({ mode: "novice", caseSet: "training", language: "hi" });
    expect(refused.status).toBe(400);
  });
});

describe("two experts disagree, are asked, and reconcile (P10 acceptance)", () => {
  it("Z3 finds a valid case where the rulebooks decide differently, records it in both sessions and asks each expert", async () => {
    const before = await h.get();
    expect(before.state.pair?.witnesses).toEqual([]);
    expect(before.state.pair?.rulebooks.map((b) => b.map((c) => c.rule.id))).toEqual([
      [rules.ashaEdd.id, rules.ashaExc.id],
      [rules.priyaEdd.id, rules.priyaForbid.id],
    ]);

    const r = await h.search();
    expect(r.status).toBe(200);
    const { state } = await h.get();
    const [view] = state.pair?.witnesses ?? [];
    if (view === undefined) throw new Error("a disagreement witness was expected");
    expect(state.pair?.witnesses).toHaveLength(1);
    const w = view.witness;
    if (w.kind !== "disagreement") throw new Error("disagreement witness expected");
    expect(w.experts).toEqual([ASHA.id, PRIYA.id]);
    expect(w.actions).toEqual(["approve", "enhancedReview"]);
    // A valid case: every domain constraint holds, and it is the long-standing high-risk exception.
    for (const c of KYC_DOMAIN.domainConstraints) expect(evaluatePredicate(c, recordLookup(w.assignment)).truth).toBe(true);
    expect(evaluatePredicate(LONG_STANDING_HIGH, recordLookup(w.assignment)).truth).toBe(true);
    expect(view.decisions.map((d) => d.label)).toEqual(["Approve onboarding", "Send to enhanced review"]);
    expect(view.caseLines.map((l) => l.label)).toEqual(expect.arrayContaining(["Customer status", "Relationship age (months)", "Country risk (Northstar list)"]));
    expect(view.status).toBe("asked");

    // Recorded in each expert's session (source solver) with a question for that expert.
    for (const sessionId of [sessions.asha, sessions.priya]) {
      const found = h.ledger.list(sessionId, { kinds: ["witness.found"] });
      expect(found.map((e) => [e.source, parseLedgerPayload(e, "witness.found").id])).toEqual([["solver", w.id]]);
      const queued = h.ledger.list(sessionId, { kinds: ["question.queued"] }).map((e) => parseLedgerPayload(e, "question.queued"));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "witness", target: { witnessId: w.id, assignment: w.assignment } });
      expect(queued[0]?.text).toMatch(/approve onboarding or send to enhanced review\?$/i);
    }
    expect(h.localized.map((l) => l.language)).toEqual(["en", "hi"]);
    // Idempotent: a second search records nothing new.
    expect(((await h.search()).body as { written: string[] }).written).toEqual([]);
  });

  it("safety: while the disagreement is open, the disagreeing decision rules are held back and Priya's forbid stays enforced", async () => {
    await h.search();
    const { state } = await h.get();
    const w = state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    const team = h.disagreements.team();
    expect(team.held.map((x) => x.ruleId).sort()).toEqual([rules.ashaEdd.id, rules.ashaExc.id, rules.priyaEdd.id].sort());
    expect(team.rules.map((r) => r.id)).toEqual([rules.priyaForbid.id]);
    const approve = checkAction({ rules: team.rules, features: recordLookup(w.assignment), action: "approve" as ActionId, domain: KYC_DOMAIN });
    expect(approve).toMatchObject({ decision: "forbid", matchedRules: [rules.priyaForbid.id] });
    expect(approve.evidence[0]?.exactQuote).toBe(QUOTES.priyaForbid);
    expect(state.pair?.team.find((c) => c.rule.id === rules.priyaForbid.id)?.held).toBe(false);
    expect(state.pair?.rulebooks[0].every((c) => c.held)).toBe(true);
  });

  it("both experts answer; the resolution revises the agreed rule with BOTH quotes; the solver finds no more disagreement", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");

    const first = await h.answer(ASHA.id, w.id, "enhancedReview", QUOTES.ashaAnswer);
    expect(first.status).toBe(200);
    expect((await h.get()).state.pair?.witnesses[0]?.status).toBe("answered_one");
    expect(h.ledger.list(sessions.asha, { kinds: ["expert.statement"] }).map((e) => parseLedgerPayload(e, "expert.statement"))).toEqual([
      { text: QUOTES.ashaAnswer, intent: "answer_disagreement", target: { witnessId: w.id, action: "enhancedReview" } },
    ]);

    const second = await h.answer(PRIYA.id, w.id, "enhancedReview", QUOTES.priyaAnswer);
    expect(second.status).toBe(200);
    const { state } = await h.get();
    const view = state.pair?.witnesses[0];
    expect(view?.status).toBe("resolved");
    expect(view?.answers.map((a) => [a?.expertId, a?.action, a?.quote.text])).toEqual([
      [ASHA.id, "enhancedReview", QUOTES.ashaAnswer],
      [PRIYA.id, "enhancedReview", QUOTES.priyaAnswer],
    ]);
    // Priya's rulebook already decides "enhanced review": her rule is revised — Asha joins it, both quotes lead, it overrides Asha's exception.
    expect(view?.resolution).toMatchObject({ kind: "rule_revised", ruleId: rules.priyaEdd.id, revision: 2 });
    expect(view?.resolution?.after.overrides).toEqual([rules.ashaExc.id]);
    expect(view?.resolution?.fields).toEqual(expect.arrayContaining(["overrides", "evidence", "confirmedBy"]));
    const revised = h.disagreements.rulebook().rules.find((r) => r.id === rules.priyaEdd.id);
    if (revised === undefined) throw new Error("revised rule expected");
    const quotes = quotesOf(revised);
    expect(quotes.slice(0, 2).map((q) => [q.exactQuote, q.relation, q.provenance])).toEqual([
      [QUOTES.ashaAnswer, "supports", "human_text"],
      [QUOTES.priyaAnswer, "supports", "human_text"],
    ]);
    expect(quotes.find((q) => q.relation === "contradicts")?.exactQuote).toBe(QUOTES.ashaExc);
    expect(quotes.map((q) => q.exactQuote)).toContain(QUOTES.priyaEdd);
    expect(ruleExperts(revised)).toEqual([PRIYA.id, ASHA.id]);
    expect(revised.confirmedBy.map((c) => c.expertId)).toEqual([ASHA.id, PRIYA.id, PRIYA.id]);
    // Every quote points at a real frame of its own expert's session.
    for (const q of quotes) expect(h.ledger.get(q.frameIds[0])?.kind).toBe("frame.received");

    // Closed in both sessions; the solver reruns and finds nothing; nothing is held back any more.
    for (const sessionId of [sessions.asha, sessions.priya])
      expect(h.ledger.list(sessionId, { kinds: ["witness.resolved"] }).map((e) => parseLedgerPayload(e, "witness.resolved"))).toEqual([
        expect.objectContaining({ witnessId: w.id, resolution: "rule_revised" }),
      ]);
    expect(((await h.search()).body as { written: string[] }).written).toEqual([]);
    expect(state.pair?.open).toBe(0);
    expect(h.disagreements.team().held).toEqual([]);
    expect(state.pair?.rulebooks[0].map((c) => c.rule.id)).toEqual([rules.ashaEdd.id, rules.ashaExc.id, rules.priyaEdd.id]);
    expect(state.pair?.rulebooks[0].find((c) => c.rule.id === rules.priyaEdd.id)?.sharedWith).toEqual([PRIYA.id]);

    // The team rulebook still forbids approving the case (Priya's guardrail), and now decides it by the reconciled rule.
    const team = h.disagreements.team();
    expect(checkAction({ rules: team.rules, features: recordLookup(w.assignment), action: "approve" as ActionId, domain: KYC_DOMAIN }).decision).toBe("forbid");
  });

  it("different answers leave the disagreement open and the rules held back", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    await h.answer(ASHA.id, w.id, "approve", "I still approve them: two years of clean history is enough for me.");
    await h.answer(PRIYA.id, w.id, "enhancedReview", QUOTES.priyaAnswer);
    const { state } = await h.get();
    expect(state.pair?.witnesses[0]?.status).toBe("still_disagree");
    expect(state.pair?.witnesses[0]?.resolution).toBeNull();
    expect(h.disagreements.team().held).toHaveLength(3);
    // An expert can change their answer; the latest one counts.
    await h.answer(ASHA.id, w.id, "enhancedReview", QUOTES.ashaAnswer);
    expect((await h.get()).state.pair?.witnesses[0]?.status).toBe("resolved");
  });

  it("refuses answers that are not the experts' own decision on a recorded case", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    expect((await h.answer("someone-else", w.id, "approve", "I approve this case.")).status).toBe(400);
    expect((await h.answer(ASHA.id, "w_missing", "approve", "I approve this case.")).status).toBe(404);
    expect((await h.answer(ASHA.id, w.id, "rateHigh", "Rate it high.")).status).toBe(400);
    expect(await h.getStatus("?experts=asha-rao,nobody&family=reviewOutcome")).toBe(404);
    expect(await h.getStatus("?experts=asha-rao,asha-rao&family=reviewOutcome")).toBe(400);
  });

  it("an archived session is closed to the reconciliation too: answers and searches that would write into it are refused, its rules stay", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    h.ledger.archive(sessions.asha, { occurredAt: 1, traceId: "archive-asha", by: "operator" });
    const before = h.ledger.list(sessions.asha).length;
    const answered = await h.answer(ASHA.id, w.id, "enhancedReview", QUOTES.ashaAnswer);
    expect(answered).toMatchObject({ status: 409, body: { error: "session_archived" } });
    expect(await h.search()).toMatchObject({ status: 409, body: { error: "session_archived" } });
    expect(h.ledger.list(sessions.asha)).toHaveLength(before);
    expect(h.disagreements.rulebook().rules.map((r) => r.id)).toEqual(expect.arrayContaining([rules.ashaEdd.id, rules.ashaExc.id]));
  });

  it("each expert's debrief reads only their own rulebook and ignores the disagreement (it belongs to this flow)", async () => {
    await h.search();
    const deps: DebriefDeps = {
      ledger: h.ledger,
      casedesk: h.deps.store,
      interview: h.disagreements.interview,
      engineConfig: h.disagreements.engineConfig,
      authorizations: h.disagreements.authorizations,
      rulebook: h.disagreements.rulebook,
      solver: searchWitnesses,
      claude: null,
      models: { prose: CLAUDE_MODELS.prose },
      exports: { workMapJson: exportWorkMapJson, procedure: compileProcedure },
      store: createDebriefStore(),
      dataDir: h.dataDir,
      mcpBearerRequired: false,
      now: () => 0,
      log: h.disagreements.log,
    };
    const response = await handleGetDebrief(sessions.priya, deps);
    expect(response.status).toBe(200);
    const debrief = DebriefStateSchema.parse(await response.json());
    expect(debrief.rules.map((r) => r.rule.id)).toEqual([rules.priyaEdd.id, rules.priyaForbid.id]);
    expect(debrief.witnesses.some((v) => v.witness.kind === "disagreement")).toBe(false);
    expect(debrief.gaps.some((g) => g.source === "live_question")).toBe(false);
  });
});

describe("answers by voice, and agreement on a third decision", () => {
  const HINDI = "एन्हांस्ड रिव्यू। दो साल पुराना ग्राहक होने से देश का रिस्क नहीं बदलता।";
  const ENGLISH = "Enhanced review. Being a two-year-old customer does not change the country risk.";

  it("a spoken Hindi answer is quoted in the original words, with its machine translation attached for display", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    const [queued] = h.ledger.list(sessions.priya, { kinds: ["question.queued"] });
    const [frame] = h.ledger.list(sessions.priya, { kinds: ["frame.received"] });
    const session = h.ledger.getSession(sessions.priya);
    if (queued === undefined || frame === undefined || session === undefined) throw new Error("question and frame expected");
    const questionId = parseLedgerPayload(queued, "question.queued").id;
    const at = (kind: string, source: "voice" | "engine", payload: unknown, parentIds: string[]) =>
      h.ledger.append({ sessionId: sessions.priya, source, kind, occurredAt: 0, traceId: "voice", parentIds, schemaVersion: 1, privacyEpoch: session.privacyEpoch, payload });
    // What the interview writes for a spoken answer: the transcript (original words), its translation, the parsed answer.
    const utterance = at("utterance.transcript", "voice", { conversationId: "c", text: HINDI, t0Ms: 2_000, t1Ms: 7_000, frameIds: [frame.id], language: "hi" }, [queued.id]);
    at("utterance.translated", "engine", { utteranceId: utterance.id, language: "hi", translation: ENGLISH, segments: [{ original: HINDI, english: ENGLISH }], model: "fake" }, [utterance.id]);
    at(
      "answer.parsed",
      "engine",
      { questionId, utteranceId: utterance.id, survivingCandidateIds: [], eliminatedCandidateIds: [], statedRules: [], newConcepts: [], answeredAction: "enhancedReview", confidence: 0.9 },
      [utterance.id, queued.id],
    );
    expect((await h.answer(ASHA.id, w.id, "enhancedReview", QUOTES.ashaAnswer)).status).toBe(200);

    const view = (await h.get()).state.pair?.witnesses[0];
    expect(view?.status).toBe("resolved");
    expect(view?.answers[1]).toMatchObject({ via: "voice", action: "enhancedReview", quote: { text: HINDI, language: "hi", translation: ENGLISH } });
    const revised = h.disagreements.rulebook().rules.find((r) => r.id === rules.priyaEdd.id);
    const priyaQuote = revised === undefined ? undefined : quotesOf(revised).find((q) => q.utteranceId === utterance.id);
    expect(priyaQuote).toMatchObject({ exactQuote: HINDI, language: "hi", translation: ENGLISH, provenance: "human_voice", relation: "supports", t0Ms: 2_000, t1Ms: 7_000 });
  });

  it("when both agree on a decision neither rulebook makes, a new rule for the case's decision cell is confirmed by both", async () => {
    await h.search();
    const w = (await h.get()).state.pair?.witnesses[0]?.witness;
    if (w === undefined) throw new Error("witness expected");
    await h.answer(ASHA.id, w.id, "escalateCompliance", "Honestly, a case like this should go to the compliance officer.");
    await h.answer(PRIYA.id, w.id, "escalateCompliance", "Agreed, compliance should decide this one.");
    const view = (await h.get()).state.pair?.witnesses[0];
    expect(view?.status).toBe("resolved");
    expect(view?.resolution).toMatchObject({ kind: "rule_added", before: null, after: { then: "escalate to compliance officer", experts: [ASHA.id, PRIYA.id] } });
    const added = h.disagreements.rulebook().rules.find((r) => r.id === view?.resolution?.ruleId);
    if (added === undefined) throw new Error("added rule expected");
    expect(added.overrides).toEqual([rules.ashaExc.id, rules.priyaEdd.id].sort());
    expect(evaluatePredicate(added.predicate, recordLookup(w.assignment)).truth).toBe(true);
    expect(quotesOf(added).filter((q) => q.relation === "supports")).toHaveLength(2);
    expect(((await h.search()).body as { written: string[] }).written).toEqual([]);
  });
});
