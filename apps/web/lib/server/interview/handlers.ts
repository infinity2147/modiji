/**
 * HTTP handlers of the interview / tutor voice loop (contract: lib/contracts/interview.ts). The browser
 * gate decides when to ask; the server re-validates everything: the question must be queued at the
 * session's current context version, the session on the record, the agent the session's own. Expert
 * speech is evidence (`voice`); control messages never are, and are refused as utterances outright.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  DEFAULT_GATE_CONFIG,
  formatControlMessage,
  parseControlMessage,
  type AgentRole,
  type QuestionKind,
} from "@vashistha/core";
import {
  GateAuthorizeRequestSchema,
  OffRecordRequestSchema,
  PostAgentUtteranceRequestSchema,
  PostUtteranceRequestSchema,
  type EngineStateResponseSchema,
  type GateAuthorizeResponseSchema,
  type GateRefusalSchema,
  type OffRecordResponseSchema,
  type QuestionQueueResponseSchema,
} from "../../contracts/interview";
import type { SessionMode } from "../../contracts/casedesk";
import { ApiFailure, NO_STORE, json, readJson, respond } from "../casedesk/http";
import { loadSession, requireNotArchived, requireOnRecord, type LoadedSession } from "../casedesk/session";
import { askedQuestions, engineState, engineStateResponse, queuedQuestions } from "./engine-state";
import { entry } from "./ledger";
import { closeAnswer, recordUtterance, requeueLapsed, type InterviewDeps } from "./orchestrator";

/** Every control message starts with this token (plan §7.2); no utterance may contain it. */
const CONTROL_TOKEN_PREFIX = "⟦ctl:";

/** The agent that speaks in a session of each mode. */
const AGENT_FOR_MODE: Record<SessionMode, AgentRole> = { expert: "interviewer", novice: "tutor" };

/** The question kinds each agent may ask. */
const AGENT_QUESTION_KINDS: Record<AgentRole, ReadonlySet<QuestionKind>> = {
  interviewer: new Set(["why_probe", "counterfactual", "concept_definition", "witness", "teach_back"]),
  tutor: new Set(["prediction", "intervention"]),
};

function refuse(reason: z.infer<typeof GateRefusalSchema>, detail: string): ApiFailure {
  return new ApiFailure(409, reason, detail);
}

function load(deps: InterviewDeps, sessionId: string): LoadedSession {
  return loadSession({ ledger: deps.ledger, store: deps.casedesk }, sessionId);
}

function requireNoControlText(text: string): void {
  if (parseControlMessage(text) !== null || text.includes(CONTROL_TOKEN_PREFIX))
    throw new ApiFailure(400, "control_message", "control messages are never recorded as utterances");
}

/**
 * `GET /api/sessions/:sessionId/questions`: live questions are valid at the current context version
 * (questions.ts). Questions whose authorization expired unspoken are re-queued first (the browser gate
 * polls this every second, so a lost question is back in its queue within about a second of lapsing).
 * An archived session is read-only: its queue is empty (nothing in it can be authorized), while what
 * was asked stays readable.
 */
export function handleQuestionQueue(sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, () => {
    const { session } = load(deps, sessionId);
    requeueLapsed(deps);
    const state = engineState(deps, session.id);
    const contextVersion = deps.authorizations.getContextVersion(session.id);
    const body: z.infer<typeof QuestionQueueResponseSchema> = {
      queue: session.archived ? [] : queuedQuestions(state).map((r) => ({ ...r.question, contextVersion })),
      contextVersion,
      asked: askedQuestions(state).flatMap((r) => (r.asked ? [{ questionId: r.question.id, authorizedAt: r.asked.at }] : [])),
      offRecord: session.offRecord,
    };
    return json(body);
  });
}

/**
 * `POST /api/sessions/:sessionId/gate/authorize`. Synchronous from the checks to the nonce, so nothing
 * can change the context in between; `gate.authorized` is written before the nonce exists (no
 * unrecorded authorization). Refused while the session still has an outstanding authorization
 * (`authorization_pending`: never two control messages racing, live bug #2). A new authorization
 * closes the expert's open answer: the gate only asks once that answer has ended.
 */
