/**
 * HTTP contract for the live interview and tutor voice loop (P3/P4/P6/P7). Browser-safe. The gate runs
 * in the browser (it sees typing, screen motion and VAD first-hand); the server owns the question queue,
 * authorizations, the engine and the ledger, and re-validates everything.
 */
import { z } from "zod";
import {
  GateAuthorizationSchema,
  IdSchema,
  MasteryLevelSchema,
  ParsedAnswerSchema,
  QuestionSchema,
} from "@vashistha/core";

/** GET /api/sessions/:sessionId/questions — pending questions, highest value first. */
export const QuestionQueueResponseSchema = z.strictObject({
  queue: z.array(QuestionSchema),
  contextVersion: z.int().nonnegative(),
  /**
   * Questions already asked in this session, of every kind (live, debrief, tutor). The compliance strip
   * counts the live-interview kinds among them; the gate's live budget is kept by the browser gate itself.
   */
  asked: z.array(z.strictObject({ questionId: IdSchema, authorizedAt: z.int().nonnegative() })),
  offRecord: z.boolean(),
});

/**
 * POST /api/sessions/:sessionId/gate/authorize — the browser gate decided to ask. The server checks the
 * question is still queued for this session at this context version, issues a single-use authorization
 * (4 s TTL) and records `gate.authorized`. The browser then sends `controlMessage` via `sendUserMessage`.
 */
export const GateAuthorizeRequestSchema = z.strictObject({
  questionId: IdSchema,
  contextVersion: z.int().nonnegative(),
  becameValidAt: z.int().nonnegative(),
  decidedAt: z.int().nonnegative(),
  conditions: z.record(z.string(), z.boolean()),
});
export const GateAuthorizeResponseSchema = z.strictObject({
  authorization: GateAuthorizationSchema,
  controlMessage: z.string().min(1),
  text: z.string().min(1),
});
/** 409 reasons for a refused authorization. */
export const GateRefusalSchema = z.enum(["context_changed", "question_not_queued", "off_record", "agent_mismatch"]);

/**
 * POST /api/sessions/:sessionId/utterances — a final expert transcript from ElevenLabs (`onMessage` with
 * role "user"). The browser must never post control messages; the server rejects them anyway (400).
 */
export const PostUtteranceRequestSchema = z.strictObject({
  conversationId: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
  /** Milliseconds since the conversation started (client clock, from onConnect). */
  t0Ms: z.int().nonnegative(),
  t1Ms: z.int().nonnegative(),
  /** The question this utterance answers, if one was just asked. */
  questionId: IdSchema.optional(),
  privacyEpoch: z.int().nonnegative(),
});
export const PostUtteranceResponseSchema = z.strictObject({
  utteranceId: IdSchema,
  /** Present once the answer parser has run (it runs synchronously when a question was pending). */
  parsed: ParsedAnswerSchema.optional(),
});

/** POST /api/sessions/:sessionId/agent-utterances — what the agent said (`onMessage` role "agent"); never evidence. */
export const PostAgentUtteranceRequestSchema = z.strictObject({
  conversationId: z.string().min(1),
  text: z.string().min(1).max(4000),
  questionId: IdSchema.optional(),
});

/**
 * POST /api/sessions/:sessionId/off-record — plan §7.8. Going off record advances the privacy epoch and
 * the context version (so any in-flight authorization is refused); resuming advances the epoch again.
 */
export const OffRecordRequestSchema = z.strictObject({ offRecord: z.boolean() });
export const OffRecordResponseSchema = z.strictObject({
  offRecord: z.boolean(),
  privacyEpoch: z.int().nonnegative(),
  contextVersion: z.int().nonnegative(),
});

/** GET /api/sessions/:sessionId/engine — what the engine believes (judge HUD reason line, engineering view). */
export const EngineStateResponseSchema = z.strictObject({
  families: z.array(
    z.strictObject({
      decisionFamily: z.string(),
      observations: z.int().nonnegative(),
      top: z.array(z.strictObject({ candidateId: IdSchema, description: z.string(), weight: z.number() })),
      lastSurpriseBits: z.number().nonnegative().nullable(),
    }),
  ),
  undefinedConcepts: z.array(z.strictObject({ name: z.string(), label: z.string() })),
  confirmedRules: z.int().nonnegative(),
  rulebookRevision: z.int().nonnegative(),
  mastery: z.array(z.strictObject({ ruleId: IdSchema, level: MasteryLevelSchema })),
  /**
   * The answer parser (Sonnet): `available` is false when the server has no model (no ANTHROPIC_API_KEY,
   * or LLM_CALLS=off); `unparsedAnswers` counts expert answers to asked questions that have no
   * `answer.parsed` entry (recorded while no parser was available, or the parser failed) — they are
   * never guessed.
   */
  answerParser: z.strictObject({ available: z.boolean(), unparsedAnswers: z.int().nonnegative() }),
});
