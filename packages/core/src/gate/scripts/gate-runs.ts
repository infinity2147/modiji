/**
 * The five scripted P3 acceptance runs (plan §11) in simulation form: realistic typing/talking/screen
 * patterns fed to the real gate controller by `runScript`. Live voice versions follow once credentials
 * exist. Times are ms from session start; VAD frames arrive every 100 ms, screen changes at most every
 * 500 ms (the perception sampling period, plan §7.1).
 */
import type { QuestionKind } from "../../schemas/engine";
import { mulberry32 } from "../simulate";
import type { GateInput } from "../state";

export type GateRun = {
  name: string;
  description: string;
  inputs: GateInput[];
  untilMs: number;
  /** How many questions a correct gate asks in this run (guards against a gate that never speaks). */
  expectedAuthorizations: number;
};

const VAD_FRAME_MS = 100;
const SESSION = "sim-session";

type Span = readonly [from: number, to: number];

function question(
  t: number,
  id: string,
  q: { value: number; reason: string; text: string; ephemeral?: boolean; kind?: QuestionKind },
): GateInput {
  return {
    kind: "queue",
    t,
    top: {
      id,
      sessionId: SESSION,
      kind: q.kind ?? "counterfactual",
      text: q.text,
      target: { candidateIds: [] },
      value: q.value,
      reason: q.reason,
      ephemeral: q.ephemeral ?? false,
      createdAt: t,
      contextVersion: 0,
      parentIds: [],
    },
  };
}

/**
 * A continuous VAD stream over [from, to): `score(t, inSpeech)` per frame, speech inside `speech` spans.
 * The default scores: speech 0.70–0.95, a quiet room 0.02–0.17.
 */
function vadStream(
  from: number,
  to: number,
  speech: readonly Span[],
  rand: () => number,
  score: (inSpeech: boolean, t: number) => number = (inSpeech) =>
    inSpeech ? 0.7 + 0.25 * rand() : 0.02 + 0.15 * rand(),
): GateInput[] {
  const frames: GateInput[] = [];
  for (let t = from; t < to; t += VAD_FRAME_MS) {
    const inSpeech = speech.some(([a, b]) => t >= a && t < b);
    frames.push({ kind: "vad", t, value: Number(score(inSpeech, t).toFixed(3)) });
  }
  return frames;
}

/** Irregular keystrokes (80–300 ms apart) inside each span. */
function keystrokes(spans: readonly Span[], rand: () => number): GateInput[] {
  const keys: GateInput[] = [];
  for (const [from, to] of spans)
    for (let t = from; t < to; t += 80 + Math.round(220 * rand())) keys.push({ kind: "typing", t });
  return keys;
}

/** Screen changes every 500 ms inside each span (a click or scroll lands in at least one frame). */
function screenMotion(spans: readonly Span[]): GateInput[] {
  const frames: GateInput[] = [];
  for (const [from, to] of spans) for (let t = from; t <= to; t += 500) frames.push({ kind: "screen_motion", t });
  return frames;
}

function expertTypesWhileTalking(): GateRun {
  const rand = mulberry32(101);
  return {
    name: "expert types a note while talking",
    description:
      "Case opened (breakpoint). The expert explains the risk rating aloud while typing a case note; speech pauses " +
      "(0.6 s) and typing pauses (0.8 s) never line up for long enough. Ask once both have been idle; a second, " +
      "ephemeral question waits for the expert's answer to finish.",
    inputs: [
      { kind: "breakpoint", t: 0, at: true },
      question(3000, "q-note-1", {
        value: 0.61,
        reason: "contradiction detected",
        text: "You rated this one high but approved the last 35% owner case. What made this one different?",
      }),
      question(22_000, "q-note-2", {
        value: 0.45,
        ephemeral: true,
        reason: "boundary case at 25%",
        text: "Would 24% ownership change your answer?",
      }),
      ...vadStream(
        0,
        40_000,
        [
          [1000, 6200],
          [6800, 9500],
          [11_000, 12_000],
          [21_000, 25_000],
        ],
        rand,
      ),
      ...keystrokes(
        [
          [5000, 9600],
          [10_400, 13_000],
        ],
        rand,
      ),
    ],
    untilMs: 45_000,
    expectedAuthorizations: 2,
  };
}

function longPauseThenResume(): GateRun {
  const rand = mulberry32(202);
  return {
    name: "long pause, then the expert resumes mid-question",
    description:
      "The expert thinks aloud with 1.0 s and 1.15 s hesitations (no ask), then pauses for real: the gate asks " +
      "1.2 s later. The expert resumes talking 0.4 s after the authorization, over the agent; the gate holds the " +
      "next question until that turn and the expert's answer are over.",
    inputs: [
      { kind: "breakpoint", t: 500, at: true },
      question(2000, "q-pause-1", {
        value: 0.72,
        reason: "surprising decision · 2 rules disagree",
        text: "You escalated although the score was low. Was it the shell-company address?",
      }),
      question(15_000, "q-pause-2", {
        value: 0.5,
        ephemeral: true,
        reason: "undefined concept: shell-company address",
        text: "What makes an address a shell-company address for you?",
      }),
      ...vadStream(
        0,
        30_000,
        [
          [1000, 4000],
          [5000, 8000],
          [9150, 12_000],
          [13_600, 17_000],
          [20_000, 23_000],
        ],
        rand,
      ),
    ],
    untilMs: 35_000,
    expectedAuthorizations: 2,
  };
}

