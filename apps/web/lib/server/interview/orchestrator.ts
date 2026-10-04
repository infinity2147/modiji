/**
 * Server-side interview orchestration (plan §7.2–7.3): what the engine does when the expert commits a
 * decision or answers a question. LLMs infer (parse, propose, rephrase), the expert confirms (only an
 * explicit statement with an exact quote and frames becomes a ConfirmedRule), code enforces (every
 * write is registry-validated; the gate and the nonce store decide speech).
 *
 * Engine work for one session runs strictly in order (`serially`): a decision step and an answer step
 * never interleave, so each folds the ledger, writes, and the next sees its writes. Context-version
 * bumps happen synchronously in the request that changes the context, so an in-flight authorization
 * is refused by the nonce store at once.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  RULE_PRIORITY_BY_KIND,
  RuleConfirmedPayloadSchema,
  RuleRevisedPayloadSchema,
  canonicalJson,
  contentId,
  isContradiction,
  isLiveQuestionKind,
  legacyExpertId,
  planConfirmation,
  promoteToConfirmedRule,
  type AnswerSegments,
  type AnsweredUtterance,
  type EngineConfig,
  type ExpertLanguage,
  type LedgerEntry,
  type ParsedAnswer,
  type Question,
  type Rulebook,
} from "@vashistha/core";
import type { Claude, Ledger } from "@vashistha/core/server";
import type { z } from "zod";
import type { PostUtteranceRequestSchema, PostUtteranceResponseSchema } from "../../contracts/interview";
import type { AuthorizationStore } from "../authorizations";
import { ApiFailure } from "../casedesk/http";
import type { CaseDeskStore, InterviewHooks } from "../casedesk/session";
import {
  engineState,
  queuedQuestions,
  questionFamily,
  topCandidates,
  unexplainedDecisions,
  type FamilyState,
  type InterviewStore,
  type OpenAnswer,
  type QuestionRecord,
} from "./engine-state";
import { entry, type EntryContext } from "./ledger";
import { quoteLanguageFields, utteranceLanguage } from "./language";
import { REASONING_MODEL, localizeQuestion, parseAnswer, proposeConcepts, rephraseQuestion, translateUtterance } from "./llm";
import { planQueue, type QuestionGenerator } from "./questions";

export type InterviewDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  store: InterviewStore;
  authorizations: Pick<AuthorizationStore, "issue" | "getContextVersion" | "bumpContextVersion" | "pending" | "sweep" | "confirmVoiced">;
  /** Null without ANTHROPIC_API_KEY: utterances are still recorded, answers stay unparsed. */
  claude: Claude | null;
  config: EngineConfig;
  /** Question generation (the engine worker in the server; in process in tests). */
  questions: QuestionGenerator;
  /** The global confirmed rulebook (every expert session): a stated rule the expert already has revises it instead of duplicating it. */
  rulebook: () => Rulebook;
  now: () => number;
  /** Runs `fn` once after `delayMs` (the answer window's idle timer); returns the cancel function. */
  schedule: (fn: () => void, delayMs: number) => () => void;
  /**
   * The debrief conversation's reader of a spoken reply to one of its turns (a `debrief_turn` question): such an
   * answer goes here, never to the answer parser. Unset: the reply is recorded and nothing reads it.
   */
  debriefAnswer?: (input: { sessionId: string; questionId: string; segments: AnsweredUtterance[] }) => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
};

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Yields to the event loop once (`setImmediate`) before running `fn`, so the handler's response is
 * written to the client before this post-response work touches the engine (live response-path
 * hardening: a host freeze or GC pause after the response still cannot delay the live speech path).
 * Scheduled inside the session's serial queue, so `interviewIdle` still awaits it.
 */
function afterResponse<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      fn().then(resolve, reject);
    });
  });
}

