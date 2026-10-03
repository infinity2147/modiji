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
  RuleConfirmedPayloadSchema,
  canonicalJson,
  contentId,
  isContradiction,
  promoteToConfirmedRule,
  type EngineConfig,
  type LedgerEntry,
  type ParsedAnswer,
  type Question,
  type RuleKindSchema,
} from "@vashistha/core";
import type { Claude, Ledger } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import type { PostUtteranceRequestSchema, PostUtteranceResponseSchema } from "../../contracts/interview";
import type { AuthorizationStore } from "../authorizations";
import { ApiFailure } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, type CaseDeskStore, type InterviewHooks } from "../casedesk/session";
import {
  engineState,
  queuedQuestions,
  questionFamily,
  topCandidates,
  unexplainedDecisions,
  type FamilyState,
  type InterviewStore,
  type QuestionRecord,
} from "./engine-state";
import { entry, type EntryContext } from "./ledger";
import { parseAnswer, proposeConcepts, rephraseQuestion } from "./llm";
import { planQueue } from "./questions";

export type InterviewDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  store: InterviewStore;
  authorizations: Pick<AuthorizationStore, "issue" | "getContextVersion" | "bumpContextVersion">;
  /** Null without ANTHROPIC_API_KEY: utterances are still recorded, answers stay unparsed. */
  claude: Claude | null;
  config: EngineConfig;
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};

/**
 * Priority of a rule promoted from an explicit statement, by kind, until the debrief (P5) orders
 * rules explicitly: guardrails above exceptions above escalations above plain decisions.
 */
