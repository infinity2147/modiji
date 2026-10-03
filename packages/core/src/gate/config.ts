import { z } from "zod";

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
    .strictObject({ max: z.int().positive().default(5), windowMs: z.int().positive().default(600_000) })
    .prefault({}),
  authorizationTtlMs: z.int().positive().default(4000),
  answerWindowMs: ms.default(5000),
  tickMs: z.int().positive().max(50).default(50),
});
export type GateConfig = z.output<typeof GateConfigSchema>;
export type GateConfigInput = z.input<typeof GateConfigSchema>;

export const DEFAULT_GATE_CONFIG: GateConfig = GateConfigSchema.parse({});

/** Positive responsiveness bound (plan §7.2): authorize within this long of conditions becoming valid. */
export const AUTHORIZATION_LATENCY_BOUND_MS = 250;