/** Runs `task` after every earlier task of the session has settled. */
function serially<T>(deps: InterviewDeps, sessionId: string, task: () => Promise<T>): Promise<T> {
  const run = (deps.store.tails.get(sessionId) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deps.store.tails.set(sessionId, settled);
  void settled.then(() => {
    if (deps.store.tails.get(sessionId) === settled) deps.store.tails.delete(sessionId);
  });
  return run;
}

/** Resolves once the session's queued engine work has settled (tests, graceful shutdown). */
export async function interviewIdle(store: InterviewStore, sessionId: string): Promise<void> {
  for (let tail = store.tails.get(sessionId); tail !== undefined; tail = store.tails.get(sessionId)) await tail;
}

function entryContext(deps: InterviewDeps, sessionId: string, traceId: string): EntryContext {
  const session = deps.ledger.getSession(sessionId);
  if (session === undefined) throw new ApiFailure(404, "session_not_found", "no session with this id");
  return { sessionId, occurredAt: deps.now(), traceId, privacyEpoch: session.privacyEpoch };
}

/**
 * Whether the session is archived (read-only, `session.archived`). Engine work that outlives the
 * archive — a lapsed authorization, an answer window closing, a parse or rephrase still in flight —
 * stops here instead of appending, which the ledger would refuse (`session_archived`). Logged once per
 * skipped step.
 */
function archived(deps: InterviewDeps, sessionId: string, skipped: string): boolean {
  if (deps.ledger.getSession(sessionId)?.archived !== true) return false;
  deps.log.info(`[interview] session ${sessionId} is archived; ${skipped} skipped`);
  return true;
}

/** The CaseDesk handlers call these after their own writes succeeded. */
export function interviewHooks(deps: InterviewDeps): InterviewHooks {
  return {
    decisionCommitted(decision, { info, session }) {
      // The context bump is synchronous — an in-flight authorization must be stale at once — but the
      // engine fold and queue regeneration run only after the commit response has been flushed.
      deps.authorizations.bumpContextVersion(session.id);
      if (info.mode !== "expert") return;
      serially(deps, session.id, () => afterResponse(() => afterDecision(deps, session.id, decision))).catch((error: unknown) =>
        deps.log.error(`[interview] engine step for decision ${decision.id} failed: ${describeError(error)}`),
      );
    },
    screenChanged(sessionId) {
      deps.authorizations.bumpContextVersion(sessionId);
    },
  };
}

/**
 * One committed expert decision: `hypotheses.updated` with the surprise judged BEFORE the update
 * (the fold computed it), then the queue regenerated for the decided case.
 */
async function afterDecision(deps: InterviewDeps, sessionId: string, decision: LedgerEntry): Promise<void> {
  if (archived(deps, sessionId, `the engine step for decision ${decision.id}`)) return;
  const state = engineState(deps, sessionId);
  for (const family of state.families.values()) {
    const record = family.decisions.find((d) => d.entryId === decision.id);
    if (record === undefined) continue;
    const bits = record.recent.surprise.bits;
    const updated = deps.ledger.append(
      entry(entryContext(deps, sessionId, decision.traceId), "hypotheses.updated", "engine", [decision.id], {
        decisionFamily: family.model.family.id,
        hypothesisSetId: family.set.id,
        top: topCandidates(family),
        ...(Number.isFinite(bits) && { surpriseBits: bits }),
        contradiction: isContradiction(record.recent.surprise, deps.config),
      }),
    );
    await requeue(deps, sessionId, family.model.family.id, {
      withWhyProbe: true,
      parentIds: [decision.id, updated.id],
      traceId: decision.traceId,
    });
  }
}

/**
 * Regenerates the session's live-interview queue for `familyId`: queues the planned questions that
 * are not queued yet (rephrased by Sonnet when available) and drops every queued live-interview
 * question (`LIVE_QUESTION_KINDS`) that was not re-planned (`superseded`). Questions of the other
 * flows — debrief witnesses and teach-backs, tutor predictions and interventions — are never touched:
 * this planner does not produce them, so it has no grounds to supersede them. Drops and new questions
 * are appended together, after re-reading the queue, so a question authorised while the rephraser ran
 * is never dropped.
 */
async function requeue(
  deps: InterviewDeps,
  sessionId: string,
  familyId: string,
  opts: { withWhyProbe: boolean; parentIds: string[]; traceId: string },
): Promise<void> {
  const before = engineState(deps, sessionId);
  const family = before.families.get(familyId);
  if (family === undefined) return;
  const wasLive = new Set(queuedQuestions(before).map((r) => r.question.id));
  const planned = await planQueue({
    state: before,
    family,
    withWhyProbe: opts.withWhyProbe,
    contextVersion: deps.authorizations.getContextVersion(sessionId),
    parentIds: opts.parentIds,
    now: deps.now(),
    config: deps.config,
    generate: deps.questions,
  });
  const fresh = await rephrased(
    deps,
    planned.filter((q) => !wasLive.has(q.id)),
    before.expert?.language ?? "en",
  );
  if (archived(deps, sessionId, `regenerating the ${familyId} queue`)) return;

  const live = queuedQuestions(engineState(deps, sessionId)).filter((r) => isLiveQuestionKind(r.question.kind));
  const liveIds = new Set(live.map((r) => r.question.id));
  const keep = new Set(planned.map((q) => q.id));
  const ctx = entryContext(deps, sessionId, opts.traceId);
  deps.ledger.appendMany([
    ...live
      .filter((r) => !keep.has(r.question.id))
      .map((r) =>
        entry(ctx, "question.dropped", "engine", [r.queuedEntryId, ...opts.parentIds], { questionId: r.question.id, reason: "superseded" }),
      ),
    ...fresh.filter((q) => !liveIds.has(q.id)).map((q) => entry(ctx, "question.queued", "engine", q.parentIds, q)),
  ]);
}

/**
 * The questions as they will be spoken: rephrased by Sonnet (English, checked by `acceptRephrase`),
 * then — for an expert who speaks another language — translated into it (`localizeQuestion`, which
 * keeps the English as `textEnglish` and falls back to the English question). Without a model the
 * template questions stand.
 */
async function rephrased(deps: InterviewDeps, questions: readonly Question[], language: ExpertLanguage): Promise<Question[]> {
  const { claude } = deps;
  if (claude === null) return [...questions];
  return Promise.all(
    questions.map(async (q) => {
      let english = q;
      try {
        const decision = await rephraseQuestion(claude, q);
        if (decision.accepted) english = { ...q, text: decision.text };
        else deps.log.info(`[interview] kept the template wording of ${q.id}: ${decision.reason}`);
      } catch (error) {
        deps.log.warn(`[interview] rephrasing ${q.id} failed; template wording kept: ${describeError(error)}`);
      }
      return localizeQuestion(claude, english, language, deps.log);
    }),
  );
}

type PostUtteranceRequest = z.infer<typeof PostUtteranceRequestSchema>;
type PostUtteranceResponse = z.infer<typeof PostUtteranceResponseSchema>;

/** Redacted frames on screen while the expert spoke, as ledger entry ids (see `recordUtterance`). */
const MAX_FRAMES_PER_UTTERANCE = 8;

/**
 * Frames of the current privacy epoch shown while the expert spoke: the latest `frame.received`
 * (what is on screen now) and the frames received within the utterance's duration before it. Ledger
 * clock only (utterance times are conversation-relative, frame times are capture times). Empty until
 * perception uploads frames.
 */
function utteranceFrames(ledger: Pick<Ledger, "list">, sessionId: string, privacyEpoch: number, durationMs: number): string[] {
  const frames = ledger.list(sessionId, { sources: ["client"], kinds: ["frame.received"] }).filter((f) => f.privacyEpoch === privacyEpoch);
  const latest = frames.at(-1);
  if (latest === undefined) return [];
  return frames
    .filter((f) => f.receivedAt >= latest.receivedAt - durationMs)
    .slice(-MAX_FRAMES_PER_UTTERANCE)
    .map((f) => f.id);
}

/**
 * Records a final expert transcript (`voice` / `utterance.transcript`) with its language (detected by
 * code, `utteranceLanguage`); a non-English one is then translated (`translate`) before anything reads
 * it. Every segment is its own evidence entry. A segment that answers an asked question joins the
 * session's open answer (live bug #3: the voice provider splits an answer at sentence boundaries, and
 * the stop-rule was often in the second segment); the answer is parsed once its window closes
 * (`closeAnswer`), and then applied, its explicit statements promoted and the queue regenerated.
 * Without a parser the utterance is recorded and the answer stays unparsed (`unparsedAnswers`), never guessed.
 * A reply to a debrief conversation turn (`debrief_turn`) is collected the same way, over a short window
 * (`DEBRIEF_ANSWER_WINDOW_MS`), and handed to the conversation, which needs no model for a plain yes / no / skip.
 */
export function recordUtterance(deps: InterviewDeps, sessionId: string, body: PostUtteranceRequest): Promise<PostUtteranceResponse> {
  return serially(deps, sessionId, async () => {
    const state = engineState(deps, sessionId);
    const record = body.questionId === undefined ? undefined : state.questions.get(body.questionId);
    if (body.questionId !== undefined && record?.asked === undefined)
      throw new ApiFailure(409, "question_not_asked", `question ${body.questionId} was not asked in this session`);
    // Answering a question is itself proof the agent voiced it: confirm the authorization so its speak is
    // no longer provisional (no re-speak on retry, no re-queue — live bug #2).
    if (body.questionId !== undefined) deps.authorizations.confirmVoiced(sessionId, body.questionId);
    const ctx: EntryContext = { sessionId, occurredAt: deps.now(), traceId: randomUUID(), privacyEpoch: body.privacyEpoch };
    const language = utteranceLanguage(body.text, { client: body.language, expert: state.expert?.language });
    // The ledger re-checks epoch and off-record atomically (409 stale_epoch / off_record on a race).
    const utterance = deps.ledger.append(
      entry(ctx, "utterance.transcript", "voice", record?.asked ? [record.asked.entryId] : [], {
        conversationId: body.conversationId,
        text: body.text,
        t0Ms: body.t0Ms,
        t1Ms: body.t1Ms,
        frameIds: utteranceFrames(deps.ledger, sessionId, body.privacyEpoch, body.t1Ms - body.t0Ms),
        ...(language !== "en" && { language }),
      }),
    );
    const translation = language === "en" ? undefined : await translate(deps, { sessionId, utteranceId: utterance.id, text: body.text, language, traceId: ctx.traceId });
    const recorded: PostUtteranceResponse = {
      utteranceId: utterance.id,
      ...(language !== "en" && {
        language,
        translation: translation === undefined ? { status: "pending" as const } : { status: "translated" as const, text: translation },
      }),
    };
    if (record === undefined) return recorded;
    const debrief = record.question.kind === "debrief_turn";
    if (debrief && deps.debriefAnswer === undefined) {
      deps.log.info(`[interview] no debrief conversation configured; reply ${utterance.id} to ${record.question.id} recorded only`);
      return recorded;
    }
    if (!debrief && deps.claude === null) {
      deps.log.info(`[interview] no answer parser configured; answer ${utterance.id} to ${record.question.id} recorded unparsed`);
      return recorded;
    }
    if (record.answeredBy !== undefined) {
      deps.log.info(`[interview] ${utterance.id} arrived after the answer to ${record.question.id} was parsed: recorded, not parsed again`);
      return recorded;
    }
    if (archived(deps, sessionId, `collecting answer segment ${utterance.id}`)) return recorded;
    const segment: AnsweredUtterance = { id: utterance.id, text: body.text, t0Ms: body.t0Ms, t1Ms: body.t1Ms, language, ...(translation !== undefined && { translation }) };
    collectSegment(deps, sessionId, record.question.id, ctx.traceId, segment, debrief ? DEBRIEF_ANSWER_WINDOW_MS : ANSWER_WINDOW_IDLE_MS);
    return recorded;
  });
}

/**
 * How long the server waits for another transcript segment of an answer before parsing it, when no
 * agent turn or new authorization closes the answer first. The server hears no audio, so this is
 * measured between segment arrivals: it spans the gate's answer silence (4 s), the next sentence and
 * its transcription.
 */
export const ANSWER_WINDOW_IDLE_MS = 12_000;

/**
 * The idle window for a spoken reply to a debrief conversation turn. The debrief's voice is turn-taking (one
 * ElevenLabs user turn is normally one final transcript), so a short window keeps the conversation responsive;
 * a late segment opens a new reply, which the conversation ignores as stale once the next turn is asked.
 */
export const DEBRIEF_ANSWER_WINDOW_MS = 1_500;

/** Adds a segment to the session's open answer (closing another question's open answer first) and re-arms its idle timer. */
function collectSegment(deps: InterviewDeps, sessionId: string, questionId: string, traceId: string, segment: AnsweredUtterance, idleMs: number): void {
  if (deps.store.answers.get(sessionId)?.questionId !== questionId) void closeAnswer(deps, sessionId);
  const open = deps.store.answers.get(sessionId);
  open?.cancel();
  deps.store.answers.set(sessionId, {
    questionId,
    segments: open === undefined ? [segment] : [...open.segments, segment],
    traceId: open?.traceId ?? traceId,
    cancel: deps.schedule(() => void closeAnswer(deps, sessionId), idleMs),
  });
}

/**
 * Closes the session's open answer — the next agent turn, a new authorization, or the idle timer — and
 * parses it in the session's serial queue: all its segments in one parse, each segment still its own
 * evidence entry, and every quote verbatim within one segment. A reply to a debrief conversation turn is
 * handed to the conversation instead (`answerDebrief`). Resolves once the parse (or the reply) has settled.
 */
export function closeAnswer(deps: InterviewDeps, sessionId: string): Promise<void> {
  const open = deps.store.answers.get(sessionId);
  if (open === undefined) return Promise.resolve();
  open.cancel();
  deps.store.answers.delete(sessionId);
  const [utterance, ...continuation] = open.segments;
  return serially(deps, sessionId, async (): Promise<"debrief" | undefined> => {
    if (archived(deps, sessionId, `parsing answer ${utterance.id} to ${open.questionId}`)) return undefined;
    const record = engineState(deps, sessionId).questions.get(open.questionId);
    if (record?.question.kind === "debrief_turn") return "debrief";
    if (deps.claude === null || record?.asked === undefined) {
      deps.log.info(`[interview] answer ${utterance.id} to ${open.questionId} left unparsed (no parser, or the question is no longer asked)`);
      return undefined;
    }
    await interpretAnswer(deps, deps.claude, { sessionId, record, utterance, continuation, traceId: open.traceId });
    return undefined;
  })
    .then((next) => (next === "debrief" ? answerDebrief(deps, sessionId, open) : undefined))
    .catch((error: unknown) => deps.log.error(`[interview] parsing answer ${utterance.id} failed: ${describeError(error)}`));
}

/**
 * A spoken reply to a debrief conversation turn, handed to the conversation (`debriefAnswer`) rather than the
 * answer parser: code reads a plain yes / no / skip without any model, and the conversation alone decides
 * whether the turn is still the one waiting. It runs after the interview's serial queue, not in it: the
 * conversation keeps its own order, and its model and solver work never holds up the next utterance. Its
 * failures are logged, never thrown into the utterance route.
 */
async function answerDebrief(deps: InterviewDeps, sessionId: string, open: OpenAnswer): Promise<void> {
  const ids = open.segments.map((s) => s.id).join(", ");
  if (deps.debriefAnswer === undefined) {
    deps.log.info(`[interview] no debrief conversation configured; reply ${ids} to ${open.questionId} recorded only`);
    return;
  }
  try {
    await deps.debriefAnswer({ sessionId, questionId: open.questionId, segments: [...open.segments] });
  } catch (error) {
    deps.log.error(`[interview] debrief reply ${ids} to ${open.questionId} failed: ${describeError(error)}`);
  }
}

/**
 * Re-queues the questions whose authorization expired unspoken (live bug #1: the control message was
 * merged into an open user turn and skipped, yet the question counted as asked, spent budget and was
 * never asked again). Each is recorded as `question.requeued` (it was not asked; the live budget does
 * not count it). A live question about a case that is no longer the family's latest decision is then
 * dropped as superseded: the queue only holds questions about the case just decided (questions.ts).
 */
export function requeueLapsed(deps: InterviewDeps): void {
  for (const lapsed of deps.authorizations.sweep(deps.now())) {
    if (archived(deps, lapsed.sessionId, `re-queueing ${lapsed.questionId} after its authorization lapsed`)) continue;
    const state = engineState(deps, lapsed.sessionId);
    const record = state.questions.get(lapsed.questionId);
    // Only the question's latest authorization re-queues it (an older lapsed one says nothing about a newer).
    if (record?.status !== "asked" || record.asked === undefined || record.asked.at > lapsed.issuedAt) continue;
    try {
      const ctx = entryContext(deps, lapsed.sessionId, randomUUID());
      const requeued = deps.ledger.append(
        entry(ctx, "question.requeued", "engine", [record.asked.entryId], { questionId: lapsed.questionId, reason: "authorization_unspoken" }),
      );
      deps.log.info(`[interview] authorization ${lapsed.nonceDigest} for ${lapsed.questionId} expired unspoken; question re-queued`);
      const latest = questionFamily(state, record.question)?.decisions.at(-1)?.caseId;
      const { caseId } = record.question.target;
      if (isLiveQuestionKind(record.question.kind) && caseId !== undefined && caseId !== latest)
        deps.ledger.append(entry(ctx, "question.dropped", "engine", [record.queuedEntryId, requeued.id], { questionId: lapsed.questionId, reason: "superseded" }));
    } catch (error) {
      deps.log.warn(`[interview] re-queueing ${lapsed.questionId} after its authorization lapsed failed: ${describeError(error)}`);
    }
  }
}

/**
 * Translation of a non-English utterance (plan §7.11), as its own `utterance.translated` entry (source
 * `engine`, parent the utterance): the transcript entry stays exactly what the voice channel heard, and
 * the model's product carries the engine's provenance. Runs before the answer is parsed, in the
 * session's serial queue, bounded by the translator's deadline. Without a model, or when the
 * translation fails or does not verify, nothing is written: the utterance keeps its original words and
 * its translation stays pending (`translationPending`) — never fabricated. Returns the English text.
 */
async function translate(
  deps: InterviewDeps,
  input: { sessionId: string; utteranceId: string; text: string; language: Exclude<ExpertLanguage, "en">; traceId: string },
): Promise<string | undefined> {
  if (deps.claude === null) {
    deps.log.info(`[interview] no model configured; ${input.language} utterance ${input.utteranceId} kept untranslated (translation pending)`);
    return undefined;
  }
  let result;
  try {
    result = await translateUtterance(deps.claude, { text: input.text, language: input.language });
  } catch (error) {
    deps.log.warn(`[interview] translating utterance ${input.utteranceId} failed; translation pending: ${describeError(error)}`);
    return undefined;
  }
  if (!result.ok) {
    deps.log.warn(`[interview] translation of utterance ${input.utteranceId} rejected (${result.reason}); translation pending`);
    return undefined;
  }
  if (archived(deps, input.sessionId, `recording the translation of utterance ${input.utteranceId}`)) return undefined;
  deps.ledger.append(
    entry(entryContext(deps, input.sessionId, input.traceId), "utterance.translated", "engine", [input.utteranceId], {
      utteranceId: input.utteranceId,
      language: input.language,
      translation: result.translation,
      segments: result.segments,
      model: REASONING_MODEL,
    }),
  );
  return result.translation;
}

async function interpretAnswer(
  deps: InterviewDeps,
  claude: Claude,
  input: { sessionId: string; record: QuestionRecord; traceId: string } & AnswerSegments,
): Promise<void> {
  const { sessionId, record } = input;
  const utteranceId = input.utterance.id;
  const segmentIds = [utteranceId, ...(input.continuation ?? []).map((u) => u.id)];
  const state = engineState(deps, sessionId);
  const family = questionFamily(state, record.question);
  if (family === undefined) {
    deps.log.warn(`[interview] no decision family for question ${record.question.id}; answer ${utteranceId} left unparsed`);
    return;
  }
  let conversion;
  try {
    conversion = await parseAnswer(claude, {
      decisionFamily: family.model.family.id,
      question: record.question,
      utterance: input.utterance,
      ...(input.continuation !== undefined && { continuation: input.continuation }),
      set: family.set,
      domain: family.model.domain,
      pendingConcepts: state.undefinedConcepts,
    });
  } catch (error) {
    deps.log.warn(`[interview] answer parser failed; answer ${utteranceId} left unparsed: ${describeError(error)}`);
    return;
  }
  for (const r of conversion.rejected) deps.log.info(`[interview] parser output rejected (${r.item}): ${r.reason}`);
  if (archived(deps, sessionId, `recording the parse of answer ${utteranceId}`)) return;

  const ctx = entryContext(deps, sessionId, input.traceId);
  const parsedEntry = deps.ledger.append(entry(ctx, "answer.parsed", "engine", [...segmentIds, record.queuedEntryId], conversion.answer));
  const after = engineState(deps, sessionId);
  const outcome = after.answers.get(parsedEntry.id);
  const applied = outcome === undefined ? undefined : after.families.get(outcome.decisionFamily);
  if (outcome === undefined || applied === undefined) {
    deps.log.info(`[interview] answer ${parsedEntry.id} skipped by the engine; question stays open`);
    return;
  }
  for (const i of outcome.ignored) deps.log.info(`[interview] answer item ignored (${i.item}): ${i.reason}`);
  // Explicit statements stand on their own quote and frames, whatever the parse confidence (live bug #5).
  promoteStatements(deps, ctx, { answer: conversion.answer, answerEntryId: parsedEntry.id, decisionFamily: outcome.decisionFamily });
  if (outcome.status !== "applied" && !outcome.statedRules.some((r) => r.status === "candidate")) {
    deps.log.info(`[interview] answer ${parsedEntry.id} below the parse-confidence floor: inferences not applied; question stays open`);
    return;
  }
  const updated = deps.ledger.append(
    entry(ctx, "hypotheses.updated", "engine", [parsedEntry.id], {
      decisionFamily: outcome.decisionFamily,
      hypothesisSetId: applied.set.id,
      top: topCandidates(applied),
      contradiction: false,
    }),
  );
  if (outcome.status === "applied" && record.question.kind === "why_probe") await proposeNewConcepts(deps, claude, ctx, { family: applied, utterance: utteranceId });
  await requeue(deps, sessionId, outcome.decisionFamily, { withWhyProbe: false, parentIds: [parsedEntry.id, updated.id], traceId: input.traceId });
}

/**
 * Explicit-statement promotion (plan §7.3): a rule the expert stated outright, quoted verbatim, becomes
 * a ConfirmedRule — evidence-validated by `promoteToConfirmedRule` against the ledger. Its evidence is
 * the transcript segment the quote is verbatim in (`rule.utteranceId`, else the answer's utterance) and
 * the frames on screen while it was said; without frames the statement stays an `expert_statement`
 * candidate for the debrief.
 */
function promoteStatements(deps: InterviewDeps, ctx: EntryContext, input: { answer: ParsedAnswer; answerEntryId: string; decisionFamily: string }): void {
  const { answer } = input;
  if (answer.statedRules.length === 0) return;
  const state = engineState(deps, ctx.sessionId);
  // Rules are stated in the session's feature model (base + confirmed concepts) and record its version.
  const { domain, schemaVersion } = state.schema.model;
  const expertId = state.expert?.id ?? legacyExpertId(ctx.sessionId);
  answer.statedRules.forEach((rule, index) => {
    const utteranceId = rule.utteranceId ?? answer.utteranceId;
    const utterance = state.utterances.get(utteranceId);
    const [frame, ...frames] = utterance?.frameIds ?? [];
    if (frame === undefined) {
      deps.log.info(`[interview] stated rule ${index} in ${utteranceId} not promoted: no frame on record for the utterance`);
      return;
    }
    const result = promoteToConfirmedRule({
      ruleId: contentId("rule", canonicalJson({ utteranceId: answer.utteranceId, index })),
      domain,
      decisionFamily: input.decisionFamily,
      source: { statedRule: rule },
      priority: RULE_PRIORITY_BY_KIND[rule.kind],
      overrides: [],
      evidence: [
        {
          kind: "expert_quote",
          utteranceId,
          exactQuote: rule.exactQuote,
          t0Ms: rule.t0Ms,
          t1Ms: rule.t1Ms,
          frameIds: [frame, ...frames],
          eventIds: [],
          relation: "supports",
          provenance: "human_voice",
          // The original words are the evidence; a non-English quote also carries its language and English rendering.
          ...quoteLanguageFields(utterance, rule.exactQuote),
        },
      ],
      confirmation: { expertId, at: ctx.occurredAt, method: "explicit_statement", ledgerEntryId: utteranceId },
      expertId,
      schemaVersion,
      ledger: deps.ledger,
    });
    if (!result.ok) {
      deps.log.warn(`[interview] stated rule ${index} of ${utteranceId} not promoted: ${result.errors.map((e) => e.code).join(", ")}`);
      return;
    }
    // Rule de-duplication: the same rule restated (in this session or an earlier one of the same expert) revises it.
    const book = deps.rulebook();
    const plan = planConfirmation(book.rules, result.rule);
    const parents = [input.answerEntryId, utteranceId];
    if (plan.kind === "duplicate") deps.log.info(`[interview] stated rule ${index} of ${utteranceId} adds nothing to ${plan.existing.id}; not recorded again`);
    else if (plan.kind === "merge") {
      const existingEntry = book.history.findLast((h) => h.ruleId === plan.existing.id)?.ledgerEntryId;
      deps.ledger.append(
        entry(ctx, "rule.revised", "engine", existingEntry === undefined ? parents : [...parents, existingEntry], RuleRevisedPayloadSchema.parse({ rule: plan.rule, reason: plan.reason })),
      );
    } else deps.ledger.append(entry(ctx, "rule.confirmed", "engine", parents, RuleConfirmedPayloadSchema.parse({ rule: plan.rule })));
  });
}

/** After a why-probe answer: latent concepts behind the decisions the hypotheses still cannot explain (plan §7.3 B). */
async function proposeNewConcepts(deps: InterviewDeps, claude: Claude, ctx: EntryContext, input: { family: FamilyState; utterance: string }): Promise<void> {
  const state = engineState(deps, ctx.sessionId);
  const unexplained = unexplainedDecisions(input.family, deps.config);
  if (unexplained.length === 0) return;
  try {
    const conversion = await proposeConcepts(claude, { transcript: state.transcript, unexplained, pendingConcepts: state.undefinedConcepts });
    for (const r of conversion.rejected) deps.log.info(`[interview] proposed concept ${r.name} rejected: ${r.reason}`);
    if (archived(deps, ctx.sessionId, "recording proposed concepts")) return;
    deps.ledger.appendMany(conversion.concepts.map((c) => entry(ctx, "concept.proposed", "engine", [input.utterance], c)));
  } catch (error) {
    deps.log.warn(`[interview] concept proposer failed: ${describeError(error)}`);
  }
}