const STATED_RULE_PRIORITY: Record<z.infer<typeof RuleKindSchema>, number> = {
  decision: 10,
  escalation: 20,
  exception: 30,
  guardrail: 40,
};

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The single expert of a capture session (plan §7.10 adds a second one per session). */
export function sessionExpertId(sessionId: string): string {
  return `expert-${sessionId}`;
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

/** The CaseDesk handlers call these after their own writes succeeded. */
export function interviewHooks(deps: InterviewDeps): InterviewHooks {
  return {
    decisionCommitted(decision, { info, session }) {
      deps.authorizations.bumpContextVersion(session.id);
      if (info.mode !== "expert") return;
      serially(deps, session.id, () => afterDecision(deps, session.id, decision)).catch((error: unknown) =>
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
 * Regenerates the session's queue for `familyId`: queues the planned questions that are not live
 * yet (rephrased by Sonnet when available) and drops every live question that was not re-planned
 * (`superseded`). Drops and new questions are appended together, after re-reading the live queue,
 * so a question authorised while the rephraser ran is never dropped.
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
  const planned = planQueue({
    state: before,
    family,
    withWhyProbe: opts.withWhyProbe,
    contextVersion: deps.authorizations.getContextVersion(sessionId),
    parentIds: opts.parentIds,
    now: deps.now(),
    config: deps.config,
  });
  const wasLive = new Set(queuedQuestions(before).map((r) => r.question.id));
  const fresh = await rephrased(
    deps,
    planned.filter((q) => !wasLive.has(q.id)),
  );

  const live = queuedQuestions(engineState(deps, sessionId));
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

async function rephrased(deps: InterviewDeps, questions: readonly Question[]): Promise<Question[]> {
  const { claude } = deps;
  if (claude === null) return [...questions];
  return Promise.all(
    questions.map(async (q) => {
      try {
        const decision = await rephraseQuestion(claude, q);
        if (decision.accepted) return { ...q, text: decision.text };
        deps.log.info(`[interview] kept the template wording of ${q.id}: ${decision.reason}`);
      } catch (error) {
        deps.log.warn(`[interview] rephrasing ${q.id} failed; template wording kept: ${describeError(error)}`);
      }
      return q;
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
 * Records a final expert transcript (`voice` / `utterance.transcript`). When it answers an asked
 * question and a parser is available, the answer is parsed (Sonnet), recorded as `answer.parsed`,
 * applied by the engine, explicit statements are promoted, and the queue is regenerated. Without a
 * parser the utterance is recorded and the answer stays unparsed (`unparsedAnswers`), never guessed.
 */
export function recordUtterance(deps: InterviewDeps, sessionId: string, body: PostUtteranceRequest): Promise<PostUtteranceResponse> {
  return serially(deps, sessionId, async () => {
    const state = engineState(deps, sessionId);
    const record = body.questionId === undefined ? undefined : state.questions.get(body.questionId);
    if (body.questionId !== undefined && record?.asked === undefined)
      throw new ApiFailure(409, "question_not_asked", `question ${body.questionId} was not asked in this session`);
    const ctx: EntryContext = { sessionId, occurredAt: deps.now(), traceId: randomUUID(), privacyEpoch: body.privacyEpoch };
    // The ledger re-checks epoch and off-record atomically (409 stale_epoch / off_record on a race).
    const utterance = deps.ledger.append(
      entry(ctx, "utterance.transcript", "voice", record?.asked ? [record.asked.entryId] : [], {
        conversationId: body.conversationId,
        text: body.text,
        t0Ms: body.t0Ms,
        t1Ms: body.t1Ms,
        frameIds: utteranceFrames(deps.ledger, sessionId, body.privacyEpoch, body.t1Ms - body.t0Ms),
      }),
    );
    if (record === undefined) return { utteranceId: utterance.id };
    if (deps.claude === null) {
      deps.log.info(`[interview] no answer parser configured; answer ${utterance.id} to ${record.question.id} recorded unparsed`);
      return { utteranceId: utterance.id };
    }
    const parsed = await interpretAnswer(deps, deps.claude, { sessionId, record, utterance: utterance.id, body, traceId: ctx.traceId });
    return parsed === undefined ? { utteranceId: utterance.id } : { utteranceId: utterance.id, parsed };
  });
}

async function interpretAnswer(
  deps: InterviewDeps,
  claude: Claude,
  input: { sessionId: string; record: QuestionRecord; utterance: string; body: PostUtteranceRequest; traceId: string },
): Promise<ParsedAnswer | undefined> {
  const { sessionId, record, body } = input;
  const state = engineState(deps, sessionId);
  const family = questionFamily(state, record.question);
  if (family === undefined) {
    deps.log.warn(`[interview] no decision family for question ${record.question.id}; answer ${input.utterance} left unparsed`);
    return undefined;
  }
  let conversion;
  try {
    conversion = await parseAnswer(claude, {
      decisionFamily: family.model.family.id,
      question: record.question,
      utterance: { id: input.utterance, text: body.text, t0Ms: body.t0Ms, t1Ms: body.t1Ms },
      set: family.set,
      pendingConcepts: state.undefinedConcepts,
    });
  } catch (error) {
    deps.log.warn(`[interview] answer parser failed; answer ${input.utterance} left unparsed: ${describeError(error)}`);
    return undefined;
  }
  for (const r of conversion.rejected) deps.log.info(`[interview] parser output rejected (${r.item}): ${r.reason}`);

  const ctx = entryContext(deps, sessionId, input.traceId);
  const parsedEntry = deps.ledger.append(entry(ctx, "answer.parsed", "engine", [input.utterance, record.queuedEntryId], conversion.answer));
  const after = engineState(deps, sessionId);
  const outcome = after.answers.get(parsedEntry.id);
  if (outcome?.status !== "applied") {
    deps.log.info(`[interview] answer ${parsedEntry.id} not applied (${outcome?.status ?? "skipped"}); question stays open`);
    return conversion.answer;
  }
  for (const i of outcome.ignored) deps.log.info(`[interview] answer item ignored (${i.item}): ${i.reason}`);
  const applied = after.families.get(outcome.decisionFamily);
  if (applied === undefined) return conversion.answer;
  const updated = deps.ledger.append(
    entry(ctx, "hypotheses.updated", "engine", [parsedEntry.id], {
      decisionFamily: outcome.decisionFamily,
      hypothesisSetId: applied.set.id,
      top: topCandidates(applied),
      contradiction: false,
    }),
  );
  promoteStatements(deps, ctx, { answer: conversion.answer, answerEntryId: parsedEntry.id, decisionFamily: outcome.decisionFamily });
  if (record.question.kind === "why_probe") await proposeNewConcepts(deps, claude, ctx, { family: applied, utterance: input.utterance });
  await requeue(deps, sessionId, outcome.decisionFamily, { withWhyProbe: false, parentIds: [parsedEntry.id, updated.id], traceId: input.traceId });
  return conversion.answer;
}

/**
 * Explicit-statement promotion (plan §7.3): a rule the expert stated outright, quoted verbatim, becomes
 * a ConfirmedRule — evidence-validated by `promoteToConfirmedRule` against the ledger. Promotion needs
 * at least one frame on screen while the expert spoke; without frames the statement stays an
 * `expert_statement` candidate for the debrief.
 */
function promoteStatements(deps: InterviewDeps, ctx: EntryContext, input: { answer: ParsedAnswer; answerEntryId: string; decisionFamily: string }): void {
  const { answer } = input;
  if (answer.statedRules.length === 0) return;
  const utterance = engineState(deps, ctx.sessionId).utterances.get(answer.utteranceId);
  const [frame, ...frames] = utterance?.frameIds ?? [];
  if (frame === undefined) {
    deps.log.info(`[interview] ${answer.statedRules.length} stated rule(s) in ${answer.utteranceId} not promoted: no frame on record for the utterance`);
    return;
  }
  const expertId = sessionExpertId(ctx.sessionId);
  answer.statedRules.forEach((rule, index) => {
    const result = promoteToConfirmedRule({
      ruleId: contentId("rule", canonicalJson({ utteranceId: answer.utteranceId, index })),
      domain: KYC_DOMAIN,
      decisionFamily: input.decisionFamily,
      source: { statedRule: rule },
      priority: STATED_RULE_PRIORITY[rule.kind],
      overrides: [],
      evidence: [
        {
          kind: "expert_quote",
          utteranceId: answer.utteranceId,
          exactQuote: rule.exactQuote,
          t0Ms: rule.t0Ms,
          t1Ms: rule.t1Ms,
          frameIds: [frame, ...frames],
          eventIds: [],
          relation: "supports",
          provenance: "human_voice",
        },
      ],
      confirmation: { expertId, at: ctx.occurredAt, method: "explicit_statement", ledgerEntryId: answer.utteranceId },
      expertId,
      schemaVersion: CASEDESK_SCHEMA_VERSION,
      ledger: deps.ledger,
    });
    if (!result.ok) {
      deps.log.warn(`[interview] stated rule ${index} of ${answer.utteranceId} not promoted: ${result.errors.map((e) => e.code).join(", ")}`);
      return;
    }
    deps.ledger.append(
      entry(ctx, "rule.confirmed", "engine", [input.answerEntryId, answer.utteranceId], RuleConfirmedPayloadSchema.parse({ rule: result.rule })),
    );
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
    deps.ledger.appendMany(conversion.concepts.map((c) => entry(ctx, "concept.proposed", "engine", [input.utterance], c)));
  } catch (error) {
    deps.log.warn(`[interview] concept proposer failed: ${describeError(error)}`);
  }
}
