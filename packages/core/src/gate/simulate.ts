import type { Question } from "../schemas/engine";
import type { GateAuthorization } from "../schemas/gate";
import { GateConfigSchema, type GateConfig, type GateConfigInput } from "./config";
import { createGateController, type GateClock } from "./controller";
import type { GateMode } from "./evaluate";
import type { GateInput } from "./state";

/** Deterministic 32-bit PRNG (mulberry32), uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SimOptions = {
  mode?: GateMode;
  /** Simulate until this time (default: last input + 15 s). */
  untilMs?: number;
  /** Each gate timer fires late by a seeded random 0..timerJitterMs (real timers are never exact). */
  timerJitterMs?: number;
  seed?: number;
  /** The simulated agent: first audio this long after the control message, then speaks the question. */
  agent?: { firstAudioMs: number; wordsPerSecond: number };
  /** The issuer's round trip (`gate/authorize`): the authorization arrives this long after the decision. */
  issueLatencyMs?: number;
  /**
   * Ground truth: when the expert actually spoke, whatever the gate's sensors made of it (a quiet word
   * the VAD scored 0.000 is still speech). A decision inside [start, end + userSilenceMs) interrupts.
   */
  speech?: readonly (readonly [from: number, to: number])[];
};

export type SimAuthorization = {
  questionId: string;
  /** When the gate decided. */
  at: number;
  becameValidAt: number;
  /** Decision latency, `at − becameValidAt` (the plan's 250 ms bound; the issuer's round trip is `sentAt − at`). */
  latencyMs: number;
  /** When the control message went out (the authorization arrived). */
  sentAt: number;
  /** Decided while the user spoke, typed or moved the screen within the gate's thresholds (see `isInterruption`). */
  interruption: boolean;
};

export type LatencySummary = { p50: number; p95: number; max: number };

export type SimResult = {
  authorizations: SimAuthorization[];
  interruptions: number;
  latency: LatencySummary | null;
  /** Authorizations that arrived after the expert resumed and were not sent. */
  withdrawn: number;
};

const DEFAULT_AGENT = { firstAudioMs: 700, wordsPerSecond: 2.5 };

/** Nearest-rank percentiles. */
function summarizeLatency(samples: readonly number[]): LatencySummary | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
  return { p50: rank(0.5), p95: rank(0.95), max: rank(1) };
}

/**
 * Ground truth for "interruption", independent of the gate's own state: the expert was speaking at
 * `at` or stopped less than `userSilenceMs` before it — per the ground-truth `speech` spans when given,
 * and per every speech signal the gate received (speech lasts until the first silent observation) —
 * or typed within `typingIdleMs`, or the screen moved within `screenIdleMs`.
 */
function isInterruption(
  received: readonly GateInput[],
  at: number,
  cfg: GateConfig,
  speech: readonly (readonly [number, number])[],
): boolean {
  if (speech.some(([from, to]) => at >= from && at < to + cfg.userSilenceMs)) return true;
  let vad = false;
  let explicit = false;
  let local = false;
  let speechEnd = Number.NEGATIVE_INFINITY;
  let typing = Number.NEGATIVE_INFINITY;
  let motion = Number.NEGATIVE_INFINITY;
  for (const input of received) {
    const wasSpeaking = vad || explicit || local;
    if (input.kind === "vad") vad = (input.value ?? 0) >= cfg.vadSpeakingThreshold;
    else if (input.kind === "user_speaking") explicit = input.value !== 0;
    else if (input.kind === "local_speech") local = input.value !== 0;
    else if (input.kind === "turn_end") explicit = false;
    else if (input.kind === "typing") typing = Math.max(typing, input.t);
    else if (input.kind === "screen_motion") motion = Math.max(motion, input.t);
    if (wasSpeaking && !(vad || explicit || local)) speechEnd = Math.max(speechEnd, input.t);
  }
  return (
    vad ||
    explicit ||
    local ||
    at - speechEnd < cfg.userSilenceMs ||
    at - typing < cfg.typingIdleMs ||
    at - motion < cfg.screenIdleMs
  );
}

/** Lets settled authorizations (promise reactions) run before the next simulated event. */
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