function rapidScreenNavigation(): GateRun {
  const rand = mulberry32(303);
  const bursts: Span[] = [];
  // Clicks 0.7–1.4 s apart: every still window is shorter than screenIdleMs.
  for (let t = 1000; t < 16_000; t += 700 + Math.round(700 * rand())) bursts.push([t, t]);
  return {
    name: "rapid screen navigation",
    description:
      "The expert clicks through the case's tabs and scrolls the ownership table; still windows of up to 1.4 s never " +
      "reach the 1.5 s idle threshold. The ephemeral question is asked once the screen settles; a later burst of " +
      "scrolling holds the next one.",
    inputs: [
      question(1200, "q-nav-1", {
        value: 0.55,
        ephemeral: true,
        reason: "critical field read: beneficial owner 35%",
        text: "You opened the ownership tab first. Is that always your first check?",
      }),
      question(26_000, "q-nav-2", {
        value: 0.4,
        ephemeral: true,
        reason: "new field visited: registry extract",
        text: "Why the registry extract here?",
      }),
      ...screenMotion([...bursts, [25_000, 30_000]]),
      ...vadStream(0, 35_000, [], rand),
    ],
    untilMs: 40_000,
    expectedAuthorizations: 2,
  };
}

function vadFlicker(): GateRun {
  const rand = mulberry32(404);
  // HVAC hum around θ = 0.4: scores 0.25–0.38, crossing it every 0.4–1.1 s until 20 s.
  const crossings = new Set<number>();
  for (let t = 0; t < 20_000; t += 400 + VAD_FRAME_MS * Math.round(7 * rand())) crossings.add(t);
  const noise = (inSpeech: boolean, t: number): number => {
    if (t < 20_000) return crossings.has(t) ? 0.41 + 0.09 * rand() : 0.25 + 0.13 * rand();
    if (inSpeech) return rand() < 0.1 ? 0.3 : 0.6 + 0.3 * rand(); // speech with single-frame dips below θ
    return 0.05 + 0.1 * rand();
  };
  return {
    name: "VAD flicker around the threshold",
    description:
      "A noisy room keeps VAD scores at 0.25–0.5, crossing θ = 0.4 every few hundred ms: each crossing counts as " +
      "speech, so the gate waits for 1.2 s of clean silence. Later the expert answers with speech whose VAD dips " +
      "below θ for single frames; the gate never asks inside a dip.",
    inputs: [
      { kind: "breakpoint", t: 0, at: true },
      question(500, "q-vad-1", {
        value: 0.8,
        reason: "contradiction detected",
        text: "Two of your decisions disagree on 30% owners. Which one is right?",
      }),
      question(30_000, "q-vad-2", {
        value: 0.6,
        ephemeral: true,
        reason: "boundary case at 30%",
        text: "And exactly 30%?",
      }),
      ...vadStream(0, 50_000, [[29_000, 38_000]], rand, noise),
    ],
    untilMs: 55_000,
    expectedAuthorizations: 2,
  };
}

function budgetExhaustion(): GateRun {
  const rand = mulberry32(505);
  const inputs: GateInput[] = [];
  const speech: Span[] = [];
  const typing: Span[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t = 1000 + i * 60_000;
    inputs.push(
      question(t, `q-budget-${i + 1}`, {
        value: 0.5,
        ephemeral: true,
        reason: "high-value probe",
        text: `Probe ${i + 1}: why that?`,
      }),
    );
    speech.push([t + 6000, t + 9000]);
    typing.push([t + 10_000, t + 20_000]);
  }
  inputs.push(
    question(300_000, "q-budget-6", {
      value: 0.9,
      ephemeral: true,
      reason: "contradiction detected",
      text: "Probe 6: which rule wins?",
    }),
    question(615_000, "q-budget-7", {
      value: 0.7,
      ephemeral: true,
      reason: "boundary case",
      text: "Probe 7: and at the boundary?",
    }),
  );
  return {
    name: "live budget exhaustion",
    description:
      "Seven high-value ephemeral questions in eleven minutes against a budget of 5 per 10 min. Five are asked in " +
      "the first five minutes; the sixth waits (Budget wait) until the first slot slides out of the window at " +
      "601 s, the seventh until the second does at 661 s.",
    inputs: [...inputs, ...vadStream(0, 700_000, speech, rand), ...keystrokes(typing, rand)],
    untilMs: 700_000,
    expectedAuthorizations: 7,
  };
}

export const GATE_RUNS: readonly GateRun[] = [
  expertTypesWhileTalking(),
  longPauseThenResume(),
  rapidScreenNavigation(),
  vadFlicker(),
  budgetExhaustion(),
];
