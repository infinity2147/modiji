/**
 * Any language end to end on the server (plan §7.11, P10 "Hindi→English run"), offline: a Hindi-speaking
 * expert is asked in Hindi (the English question kept alongside), answers in Hindi, the utterance is
 * recorded in the original words with its detected language, translated into verified English segments
 * (a separate `utterance.translated` entry), parsed with quotes from the original only, and promoted to a
 * language-neutral rule whose evidence keeps the Hindi quote plus its labelled English translation — which
 * the MCP guardrail cites. No model, or a failed/unverifiable translation → original only, translation
 * pending, never fabricated. Real ledger, fake model.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  MACHINE_TRANSLATION_LABEL,
  RuleConfirmedPayloadSchema,
  parseLedgerPayload,
  type ConfirmedRule,
  type LlmAnswer,
  type LlmLocalizedQuestion,
  type LlmTranslation,
} from "@vashistha/core";
import { GateAuthorizeResponseSchema, PostUtteranceResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { createMcpEndpoint } from "../../lib/server/debrief/mcp";
import { engineState, translationPending } from "../../lib/server/interview/engine-state";
import { quoteLanguageFields, utteranceLanguage } from "../../lib/server/interview/language";
import { localizeQuestion } from "../../lib/server/interview/llm";
import { createInterviewHarness, gateRequest, trainingCases, utterance, type FakeModel, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";

const CLAUSE_1 = "अगर देश हाई-रिस्क लिस्ट पर है,";
const CLAUSE_2 = "तो मैं डेस्क लेवल पर अप्रूव नहीं करती।";
const CLAUSE_3 = "पहले कंप्लायंस से बात होती है।";
const HINDI = `${CLAUSE_1} ${CLAUSE_2} ${CLAUSE_3}`;
const QUOTE = `${CLAUSE_1} ${CLAUSE_2}`;
const SEGMENTS = [
  { original: CLAUSE_1, english: "If the country is on the high-risk list," },
  { original: CLAUSE_2, english: "then I do not approve at desk level." },
  { original: CLAUSE_3, english: "Compliance is consulted first." },
];
const ENGLISH = SEGMENTS.map((s) => s.english).join(" ");
const QUOTE_ENGLISH = "If the country is on the high-risk list, then I do not approve at desk level.";
const EXPERT = { name: "Priya Sharma", language: "hi" as const };
const [ONE] = trainingCases();

function translate(user: string): LlmTranslation {
  expect(user).toContain(HINDI);
  return { segments: SEGMENTS };
}

/** A Devanagari question keeping every number of the English one (what `acceptLocalized` requires). */
function localize(user: string): LlmLocalizedQuestion {
  const english = /<question kind="[a-z_]+">([\s\S]*?)<\/question>/.exec(user)?.[1] ?? "";
  return { text: `प्रश्न ${(english.match(/\d+(?:[.,]\d+)*/g) ?? []).join(" ")} — कृपया बताइए, आपने ऐसा क्यों किया?` };
}

function forbidApprove(exactQuote: string): LlmAnswer {
  return {
    survivingCandidateIds: [],
    eliminatedCandidateIds: [],
    statedRules: [
      {
        when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
        polarity: "forbid",
        action: "approve",
        approvalRole: null,
        kind: "guardrail",
        exactQuote,
      },
    ],
    newConcepts: [],
    answeredAction: null,
    confidence: 0.9,
  };
}

const MODEL: FakeModel = { answer: () => forbidApprove(QUOTE), translate, localize };

/** Session of `expert` after case 1; authorizes the first queued question and has the agent speak it. */
async function asked(h: InterviewHarness, expert: { name: string; language: "en" | "hi" } = EXPERT) {
  const s = await h.session("expert", expert);
  await h.work(s, ONE.id, "enhancedReview", "medium");
  const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
  const question = queue.find((q) => q.kind === "why_probe") ?? queue[0];
  if (question === undefined) throw new Error("nothing queued");
  const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(question.id, contextVersion))).body);
  const turn = await readTurn(await h.llmTurn(s, granted.controlMessage));
  return { s, question, granted, turn };
}