/**
 * Deterministic simulation: drives a real gate controller with a fake clock through a timed script,
 * with a simulated issuer (round trip `issueLatencyMs`) and a simulated agent that speaks each sent
 * question. Inputs at the same instant as a timer are delivered first. Tutor interventions are never
 * counted as interruptions (plan §7.4).
 */
export async function runScript(
  script: readonly GateInput[],
  cfgInput: GateConfigInput = {},
  opts: SimOptions = {},
): Promise<SimResult> {
  const cfg = GateConfigSchema.parse(cfgInput);
  const mode = opts.mode ?? "interviewer";
  const agent = opts.agent ?? DEFAULT_AGENT;
  const issueLatencyMs = opts.issueLatencyMs ?? 0;
  const jitter = mulberry32(opts.seed ?? 1);
  const inputs = [...script].sort((a, b) => a.t - b.t);
  const until = opts.untilMs ?? (inputs.at(-1)?.t ?? 0) + 15_000;

  type Timer = { at: number; seq: number; fn: () => void; live: boolean };
  let timers: Timer[] = [];
  let seq = 0;
  let now = inputs[0]?.t ?? 0;
  let fed = 0;
  const schedule = (at: number, fn: () => void): Timer => {
    const timer = { at, seq: seq++, fn, live: true };
    timers.push(timer);
    return timer;
  };
  const clock: GateClock = {
    now: () => now,
    setTimer: (fn, delayMs) => {
      const timer = schedule(now + delayMs + Math.round(jitter() * (opts.timerJitterMs ?? 0)), fn);
      return () => {
        timer.live = false;
      };
    },
  };

  const authorizations: SimAuthorization[] = [];
  let withdrawn = 0;
  let nonces = 0;
  const authorization = (q: Question): GateAuthorization => ({
    sessionId: q.sessionId,
    questionId: q.id,
    nonce: `sim-nonce-${String(++nonces).padStart(12, "0")}`,
    expiresAt: now + cfg.authorizationTtlMs,
    contextVersion: q.contextVersion,
  });
  const controller = createGateController({
    cfg,
    mode,
    clock,
    issue: (q) =>
      issueLatencyMs === 0
        ? authorization(q)
        : new Promise<GateAuthorization>((resolve) => schedule(now + issueLatencyMs, () => resolve(authorization(q)))),
    onAuthorize: (_auth, question, sample) => {
      const polite = !(mode === "tutor" && question.kind === "intervention");
      authorizations.push({
        questionId: question.id,
        at: sample.decidedAt,
        becameValidAt: sample.becameValidAt,
        latencyMs: sample.decidedAt - sample.becameValidAt,
        sentAt: sample.authorizedAt,
        interruption: polite && isInterruption(inputs.slice(0, fed), sample.decidedAt, cfg, opts.speech ?? []),
      });
      const start = sample.authorizedAt + agent.firstAudioMs;
      const end = start + Math.round((question.text.split(/\s+/).length / agent.wordsPerSecond) * 1000);
      schedule(start, () => controller.feed({ kind: "agent_speaking", t: start, value: 1 }));
      schedule(end, () => controller.feed({ kind: "agent_speaking", t: end, value: 0 }));
      return true;
    },
    onWithdraw: () => {
      withdrawn += 1;
    },
    onHudUpdate: () => {},
  });

  for (;;) {
    await flush();
    timers = timers.filter((t) => t.live);
    const timer = timers.reduce<Timer | undefined>(
      (min, t) => (!min || t.at < min.at || (t.at === min.at && t.seq < min.seq) ? t : min),
      undefined,
    );
    const input = inputs[fed];
    if (input && input.t <= until && (!timer || input.t <= timer.at)) {
      now = Math.max(now, input.t);
      fed += 1;
      controller.feed(input);
    } else if (timer && timer.at <= until) {
      now = Math.max(now, timer.at);
      timer.live = false;
      timer.fn();
    } else break;
  }
  controller.dispose();

  return {
    authorizations,
    interruptions: authorizations.filter((a) => a.interruption).length,
    latency: summarizeLatency(authorizations.map((a) => a.latencyMs)),
    withdrawn,
  };
}
