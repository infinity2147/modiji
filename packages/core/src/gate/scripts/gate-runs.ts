/**
 * The scripted P3 acceptance runs (plan §11) in simulation form: realistic typing/talking/screen
 * patterns fed to the real gate controller by `runScript`, plus a reproduction of live run D (the run
 * that interrupted). Times are ms from session start. Every run feeds what production feeds: provider
 * VAD frames every 100 ms, the provider's final transcript 0.4–1.0 s after each utterance, the
 * browser's own microphone-level detector (`local_speech`, from the real detector over 20 ms level
 * frames), keystrokes, and screen changes at most every 500 ms (the perception sampling period,
 * plan §7.1). `speech` is the ground truth the interruption check uses.
 */
import type { QuestionKind } from "../../schemas/engine";
import { detectLocalSpeech, type LevelFrame } from "../../voice/local-speech";
import { mulberry32 } from "../simulate";
import type { GateInput } from "../state";

export type GateRun = {
  name: string;
  description: string;
  inputs: GateInput[];
  /** Ground truth: when the expert actually spoke. */
  speech: Span[];
  untilMs: number;
  /** How many questions a correct gate asks in this run (guards against a gate that never speaks). */
  expectedAuthorizations: number;
};

const VAD_FRAME_MS = 100;
const LEVEL_FRAME_MS = 20;
const SESSION = "sim-session";

export type Span = readonly [from: number, to: number];

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

/** The provider's final transcript of each utterance, 0.4–1.0 s after it ends (live runs: p50 ≈ 0.55 s). */
function finals(spans: readonly Span[], rand: () => number): GateInput[] {
  return spans.map(([, to]) => ({ kind: "user_transcript", t: to + 400 + Math.round(600 * rand()) }));
}

/**
 * The browser microphone over [from, to): a room at `floorDb` (±0.8 dB) and each utterance `snrDb`
 * above it with syllable-rate modulation (±3 dB at 4 Hz), sampled every 20 ms through the Web Audio
 * analyser's smoothing (time constant 0.8 per read), then through the real local-speech detector.
 */
function localSpeech(
  from: number,
  to: number,
  utterances: readonly { span: Span; snrDb: number }[],
  rand: () => number,
  floorDb = -60,
): GateInput[] {
  const frames: LevelFrame[] = [];
  let smoothed = 10 ** (floorDb / 20);
  for (let t = from; t < to; t += LEVEL_FRAME_MS) {
    let amplitude = 10 ** ((floorDb + 1.6 * (rand() - 0.5)) / 20);
    for (const { span, snrDb } of utterances)
      if (t >= span[0] && t < span[1]) amplitude += 10 ** ((floorDb + snrDb + 3 * Math.sin((2 * Math.PI * 4 * (t - span[0])) / 1000)) / 20);
    smoothed = 0.8 * smoothed + 0.2 * amplitude;
    frames.push({ t, levelDb: 20 * Math.log10(smoothed) });
  }
  return detectLocalSpeech(frames).map(({ t, speaking }) => ({ kind: "local_speech", t, value: speaking ? 1 : 0 }));
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

/** Every voice signal of ordinary speech at full level: VAD, local detector, final transcripts. */
function voice(from: number, to: number, speech: readonly Span[], rand: () => number): GateInput[] {
  return [
    ...vadStream(from, to, speech, rand),
    ...localSpeech(from, to, speech.map((span) => ({ span, snrDb: 30 })), rand),
    ...finals(speech, rand),
  ];
}

function expertTypesWhileTalking(): GateRun {
  const rand = mulberry32(101);
  const speech: Span[] = [
    [1000, 6200],
    [6800, 9500],
    [11_000, 12_000],
    [21_000, 25_000],
  ];
  return {
    name: "expert types a note while talking",
    description:
      "Case opened (breakpoint). The expert explains the risk rating aloud while typing a case note; speech pauses " +
      "(0.6 s) and typing pauses (0.8 s) never line up for long enough. Ask once both have been idle and the last " +
      "utterance is transcribed; a second, ephemeral question waits for the expert's answer to finish.",
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
      ...voice(0, 40_000, speech, rand),
      ...keystrokes(
        [
          [5000, 9600],
          [10_400, 13_000],
        ],
        rand,
      ),
    ],
    speech,
    untilMs: 45_000,
    expectedAuthorizations: 2,
  };
}

function longPauseThenResume(): GateRun {
  const rand = mulberry32(202);
  const speech: Span[] = [
    [1000, 4000],
    [5000, 8000],
    [9150, 12_000],
    [14_600, 17_000],
    [21_000, 24_000],
  ];
  return {
    name: "long pause, then the expert resumes",
    description:
      "The expert thinks aloud with 1.0 s and 1.15 s hesitations (no ask: silence counts from the utterance's " +
      "transcript), then pauses for real: the gate asks once the transcript is in and 1.2 s have passed. The expert " +
      "resumes over the agent's question and then answers it; the next question waits for that turn and for the " +
      "answer to end (answer silence).",
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
      ...voice(0, 40_000, speech, rand),
    ],
    speech,
    untilMs: 40_000,
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
      ...voice(0, 35_000, [], rand),
    ],
    speech: [],
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
  const speech: Span[] = [[29_000, 38_000]];
  return {
    name: "VAD flicker around the threshold",
    description:
      "A noisy room keeps VAD scores at 0.25–0.5, crossing θ = 0.4 every few hundred ms: each crossing counts as " +
      "speech, so the gate waits for clean silence (and, with no transcript for the hum, the transcript wait). The " +
      "local detector learns the steady hum as its floor. Later the expert answers with speech whose VAD dips below " +
      "θ for single frames; the gate never asks inside a dip.",
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
      ...vadStream(0, 50_000, speech, rand, noise),
      ...localSpeech(0, 50_000, speech.map((span) => ({ span, snrDb: 25 })), rand, -45),
      ...finals(speech, rand),
    ],
    speech,
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
    inputs: [...inputs, ...voice(0, 700_000, speech, rand), ...keystrokes(typing, rand)],
    speech,
    untilMs: 700_000,
    expectedAuthorizations: 7,
  };
}