async function mcpExplanation(rule: ConfirmedRule): Promise<string> {
  const server: Server = createServer((req, res) => {
    void createMcpEndpoint({ env: { NODE_ENV: "test" }, rulebook: () => [rule], rulebookRevision: () => 1 })(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "check_action", arguments: { context: { case: { jurisdictionRisk: "high", customerStatus: "new" } }, proposedAction: "approve" } },
      }),
    });
    const body = (await res.json()) as { result: { structuredContent: { decision: string; explanation: string } } };
    expect(body.result.structuredContent.decision).toBe("forbid");
    return body.result.structuredContent.explanation;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Hindi-speaking expert: questions in Hindi", () => {
  it("queues live questions in Hindi with the English original alongside, and the agent speaks exactly the Hindi text", async () => {
    const h = createInterviewHarness();
    h.setModel(MODEL);
    const { s, question, granted, turn } = await asked(h);
    expect(question.language).toBe("hi");
    expect(question.text).toMatch(/^प्रश्न/);
    expect(question.textEnglish).toMatch(/[A-Za-z]/);
    // The localizer saw the rephrased English question.
    expect(h.modelCalls.filter((c) => c.kind === "localize").every((c) => c.user.includes('<target_language code="hi">'))).toBe(true);
    expect(granted.text).toBe(question.text);
    expect(turn).toMatchObject({ kind: "speech", text: question.text });
    const queued = h.ledger.list(s, { kinds: ["question.queued"] }).map((e) => parseLedgerPayload(e, "question.queued"));
    expect(queued.length).toBeGreaterThan(0);
    for (const q of queued) expect(q).toMatchObject({ language: "hi", textEnglish: expect.any(String) as unknown });
  });

  it("keeps the English question when the localizer fails or is rejected (deterministic fallback)", async () => {
    const h = createInterviewHarness();
    h.setModel({ ...MODEL, localize: () => ({ text: "Why did you do that?" }) });
    const { question } = await asked(h);
    expect(question.language).toBeUndefined();
    expect(question.textEnglish).toBeUndefined();
    expect(h.logs.some((l) => l.includes("kept in English: not written in Hindi"))).toBe(true);

    const failing = createInterviewHarness();
    failing.setModel({ answer: () => forbidApprove(QUOTE), translate });
    const { question: english } = await asked(failing);
    expect(english.language).toBeUndefined();
    expect(failing.logs.some((l) => l.includes("kept in English") && l.includes("no fake localize response"))).toBe(true);
  });

  it("asks English experts in English: no localizer call, no translation", async () => {
    const h = createInterviewHarness();
    h.setModel(MODEL);
    const { s, question } = await asked(h, { name: "Sam Lee", language: "en" });
    expect(question.textEnglish).toBeUndefined();
    h.frame(s);
    const r = PostUtteranceResponseSchema.parse((await h.utter(s, utterance(h, s, "Never approve a high-risk country at desk level.", { questionId: question.id }))).body);
    expect(r.language).toBeUndefined();
    expect(r.translation).toBeUndefined();
    expect(h.modelCalls.some((c) => c.kind === "localize" || c.kind === "translate")).toBe(false);
  });

  it("localizeQuestion is a no-op without a model, for English and for an already-localized question", async () => {
    const h = createInterviewHarness();
    const { s, question } = await asked(h);
    expect(question.language).toBeUndefined();
    expect(await localizeQuestion(null, question, "hi")).toBe(question);
    h.setModel(MODEL);
    const claude = h.deps.claude;
    expect(await localizeQuestion(claude, question, "en")).toBe(question);
    const hindi = await localizeQuestion(claude, question, "hi");
    expect(hindi).toMatchObject({ id: question.id, language: "hi", textEnglish: question.text });
    expect(await localizeQuestion(claude, hindi, "hi")).toBe(hindi);
    expect(s).toBeTruthy();
  });
});

