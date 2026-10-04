import { z } from "zod";
import { LIVE_QUESTION_KINDS, QuestionKindSchema } from "../schemas/engine";

const ms = z.int().nonnegative();

/**
 * Deterministic speech gate thresholds (plan §7.2). Every default is the plan's unless noted.
 *
 * - `vadSpeakingThreshold` 0.4: ElevenLabs `onVadScore` is a 0..1 speech probability (api-notes §1.6).
 *   Silero-style VADs default to 0.5 to enter speech and ~0.35 to leave it. A missed quiet word costs
 *   an interruption while a noise blip only delays a question by `userSilenceMs`, so we sit below 0.5,
 *   inside the "still speaking" band. Calibrate against live scores once credentials exist.
 * - `thetaAsk` 0.3 bits: a yes/no question whose likelier answer we already predict at ≥ 95% carries
 *   less (H(0.05) ≈ 0.29 bits); such a question is not worth interrupting an expert for.
 * - `answerWindowMs` (not in the plan): after any agent turn the floor belongs to the expert. The gate
 *   waits until they have answered and then been silent for `userSilenceMs`, or until this window has
 *   passed with no answer. Without it the next question could fire 1.2 s after the previous one ends,
 *   while the expert is still thinking about their answer.
 * - `liveBudget` (5 per 10 min) caps live interview questions only (`kinds`, default
 *   `LIVE_QUESTION_KINDS`): a question of another kind neither spends the budget nor waits for it.
 * - `answerSilenceMs` (not in the plan; live run B): once the expert has started answering the agent's
 *   question, the silence that ends the answer. Experts pause mid-answer ("Well, let me think." … 3.5 s
 *   … the actual answer); at 1.2 s the next question landed in those pauses and the expert resumed over
 *   it. Talk after an answer has ended (a gap of at least this long) is ordinary speech again.
 * - `transcriptWaitMs` (not in the plan; live bug #1): any detected speech opens a user turn at the voice
 *   provider, and a control message sent into an open turn is merged with the expert's words and never
 *   spoken. The gate waits for the provider's final transcript of that turn (`user_transcript`), or this
 *   long after the speech ended when none comes (a cough or a key click that the local detector heard
 *   but the provider never transcribed). Live finals arrived 0.4–1.0 s after speech ended, a few at 2.6 s.
 * - `authorizationGraceMs`: an issued authorization holds the floor for its TTL plus this grace, which
 *   covers the agent's first audio for a nonce consumed just before it expired (first audio ≈ 0.7 s
 *   after the control message, live p95 0.85 s). An authorization still unspoken by then has lapsed: the
 *   gate releases the floor and its live-budget slot (the server re-queues the question).
 * - `coachSilenceMs` (not in the plan; tutor mode): the trainee's voice coach answers a trainee who has
 *   finished speaking, so a `coach_turn` waits only this long after their speech (end of utterance plus a
 *   short silence), not the expert interview's `userSilenceMs`/`answerSilenceMs`. Typing and screen motion
 *   do not hold a coach turn back (a trainee works while they talk to their coach), and the live budget,
 *   breakpoints and θ_ask do not apply to it (see `requiredConditions`).
 * - `coachAnswerWindowMs` (not in the plan; tutor mode): after the coach's own turn, how long a coach turn
 *   waits for the trainee to answer before the coach speaks again (the interviewer's `answerWindowMs` is
 *   meant for an expert thinking about a hard question).
 * - `tickMs` ≤ 50: the controller wakes exactly when conditions can become valid and also ticks at
 *   this period as a fallback for late or early timers, keeping authorization ≤ 250 ms with margin.
 */
export const GateConfigSchema = z.strictObject({
  userSilenceMs: ms.default(1200),
  screenIdleMs: ms.default(1500),
  typingIdleMs: ms.default(1500),
  vadSpeakingThreshold: z.number().gt(0).lt(1).default(0.4),
  thetaAsk: z.number().nonnegative().default(0.3),
  liveBudget: z
    .strictObject({
      max: z.int().positive().default(5),
      windowMs: z.int().positive().default(600_000),
      kinds: z.array(QuestionKindSchema).default(() => [...LIVE_QUESTION_KINDS]),
    })
    .prefault({}),
  authorizationTtlMs: z.int().positive().default(4000),
  authorizationGraceMs: ms.default(1500),
  answerWindowMs: ms.default(5000),
  answerSilenceMs: ms.default(4000),
  transcriptWaitMs: ms.default(3000),
  coachSilenceMs: ms.default(700),
  coachAnswerWindowMs: ms.default(2000),
  tickMs: z.int().positive().max(50).default(50),
});
export type GateConfig = z.output<typeof GateConfigSchema>;
export type GateConfigInput = z.input<typeof GateConfigSchema>;

export const DEFAULT_GATE_CONFIG: GateConfig = GateConfigSchema.parse({});

/** Positive responsiveness bound (plan §7.2): authorize within this long of conditions becoming valid. */
export const AUTHORIZATION_LATENCY_BOUND_MS = 250;
