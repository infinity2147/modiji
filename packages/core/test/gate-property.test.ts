import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_LATENCY_BOUND_MS,
  DEFAULT_GATE_CONFIG as cfg,
  type GateInput,
  type GateMode,
} from "../src/gate/index";
import { runScript } from "../src/gate/simulate";
import { QuestionKindSchema } from "../src/schemas/engine";
import { q } from "./gate-support";

const RUNS = { seed: 20261004, numRuns: 150 };
/** Uniform in [min, max] at 0.001 resolution (fc.double is biased toward edge values). */
const unit = (min: number, max: number) => fc.integer({ min: min * 1000, max: max * 1000 }).map((n) => n / 1000);

const vadScoreArb = fc.oneof(
  { weight: 3, arbitrary: unit(0, 0.3) },
  { weight: 1, arbitrary: unit(0.35, 0.45) },
  { weight: 2, arbitrary: unit(0.3, 1) },
);

type Episode = (t: number, i: number) => GateInput[];

/** A burst of speech: VAD frames above θ (with flicker) from `t`, ending in a quiet frame. */
const speechArb: fc.Arbitrary<Episode> = fc
  .record({ ms: fc.integer({ min: 100, max: 4000 }), dips: fc.array(vadScoreArb, { maxLength: 6 }), tail: vadScoreArb })
  .map(({ ms, dips, tail }) => (t: number) => [
    { kind: "vad", t, value: 0.9 },
    ...dips.map((value, k) => ({ kind: "vad", t: t + Math.round(((k + 1) * ms) / (dips.length + 2)), value }) as const),
    { kind: "vad", t: t + ms, value: Math.min(tail, 0.39) },
  ]);

/** One user/world episode starting at `t`; `i` makes question ids unique. */
const episodeArb: fc.Arbitrary<Episode> = fc.oneof(
  { weight: 4, arbitrary: speechArb },
  { weight: 2, arbitrary: vadScoreArb.map((value): Episode => (t) => [{ kind: "vad", t, value }]) },
  {
    weight: 2,
    arbitrary: fc
      .record({ ms: fc.integer({ min: 100, max: 4000 }), end: fc.constantFrom("user_speaking", "turn_end", "never") })
      .map(({ ms, end }): Episode => (t) => [
        { kind: "user_speaking", t },
        ...(end === "never"
          ? []
          : [
              end === "turn_end"
                ? ({ kind: "turn_end", t: t + ms } as const)
                : ({ kind: "user_speaking", t: t + ms, value: 0 } as const),
            ]),
      ]),
  },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 0, max: 8 }).map(
      (n): Episode =>
        (t) =>
          Array.from({ length: n + 1 }, (_, k) => ({ kind: "typing", t: t + 150 * k }) as const),
    ),
  },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 0, max: 6 }).map(
      (n): Episode =>
        (t) =>
          Array.from({ length: n + 1 }, (_, k) => ({ kind: "screen_motion", t: t + 500 * k }) as const),
    ),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom<"pointer" | "focus_change" | "idle">("pointer", "focus_change", "idle")
      .map((kind): Episode => (t) => [{ kind, t }]),
  },
  { weight: 3, arbitrary: fc.boolean().map((at): Episode => (t) => [{ kind: "breakpoint", t, at }]) },
  {
    weight: 1,
    arbitrary: fc
      .option(fc.integer({ min: 100, max: 8000 }), { nil: null })
      .map((ms): Episode => (t) => [
        { kind: "off_record", t, on: true },
        ...(ms === null ? [] : [{ kind: "off_record", t: t + ms, on: false } as const]),
      ]),
  },
  {
    weight: 6,
    arbitrary: fc
      .option(
        fc.record({
          value: unit(0, 1),
          ephemeral: fc.boolean(),
          kind: fc.constantFrom(...QuestionKindSchema.options),
        }),
        { nil: null, freq: 6 },
      )
      .map((spec): Episode => (t, i) => [{ kind: "queue", t, top: spec && q(`q${i}`, { ...spec, t }) }]),
  },
);

/**
 * Episodes starting 1..4000 ms apart (they may overlap): bursts of activity and quiet stretches.
 * Times are then made strictly increasing, so the order of events is unambiguous.
 */
const scriptArb: fc.Arbitrary<GateInput[]> = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 4000 }), episodeArb), { minLength: 5, maxLength: 60 })
  .map((raw) => {
    let start = 0;
    const events = raw.flatMap(([gap, episode], i) => episode((start += gap), i)).sort((a, b) => a.t - b.t);
    let last = 0;
    return events.map((e) => ({ ...e, t: (last = Math.max(e.t, last + 1)) }));
  });

const simArb = fc.record({ script: scriptArb, jitter: fc.integer({ min: 0, max: 100 }), seed: fc.integer() });