describe("Hindi answer → English: utterance, translation, parse, rule, citation", () => {
  it("records the original with its language, translates into verified segments, quotes the original, cites both", async () => {
    const h = createInterviewHarness();
    h.setModel(MODEL);
    const { s, question } = await asked(h);
    const frame = h.frame(s);
    const r = await h.answerWith(s, utterance(h, s, HINDI, { questionId: question.id, language: "hi" }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = PostUtteranceResponseSchema.parse(r.body);
    expect(res.language).toBe("hi");
    expect(res.translation).toEqual({ status: "translated", text: ENGLISH });
    expect(r.parsed?.statedRules[0]?.exactQuote).toBe(QUOTE);

    // The voice entry is exactly what was heard; the translation is the engine's own entry, parented on it.
    const transcript = h.ledger.get(res.utteranceId);
    expect(transcript).toMatchObject({ kind: "utterance.transcript", source: "voice" });
    expect(parseLedgerPayload(transcript!, "utterance.transcript")).toMatchObject({ text: HINDI, language: "hi" });
    const [translated, ...more] = h.ledger.list(s, { kinds: ["utterance.translated"] });
    expect(more).toEqual([]);
    expect(translated).toMatchObject({ source: "engine", parentIds: [res.utteranceId] });
    expect(parseLedgerPayload(translated!, "utterance.translated")).toEqual({
      utteranceId: res.utteranceId,
      language: "hi",
      translation: ENGLISH,
      segments: SEGMENTS,
      model: "claude-sonnet-5-5",
    });
    expect(translated!.sequence).toBeLessThan(h.ledger.list(s, { kinds: ["answer.parsed"] })[0]?.sequence ?? -1);

    // The parser read the translation for meaning and was told to quote the original.
    const parserCall = h.modelCalls.find((c) => c.kind === "answer");
    expect(parserCall?.user).toContain(`<expert_answer language="hi">${HINDI}</expert_answer>`);
    expect(parserCall?.user).toContain(ENGLISH);

    // Engine state: every reader sees language and translation on the utterance record.
    const record = engineState(h.deps, s).utterances.get(res.utteranceId);
    expect(record).toMatchObject({ text: HINDI, language: "hi", translation: { entryId: translated!.id, text: ENGLISH, segments: SEGMENTS } });
    expect(translationPending(record!)).toBe(false);

    // The rule: language-neutral predicate; evidence = Hindi original + its English rendering.
    const [confirmed] = h.ledger.list(s, { kinds: ["rule.confirmed"] });
    const { rule } = RuleConfirmedPayloadSchema.parse(confirmed?.payload);
    expect(rule).toMatchObject({
      kind: "guardrail",
      predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] },
      effect: { type: "forbid", action: "approve" },
      expertId: "priya-sharma",
    });
    expect(rule.evidence[0]).toMatchObject({
      utteranceId: res.utteranceId,
      exactQuote: QUOTE,
      language: "hi",
      translation: QUOTE_ENGLISH,
      frameIds: [frame.id],
      provenance: "human_voice",
    });

    // The agent-facing guardrail cites the original words and the labelled English translation.
    const explanation = await mcpExplanation(rule);
    expect(explanation).toContain(`"${QUOTE}" [in Hindi (हिन्दी); ${MACHINE_TRANSLATION_LABEL}: "${QUOTE_ENGLISH}"]`);
  });

  it("rejects a stated rule quoted from the English translation: nothing is promoted", async () => {
    const h = createInterviewHarness();
    h.setModel({ ...MODEL, answer: () => forbidApprove(QUOTE_ENGLISH) });
    const { s, question } = await asked(h);
    h.frame(s);
    const r = await h.answerWith(s, utterance(h, s, HINDI, { questionId: question.id }));
    expect(r.parsed?.statedRules).toEqual([]);
    expect(h.ledger.list(s, { kinds: ["rule.confirmed"] })).toEqual([]);
    expect(h.logs.some((l) => l.includes("quote is not verbatim in the answer"))).toBe(true);
  });

  it("an unverifiable translation is not stored: original only, translation pending, the answer still parsed from the original", async () => {
    const h = createInterviewHarness();
    h.setModel({ ...MODEL, translate: () => ({ segments: [{ original: "agar desh high-risk hai", english: "If the country is high-risk" }] }) });
    const { s, question } = await asked(h);
    h.frame(s);
    const res = PostUtteranceResponseSchema.parse((await h.answerWith(s, utterance(h, s, HINDI, { questionId: question.id }))).body);
    expect(res.translation).toEqual({ status: "pending" });
    expect(h.ledger.list(s, { kinds: ["utterance.translated"] })).toEqual([]);
    expect(h.logs.some((l) => l.includes("rejected (segment 0 is not verbatim"))).toBe(true);
    expect(h.modelCalls.find((c) => c.kind === "answer")?.user).toContain("<english_translation>unavailable: read the original</english_translation>");
    const { rule } = RuleConfirmedPayloadSchema.parse(h.ledger.list(s, { kinds: ["rule.confirmed"] })[0]?.payload);
    expect(rule.evidence[0]).toMatchObject({ exactQuote: QUOTE, language: "hi" });
    expect(rule.evidence[0]).not.toHaveProperty("translation");
    expect(translationPending(engineState(h.deps, s).utterances.get(res.utteranceId)!)).toBe(true);
  });

  it("without a model: the Hindi original is recorded with its language, translation pending, answer unparsed", async () => {
    const h = createInterviewHarness();
    const { s, question } = await asked(h);
    const res = PostUtteranceResponseSchema.parse((await h.utter(s, utterance(h, s, HINDI, { questionId: question.id }))).body);
    expect(res).toEqual({ utteranceId: res.utteranceId, language: "hi", translation: { status: "pending" } });
    expect(h.ledger.list(s, { kinds: ["utterance.translated", "answer.parsed"] })).toEqual([]);
    expect(engineState(h.deps, s).utterances.get(res.utteranceId)).toMatchObject({ language: "hi", translation: undefined });
  });

  it("a later translation entry never rewrites the first one readers saw", async () => {
    const h = createInterviewHarness();
    h.setModel(MODEL);
    const { s, question } = await asked(h);
    const res = PostUtteranceResponseSchema.parse((await h.utter(s, utterance(h, s, HINDI, { questionId: question.id }))).body);
    h.ledger.append({
      sessionId: s,
      source: "engine",
      kind: "utterance.translated",
      occurredAt: h.deps.now(),
      traceId: "retry",
      parentIds: [res.utteranceId],
      schemaVersion: 1,
      privacyEpoch: h.epoch(s),
      payload: { utteranceId: res.utteranceId, language: "hi", translation: "Something else.", segments: [{ original: HINDI, english: "Something else." }], model: "other" },
    });
    expect(engineState(h.deps, s).utterances.get(res.utteranceId)?.translation?.text).toBe(ENGLISH);
  });
});

