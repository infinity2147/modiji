import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/gate/simulate";
import {
  DEFAULT_LOCAL_SPEECH_CONFIG,
  INITIAL_LOCAL_SPEECH_STATE,
  LocalSpeechConfigSchema,
  byteSpectrumLevelDb,
  detectLocalSpeech,
  stepLocalSpeech,
  type LevelFrame,
} from "../src/voice/local-speech";

const FRAME_MS = 20;

/**
 * A microphone as the browser reads it: a room at `floorDb(t)` (±0.8 dB), utterances `snrDb` above it
 * with ±3 dB syllable modulation, through the analyser's smoothing (0.8 per 20 ms read).
 */
function mic(untilMs: number, utterances: { from: number; to: number; snrDb: number }[], floorDb: (t: number) => number = () => -60, seed = 7): LevelFrame[] {
  const rand = mulberry32(seed);
  const frames: LevelFrame[] = [];
  let smoothed = 10 ** (floorDb(0) / 20);
  for (let t = 0; t < untilMs; t += FRAME_MS) {
    let amplitude = 10 ** ((floorDb(t) + 1.6 * (rand() - 0.5)) / 20);
    for (const u of utterances)
      if (t >= u.from && t < u.to) amplitude += 10 ** ((floorDb(t) + u.snrDb + 3 * Math.sin((2 * Math.PI * 4 * (t - u.from)) / 1000)) / 20);
    smoothed = 0.8 * smoothed + 0.2 * amplitude;
    frames.push({ t, levelDb: 20 * Math.log10(smoothed) });
  }
  return frames;
}

describe("local speech detector", () => {
  it("stays silent in a steady room", () => {
    expect(detectLocalSpeech(mic(30_000, []))).toEqual([]);
  });

  it("hears a quiet word (+12 dB, the gain-0.12 'Right.' the provider VAD scored 0.000) within 150 ms of onset", () => {
    const transitions = detectLocalSpeech(mic(6000, [{ from: 2000, to: 2745, snrDb: 12 }]));
    expect(transitions).toHaveLength(2);
    const [on, off] = transitions;
    expect(on?.speaking).toBe(true);
    expect(on!.t - 2000).toBeLessThanOrEqual(150);
    expect(off?.speaking).toBe(false);
    expect(off!.t - 2745).toBeGreaterThanOrEqual(DEFAULT_LOCAL_SPEECH_CONFIG.hangoverMs);
    expect(off!.t - 2745).toBeLessThanOrEqual(700);
  });

  it("hears full-level speech within 60 ms and keeps it through short dips (hangover)", () => {
    const transitions = detectLocalSpeech(
      mic(8000, [
        { from: 1000, to: 2500, snrDb: 30 },
        { from: 2600, to: 4000, snrDb: 30 }, // a 100 ms gap between words
      ]),
    );
    expect(transitions.map((x) => x.speaking)).toEqual([true, false]);
    expect(transitions[0]!.t - 1000).toBeLessThanOrEqual(60);
    expect(transitions[1]!.t).toBeGreaterThan(4000);
  });

  it("separates murmurs 1 s apart (each is its own utterance)", () => {
    const murmurs = [0, 1, 2].map((i) => ({ from: 1000 + i * 1750, to: 1750 + i * 1750, snrDb: 14 }));
    expect(detectLocalSpeech(mic(8000, murmurs)).map((x) => x.speaking)).toEqual([true, false, true, false, true, false]);
  });

  it("adapts to a new, steady noise level within seconds and then hears speech above it", () => {
    const floor = (t: number) => (t < 5000 ? -60 : -45); // an air conditioner switches on at 5 s
    const transitions = detectLocalSpeech(mic(30_000, [{ from: 20_000, to: 21_000, snrDb: 15 }], floor));
    const [hvacOn, hvacOff, on, off] = transitions;
    expect([hvacOn?.speaking, hvacOff?.speaking, on?.speaking, off?.speaking]).toEqual([true, false, true, false]);
    expect(hvacOff!.t).toBeLessThan(15_000);
    expect(on!.t).toBeGreaterThanOrEqual(20_000);
    expect(on!.t - 20_000).toBeLessThanOrEqual(150);
    expect(transitions).toHaveLength(4);
  });

  it("a muted or silent input (−100 dB) is never speech; frames out of order or non-finite are ignored", () => {
    const silent = Array.from({ length: 200 }, (_, i) => ({ t: i * FRAME_MS, levelDb: -100 }));
    expect(detectLocalSpeech(silent)).toEqual([]);
    const s = stepLocalSpeech(INITIAL_LOCAL_SPEECH_STATE, { t: 1000, levelDb: -60 }).state;
    expect(stepLocalSpeech(s, { t: 999, levelDb: 0 }).state).toBe(s);
    expect(stepLocalSpeech(s, { t: 1020, levelDb: Number.NaN }).state).toBe(s);
  });

  it("is deterministic", () => {
    const frames = mic(10_000, [{ from: 3000, to: 4000, snrDb: 12 }]);
    expect(detectLocalSpeech(frames)).toEqual(detectLocalSpeech(frames));
  });

  it("validates its configuration (hysteresis: offset below onset)", () => {
    expect(LocalSpeechConfigSchema.safeParse({ onsetDb: 6, offsetDb: 6 }).success).toBe(false);
    expect(LocalSpeechConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("byteSpectrumLevelDb", () => {
  it("maps analyser bytes onto [minDecibels, maxDecibels] and averages linear power", () => {
    expect(byteSpectrumLevelDb(new Uint8Array(512))).toBeCloseTo(-100, 6);
    expect(byteSpectrumLevelDb(new Uint8Array(512).fill(255))).toBeCloseTo(-30, 6);
    // Half the bins at −30 dB, half silent: the mean power is half of −30 dB's (−3 dB).
    const half = new Uint8Array(512).fill(255, 0, 256);
    expect(byteSpectrumLevelDb(half)).toBeCloseTo(10 * Math.log10((10 ** -3 + 10 ** -10) / 2), 6);
    expect(byteSpectrumLevelDb(new Uint8Array(0))).toBe(-100);
  });
});