/** Replays the script up to `at` (inputs at `at` included: they were fed before the authorization). */
function worldAt(script: readonly GateInput[], at: number) {
  let offRecord = false;
  let offRecordEnd = -Infinity;
  let atBreakpoint = false;
  let breakpointSince = -Infinity;
  let top: { t: number; ephemeral: boolean; value: number; kind: string } | null = null;
  let vad = false;
  let explicit = false;
  let speechEnd = -Infinity;
  let typing = -Infinity;
  let motion = -Infinity;
  for (const e of script) {
    if (e.t > at) break;
    const wasSpeaking = vad || explicit;
    if (e.kind === "off_record") {
      if (offRecord && !e.on) offRecordEnd = e.t;
      offRecord = e.on;
    } else if (e.kind === "breakpoint") {
      if (!atBreakpoint && e.at) breakpointSince = e.t;
      atBreakpoint = e.at;
    } else if (e.kind === "queue")
      top = e.top && { t: e.t, ephemeral: e.top.ephemeral, value: e.top.value, kind: e.top.kind };
    else if (e.kind === "vad") vad = (e.value ?? 0) >= cfg.vadSpeakingThreshold;
    else if (e.kind === "user_speaking") explicit = e.value !== 0;
    else if (e.kind === "turn_end") explicit = false;
    else if (e.kind === "typing") typing = e.t;
    else if (e.kind === "screen_motion") motion = e.t;
    if (wasSpeaking && !(vad || explicit)) speechEnd = e.t;
  }
  return {
    offRecord,
    offRecordEnd,
    atBreakpoint,
    breakpointSince,
    top,
    speaking: vad || explicit,
    speechEnd,
    typing,
    motion,
  };
}

function simulate(script: GateInput[], jitter: number, seed: number, mode: GateMode = "interviewer") {
  return runScript(script, cfg, { mode, timerJitterMs: jitter, seed, untilMs: (script.at(-1)?.t ?? 0) + 20_000 });
}

describe("gate properties (random interleavings, fixed seed)", () => {
  it("never interrupts, and every authorization meets the conditions when issued (never early)", () => {
    fc.assert(
      fc.property(simArb, ({ script, jitter, seed }) => {
        const { authorizations, interruptions } = simulate(script, jitter, seed);
        expect(interruptions).toBe(0);
        authorizations.forEach((a, i) => {
          const w = worldAt(script, a.at);
          expect(w.offRecord).toBe(false);
          expect(w.top).not.toBeNull();
          expect(w.top!.value).toBeGreaterThanOrEqual(cfg.thetaAsk);
          expect(w.top!.ephemeral || w.atBreakpoint).toBe(true);
          expect(w.speaking).toBe(false);
          expect(a.at - w.speechEnd).toBeGreaterThanOrEqual(cfg.userSilenceMs);
          expect(a.at - w.typing).toBeGreaterThanOrEqual(cfg.typingIdleMs);
          expect(a.at - w.motion).toBeGreaterThanOrEqual(cfg.screenIdleMs);
          const inWindow = authorizations.slice(0, i).filter((b) => a.at - b.at < cfg.liveBudget.windowMs);
          expect(inWindow.length).toBeLessThan(cfg.liveBudget.max);
        });
        expect(new Set(authorizations.map((a) => a.questionId)).size).toBe(authorizations.length);
      }),
      RUNS,
    );
  });

  it(`authorizes within ${AUTHORIZATION_LATENCY_BOUND_MS} ms of the conditions becoming valid, never before`, () => {
    const latencies: number[] = [];
    fc.assert(
      fc.property(simArb, fc.constantFrom<GateMode>("interviewer", "tutor"), ({ script, jitter, seed }, mode) => {
        for (const a of simulate(script, jitter, seed, mode).authorizations) {
          latencies.push(a.latencyMs);
          expect(a.becameValidAt).toBeLessThanOrEqual(a.at);
          expect(a.latencyMs).toBeGreaterThanOrEqual(0);
          expect(a.latencyMs).toBeLessThanOrEqual(Math.min(jitter, AUTHORIZATION_LATENCY_BOUND_MS));
        }
      }),
      RUNS,
    );
    expect(latencies.length).toBeGreaterThan(50);
  });

  it("measures the onset independently: the first authorization's becameValidAt is when the world became valid", () => {
    fc.assert(
      fc.property(simArb, ({ script, jitter, seed }) => {
        const first = simulate(script, jitter, seed).authorizations[0];
        if (!first) return;
        const w = worldAt(script, first.at);
        const onset = Math.max(
          w.offRecordEnd,
          w.top!.t,
          w.top!.ephemeral ? -Infinity : w.breakpointSince,
          w.speechEnd + cfg.userSilenceMs,
          w.typing + cfg.typingIdleMs,
          w.motion + cfg.screenIdleMs,
        );
        expect(first.becameValidAt).toBe(onset);
      }),
      RUNS,
    );
  });

  it("never authorizes anything while off the record, in either mode", () => {
    fc.assert(
      fc.property(simArb, fc.constantFrom<GateMode>("interviewer", "tutor"), ({ script, jitter, seed }, mode) => {
        for (const a of simulate(script, jitter, seed, mode).authorizations)
          expect(worldAt(script, a.at).offRecord).toBe(false);
      }),
      RUNS,
    );
  });
});