describe("utterance language precedence", () => {
  it("the text decides; the client's session language, else the expert's, is only a prior", () => {
    expect(utteranceLanguage(HINDI, { client: undefined, expert: "en" })).toBe("hi");
    expect(utteranceLanguage("Yes, escalate it.", { client: "hi", expert: "hi" })).toBe("en");
    expect(utteranceLanguage("haan, approve nahi", { client: undefined, expert: "hi" })).toBe("hi");
    expect(utteranceLanguage("haan, approve nahi", { client: undefined, expert: "en" })).toBe("en");
    expect(utteranceLanguage("haan, approve nahi", { client: "hi", expert: "en" })).toBe("hi");
    expect(utteranceLanguage("haan, approve nahi", { client: "en", expert: "hi" })).toBe("en");
  });

  it("a Hindi expert answering in English is recorded as English (no translation)", async () => {
    const h = createInterviewHarness();
    h.setModel(MODEL);
    const { s } = await asked(h);
    const res = PostUtteranceResponseSchema.parse((await h.utter(s, utterance(h, s, "I always escalate those."))).body);
    expect(res).toEqual({ utteranceId: res.utteranceId });
    expect(parseLedgerPayload(h.ledger.get(res.utteranceId)!, "utterance.transcript")).not.toHaveProperty("language");
  });

  it("quoteLanguageFields: {} for English; language (+ translation when verified) otherwise", () => {
    const record = { text: HINDI, language: "hi" as const, translation: { entryId: "t", text: ENGLISH, segments: SEGMENTS } };
    expect(quoteLanguageFields(record, CLAUSE_2)).toEqual({ language: "hi", translation: "then I do not approve at desk level." });
    expect(quoteLanguageFields({ ...record, translation: undefined }, CLAUSE_2)).toEqual({ language: "hi" });
    expect(quoteLanguageFields(record, "not in the utterance")).toEqual({ language: "hi" });
    expect(quoteLanguageFields({ text: "Never.", language: "en", translation: undefined }, "Never.")).toEqual({});
    expect(quoteLanguageFields(undefined, "x")).toEqual({});
  });
});