/** One utterance of live run D: when, how loud over the room (local detector) and what the provider VAD made of it. */
type Murmur = { start: number; ms: number; snrDb: number; vad: "lagged" | "blind"; transcribed: boolean };

/**
 * Live run D (production, session e047ef8b…), the run with all 3 live interruptions, reproduced on its
 * own pattern: broadband noise under everything; murmurs ("Okay.", "Mm-hm.", "Right.", …, 0.7–0.85 s)
 * 0.9–1.0 s apart at playback gains 0.12–0.4 while a question is pending; then a full answer.
 * - The provider VAD is BLIND to the quiet ones (live: 6 of 24 scored max 0.000–0.309, e.g. "Right."
 *   at gain 0.12 scored 0.000) and LAGS the others, crossing 0.4 about 600 ms after onset.
 * - Not every murmur gets a final transcript (live: several did not).
 * - The local detector hears every murmur: gain 0.12 over that noise is ≈ 12 dB above it in the speech band.
 * Without `local_speech` the gate saw silence during blind murmurs and during the first 600 ms of the
 * answer — live interruptions 1–3; the regression test checks that this reproduction fails that way.
 */
function noisyMurmursRunD(): GateRun {
  const rand = mulberry32(606);
  const gainSnrDb = [12, 16, 20, 22, 14, 18];
  const blind = new Set([0, 4, 6]);
  const murmurs: Murmur[] = [];
  let t = 2000;
  for (let i = 0; i < 8; i += 1) {
    const ms = 700 + Math.round(150 * rand());
    murmurs.push({ start: t, ms, snrDb: gainSnrDb[i % gainSnrDb.length] ?? 12, vad: blind.has(i) ? "blind" : "lagged", transcribed: i % 3 !== 2 });
    t += ms + (i === 2 ? 1900 : 950);
  }
  // A visible, transcribed murmur, then the quiet "Right." the VAD scored 0.000, 1.0 s later.
  murmurs.push({ start: t, ms: 740, snrDb: 22, vad: "lagged", transcribed: true });
  t += 740 + 1000;
  murmurs.push({ start: t, ms: 745, snrDb: 12, vad: "blind", transcribed: false });
  t += 745 + 1000;
  murmurs.push({ start: t, ms: 840, snrDb: 22, vad: "lagged", transcribed: true });
  // The full answer starts 1.5 s after that murmur's end: the VAD-only gate would see 1.2 s of silence (and the transcript) just before its VAD rises.
  const answerStart = t + 840 + 1500;
  const answer = { start: answerStart, ms: 8770, snrDb: 30, vad: "lagged" as const, transcribed: true };
  const all = [...murmurs, answer];
  const speech: Span[] = all.map((m) => [m.start, m.start + m.ms]);
  const vadSpans: Span[] = all.filter((m) => m.vad === "lagged").map((m) => [m.start + 600, m.start + m.ms + 200]);
  const end = answerStart + answer.ms + 20_000;
  return {
    name: "live run D reproduction: quiet murmurs the VAD missed, 600 ms VAD onset lag",
    description:
      "Noisy room; a question is pending while the expert murmurs short acknowledgements with < 1.2 s gaps (some " +
      "VAD-blind, the rest seen ~600 ms late, not all transcribed), then starts a full answer 1.5 s after the last " +
      "murmur. The gate must not ask during any murmur or the answer: it asks once the answer has been transcribed " +
      "and followed by silence.",
    inputs: [
      { kind: "breakpoint", t: 0, at: true },
      question(2300, "q-runD-1", {
        kind: "why_probe",
        value: 2.95,
        reason: "unexplained decision",
        text: "What led you to approve onboarding here, and what would have changed your mind?",
      }),
      ...vadStream(0, end, vadSpans, rand),
      ...localSpeech(0, end, all.map((m) => ({ span: [m.start, m.start + m.ms] as const, snrDb: m.snrDb })), rand, -51),
      ...finals(
        all.filter((m) => m.transcribed).map((m) => [m.start, m.start + m.ms] as const),
        rand,
      ),
    ],
    speech,
    untilMs: end,
    expectedAuthorizations: 1,
  };
}

/** The five P3 acceptance runs, in plan order. */
export const GATE_RUNS: readonly GateRun[] = [
  expertTypesWhileTalking(),
  longPauseThenResume(),
  rapidScreenNavigation(),
  vadFlicker(),
  budgetExhaustion(),
];

/** Live run D (the run that interrupted three times), reproduced. */
export const RUN_D_REPRODUCTION: GateRun = noisyMurmursRunD();
