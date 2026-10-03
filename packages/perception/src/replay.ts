/**
 * Offline replay of a recorded session through the real perception pipeline (change detector →
 * ordered queue → extractor → `toScreenEvents` → state applier), for the P2 evaluation. The clock
 * is injected: a real clock paces frames at their recorded times (live Haiku measurement); the
 * virtual clock runs the same schedule as a deterministic discrete-event simulation (fake
 * extractor). PII redaction is not part of the replay: fixtures are synthetic CaseDesk sessions.
 */
import type { DomainConfig } from "@vashistha/core";
import { createChangeDetector, DEFAULT_CHANGE_CONFIG, type ChangeDetectorConfig } from "./change-detector";
import { toScreenEvents, type CaseSnapshot, type Dropped, type ExtractionResult, type FrameOutput, type ProposedConcept } from "./extraction";
import type { VisionObservation } from "./evaluation";
import type { Rect, RgbaImage } from "./image";
import { createPerceptionQueue, type QueueStats } from "./queue";

export type Clock = { now(): number; sleepUntil(t: number): Promise<void> };

/** Wall clock mapped onto the fixture timebase: `now()` reads `origin` at creation and advances in real time. */
export function createRealClock(origin: number): Clock {
  const started = performance.now();
  const now = (): number => origin + (performance.now() - started);
  return {
    now,
    sleepUntil: (t) => new Promise((resolve) => setTimeout(resolve, Math.max(0, t - now()))),
  };
}

export type VirtualClock = Clock & {
  /** Runs `main` to completion, advancing time to the earliest pending sleep whenever all work is blocked. */
  run<T>(main: () => Promise<T>): Promise<T>;
};

/**
 * Deterministic simulated time. Between steps, one macrotask turn lets every promise chain settle,
 * so the simulation is exact as long as the simulated code waits only on this clock (no real I/O).
 */
export function createVirtualClock(start: number): VirtualClock {
  let t = start;
  let order = 0;
  const timers: Array<{ at: number; order: number; resolve: () => void }> = [];
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    now: () => t,
    sleepUntil(at) {
      return new Promise((resolve) => {
        timers.push({ at: Math.max(at, t), order: order++, resolve });
      });
    },
    async run<T>(main: () => Promise<T>): Promise<T> {
      const state: { outcome: { ok: true; value: T } | { ok: false; error: unknown } | null } = {
        outcome: null,
      };
      main().then(
        (value) => (state.outcome = { ok: true, value }),
        (error: unknown) => (state.outcome = { ok: false, error }),
      );
      for (;;) {
        await settle();
        const done = state.outcome;
        if (done !== null) {
          if (done.ok) return done.value;
          throw done.error;
        }
        timers.sort((a, b) => a.at - b.at || a.order - b.order);
        const next = timers.shift();
        if (next === undefined) throw new Error("virtual clock deadlock: main is waiting on something other than the clock");
        t = next.at;
        next.resolve();
      }
    },
  };
}

export type ExtractorInput = {
  image: RgbaImage;
  bbox: Rect | null;
  previous: CaseSnapshot | null;
  frameSeq: number;
  captureTime: number;
  sessionEpoch: number;
};
/** One model call per frame: returns the structured output exactly as the model would. */
export type FrameExtractor = (input: ExtractorInput) => Promise<FrameOutput>;

export type ReplayFrame = { captureTime: number; load(): RgbaImage };

export type ReplayResult = {
  observations: VisionObservation[];
  concepts: ProposedConcept[];
  dropped: Dropped[];
  queue: QueueStats;
  frames: { total: number; changed: number };
  errors: string[];
};

export async function replaySession(options: {
  domain: DomainConfig;
  sessionEpoch: number;
  frames: readonly ReplayFrame[];
  extract: FrameExtractor;
  clock: Clock;
  detector?: ChangeDetectorConfig;
}): Promise<ReplayResult> {
  const { domain, sessionEpoch, clock } = options;
  const detector = createChangeDetector(options.detector ?? DEFAULT_CHANGE_CONFIG);
  const observations: VisionObservation[] = [];
  const concepts: ProposedConcept[] = [];
  const dropped: Dropped[] = [];
  const errors: string[] = [];
  let snapshot: CaseSnapshot | null = null;
  let changed = 0;

  const queue = createPerceptionQueue<{ image: RgbaImage; bbox: Rect | null }, ExtractionResult>({
    epoch: sessionEpoch,
    now: () => clock.now(),
    async send(frame) {
      const context = { domain, previous: snapshot, frameSeq: frame.frameSeq, captureTime: frame.captureTime, sessionEpoch: frame.epoch };
      const output = await options.extract({ ...frame.payload, ...context });
      return toScreenEvents(output, context);
    },
    apply(result) {
      snapshot = result.snapshot;
      const appliedAt = clock.now();
      observations.push(...result.events.map((event) => ({ event, appliedAt })));
      concepts.push(...result.concepts);
      dropped.push(...result.dropped);
    },
    onError(error, frame) {
      errors.push(`frame ${frame.frameSeq}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  for (const frame of options.frames) {
    await clock.sleepUntil(frame.captureTime);
    const image = frame.load();
    const change = detector.push(image);
    if (!change.changed) continue;
    changed += 1;
    queue.submit({ image, bbox: change.bbox }, frame.captureTime, sessionEpoch);
  }
  await queue.idle();
  return { observations, concepts, dropped, queue: queue.stats(), frames: { total: options.frames.length, changed }, errors };
}
