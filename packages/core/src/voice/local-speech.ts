import { z } from "zod";

/**
 * Local speech-onset sensing for the gate (plan §7.2 "user speaking"): an energy-based voice-activity
 * detector over the expert's own microphone level, independent of the voice provider. Live run D showed
 * why the provider's VAD cannot be the only input: it scored 6 of 24 quiet utterances below 0.4 (max
 * 0.000 for a quiet "Right.") and crossed 0.4 about 600 ms after speech began, so the gate saw silence
 * while the expert spoke. This detector reacts within `onsetMs` of a level rise and holds "speaking"
 * through short dips (`hangoverMs`); the gate ORs it with the provider's VAD.
 *
 * Pure and deterministic: a reducer over level frames (dB, any fixed reference) stamped with their
 * time. The noise floor adapts: it follows the level down quickly (`floorFallPerFrame`) and up at most
 * `floorRiseDbPerSec`, so steady background noise is learned within seconds while a spoken word (tens
 * to hundreds of ms) cannot raise it enough to hide itself. Speech starts once the level has stayed
 * `onsetDb` above the floor for `onsetMs`, and ends once it has stayed below `floor + offsetDb` for
 * `hangoverMs` (hysteresis: `offsetDb` < `onsetDb`). Misreading a cough or a key click as speech only
 * delays a question; missing speech interrupts the expert, so the thresholds sit on the sensitive side.
 */
export const LocalSpeechConfigSchema = z
  .strictObject({
    onsetDb: z.number().positive().default(8),
    offsetDb: z.number().positive().default(4),
    onsetMs: z.int().nonnegative().default(40),
    hangoverMs: z.int().nonnegative().default(300),
    /** Below this level nothing is speech (digital silence, a muted or absent microphone). */
    minLevelDb: z.number().default(-90),
    floorRiseDbPerSec: z.number().positive().default(3),
    floorFallPerFrame: z.number().gt(0).max(1).default(0.15),
  })
  .refine((c) => c.offsetDb < c.onsetDb, "offsetDb must be below onsetDb (hysteresis)");
export type LocalSpeechConfig = z.output<typeof LocalSpeechConfigSchema>;
export type LocalSpeechConfigInput = z.input<typeof LocalSpeechConfigSchema>;

export const DEFAULT_LOCAL_SPEECH_CONFIG: LocalSpeechConfig = LocalSpeechConfigSchema.parse({});

/** One level measurement: `t` epoch ms, `levelDb` the frame's energy in dB. */
export type LevelFrame = { t: number; levelDb: number };

export type LocalSpeechState = Readonly<{
  speaking: boolean;
  /** Adaptive noise floor (dB); null before the first frame. */
  floorDb: number | null;
  lastT: number | null;
  /** While silent: when the level first rose past the onset threshold (null if it is below). */
  aboveSince: number | null;
  /** While speaking: when the level first fell below the offset threshold (null if it is above). */
  belowSince: number | null;
}>;

export const INITIAL_LOCAL_SPEECH_STATE: LocalSpeechState = {
  speaking: false,
  floorDb: null,
  lastT: null,
  aboveSince: null,
  belowSince: null,
};

export type LocalSpeechStep = { state: LocalSpeechState; changed: boolean };

function nextFloor(floor: number, level: number, dtMs: number, cfg: LocalSpeechConfig): number {
  if (level <= floor) return floor + (level - floor) * cfg.floorFallPerFrame;
  return floor + Math.min(level - floor, (cfg.floorRiseDbPerSec * dtMs) / 1000);
}

/** Advances the detector by one frame; `changed` reports a speaking ↔ silent transition at `frame.t`. */
export function stepLocalSpeech(s: LocalSpeechState, frame: LevelFrame, cfg: LocalSpeechConfig = DEFAULT_LOCAL_SPEECH_CONFIG): LocalSpeechStep {
  const { t, levelDb } = frame;
  if (!Number.isFinite(levelDb) || (s.lastT !== null && t < s.lastT)) return { state: s, changed: false };
  const floor = s.floorDb ?? levelDb;
  const audible = levelDb >= cfg.minLevelDb;
  // Thresholds are judged against the floor as it stood before this frame.
  const above = audible && levelDb >= floor + cfg.onsetDb;
  const below = !audible || levelDb < floor + cfg.offsetDb;
  const floorDb = nextFloor(floor, levelDb, s.lastT === null ? 0 : t - s.lastT, cfg);
  const base = { floorDb, lastT: t };

  if (!s.speaking) {
    const aboveSince = above ? (s.aboveSince ?? t) : null;
    if (aboveSince !== null && t - aboveSince >= cfg.onsetMs)
      return { state: { ...base, speaking: true, aboveSince: null, belowSince: null }, changed: true };
    return { state: { ...base, speaking: false, aboveSince, belowSince: null }, changed: false };
  }
  const belowSince = below ? (s.belowSince ?? t) : null;
  if (belowSince !== null && t - belowSince >= cfg.hangoverMs)
    return { state: { ...base, speaking: false, aboveSince: null, belowSince: null }, changed: true };
  return { state: { ...base, speaking: true, aboveSince: null, belowSince }, changed: false };
}

/** Runs the detector over `frames` (in time order) and returns the speaking ↔ silent transitions. */
export function detectLocalSpeech(
  frames: readonly LevelFrame[],
  cfg: LocalSpeechConfig = DEFAULT_LOCAL_SPEECH_CONFIG,
): { t: number; speaking: boolean }[] {
  const out: { t: number; speaking: boolean }[] = [];
  let state = INITIAL_LOCAL_SPEECH_STATE;
  for (const frame of frames) {
    const step = stepLocalSpeech(state, frame, cfg);
    state = step.state;
    if (step.changed) out.push({ t: frame.t, speaking: state.speaking });
  }
  return out;
}

/**
 * Band energy (dB) of an `AnalyserNode`-style byte spectrum, whose bytes map linearly onto
 * [minDecibels, maxDecibels] (Web Audio defaults −100…−30 dB): the mean linear power of `bins`
 * expressed in dB. All-zero bytes (silence, a muted input) read as `minDecibels`.
 */
export function byteSpectrumLevelDb(bins: ArrayLike<number>, range: { minDecibels: number; maxDecibels: number } = { minDecibels: -100, maxDecibels: -30 }): number {
  if (bins.length === 0) return range.minDecibels;
  const span = range.maxDecibels - range.minDecibels;
  let power = 0;
  for (let i = 0; i < bins.length; i += 1) power += 10 ** ((range.minDecibels + ((bins[i] ?? 0) / 255) * span) / 10);
  return 10 * Math.log10(power / bins.length);
}