export function handleGateAuthorize(request: Request, sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, GateAuthorizeRequestSchema);
    if (body.decidedAt < body.becameValidAt) throw new ApiFailure(400, "invalid_request", "decidedAt is before becameValidAt");
    const { session, info } = load(deps, sessionId);
    requireNotArchived(session);
    if (session.offRecord) throw refuse("off_record", "the session is off the record");
    const contextVersion = deps.authorizations.getContextVersion(session.id);
    if (body.contextVersion !== contextVersion)
      throw refuse("context_changed", `context version ${body.contextVersion} is stale (current ${contextVersion})`);
    requeueLapsed(deps);
    const pending = deps.authorizations.pending(session.id, deps.now());
    if (pending !== undefined)
      throw refuse("authorization_pending", `the authorization for ${pending.questionId} is outstanding until ${new Date(pending.expiresAt).toISOString()}`);
    const record = engineState(deps, session.id).questions.get(body.questionId);
    if (record?.status !== "queued") throw refuse("question_not_queued", `question ${body.questionId} is not queued`);
    const agent = AGENT_FOR_MODE[info.mode];
    if (!AGENT_QUESTION_KINDS[agent].has(record.question.kind))
      throw refuse("agent_mismatch", `the ${agent} does not ask ${record.question.kind} questions`);

    deps.ledger.append(
      entry(
        { sessionId: session.id, occurredAt: deps.now(), traceId: randomUUID(), privacyEpoch: session.privacyEpoch },
        "gate.authorized",
        "engine",
        [record.queuedEntryId],
        {
          questionId: record.question.id,
          contextVersion,
          becameValidAt: body.becameValidAt,
          decidedAt: body.decidedAt,
          conditions: body.conditions,
        },
      ),
    );
    const authorization = deps.authorizations.issue({
      sessionId: session.id,
      agent,
      questionId: record.question.id,
      text: record.question.text,
      contextVersion,
      ttlMs: DEFAULT_GATE_CONFIG.authorizationTtlMs,
    });
    void closeAnswer(deps, session.id);
    const response: z.infer<typeof GateAuthorizeResponseSchema> = {
      authorization,
      controlMessage: formatControlMessage(authorization.nonce),
      text: record.question.text,
    };
    return json(response);
  });
}

/** `POST /api/sessions/:sessionId/utterances`: 400 for control text, 409 off record or for a stale privacy epoch. */
export function handlePostUtterance(request: Request, sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, PostUtteranceRequestSchema);
    requireNoControlText(body.text);
    if (body.t1Ms < body.t0Ms) throw new ApiFailure(400, "invalid_request", "t1Ms is before t0Ms");
    const { session } = load(deps, sessionId);
    requireOnRecord(session);
    if (body.privacyEpoch !== session.privacyEpoch)
      throw new ApiFailure(409, "stale_epoch", `privacy epoch ${body.privacyEpoch} is stale (current ${session.privacyEpoch})`);
    return json(await recordUtterance(deps, session.id, body));
  });
}

/**
 * `POST /api/sessions/:sessionId/agent-utterances`: what the agent said, recorded by the engine (never
 * evidence of the expert). The agent's turn closes the expert's open answer (it is then parsed).
 */
export function handlePostAgentUtterance(request: Request, sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, PostAgentUtteranceRequestSchema);
    requireNoControlText(body.text);
    const { session } = load(deps, sessionId);
    requireOnRecord(session);
    const asked = body.questionId === undefined ? undefined : engineState(deps, session.id).questions.get(body.questionId)?.asked;
    if (body.questionId !== undefined && asked === undefined)
      throw new ApiFailure(409, "question_not_asked", `question ${body.questionId} was not asked in this session`);
    deps.ledger.append(
      entry(
        { sessionId: session.id, occurredAt: deps.now(), traceId: randomUUID(), privacyEpoch: session.privacyEpoch },
        "agent.utterance",
        "engine",
        asked ? [asked.entryId] : [],
        { conversationId: body.conversationId, text: body.text, ...(body.questionId !== undefined && { questionId: body.questionId }) },
      ),
    );
    void closeAnswer(deps, session.id);
    return new Response(null, { status: 204, headers: NO_STORE });
  });
}

/**
 * `POST /api/sessions/:sessionId/off-record` (plan §7.8). A transition advances the privacy epoch (the
 * ledger then refuses capture stamped with the old one) and the context version (the nonce store then
 * refuses any in-flight authorization). Idempotent: asking for the current state changes nothing.
 */
export function handleOffRecord(request: Request, sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { offRecord } = await readJson(request, OffRecordRequestSchema);
    const { session } = load(deps, sessionId);
    requireNotArchived(session);
    if (session.offRecord !== offRecord) {
      deps.ledger.setOffRecord(session.id, offRecord, { occurredAt: deps.now(), traceId: randomUUID() });
      deps.authorizations.bumpContextVersion(session.id);
    }
    const current = load(deps, sessionId).session;
    const body: z.infer<typeof OffRecordResponseSchema> = {
      offRecord: current.offRecord,
      privacyEpoch: current.privacyEpoch,
      contextVersion: deps.authorizations.getContextVersion(session.id),
    };
    return json(body);
  });
}

/** `GET /api/sessions/:sessionId/engine`. */
export function handleEngineState(sessionId: string, deps: InterviewDeps): Promise<Response> {
  return respond(deps.log, () => {
    const { session } = load(deps, sessionId);
    const body: z.infer<typeof EngineStateResponseSchema> = engineStateResponse(engineState(deps, session.id), { available: deps.claude !== null });
    return json(body);
  });
}
