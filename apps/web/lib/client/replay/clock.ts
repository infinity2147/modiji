/**
 * The replay's virtual clock (pure). Entry i appears at virtual offset `offsets[i]`: a short lead-in,
 * then the recorded gaps between the times the server received consecutive entries — real time, or with
 * long idle gaps capped (`capMs`, shown in the UI as "idle gaps shortened") so a run's quiet minutes do
 * not stall the replay. The order of entries is never changed and nothing is added.
 */

export const LEAD_IN_MS = 600;
export const IDLE_GAP_CAP_MS = 2_500;
export const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32] as const;

export type Timeline = {
  /** Virtual time at which each entry appears, non-decreasing. */
  offsets: number[];
  /** Virtual time of the last entry. */
  duration: number;
  /** Gaps that were shortened (0 in real time). */
  shortened: number;
};

export function buildTimeline(times: readonly number[], capMs: number | null): Timeline {
  const offsets: number[] = [];
  let shortened = 0;
  let at = LEAD_IN_MS;
  times.forEach((t, i) => {
    if (i > 0) {
      const gap = Math.max(0, t - (times[i - 1] ?? t));
      if (capMs !== null && gap > capMs) shortened += 1;
      at += capMs === null ? gap : Math.min(gap, capMs);
    }
    offsets.push(at);
  });
  return { offsets, duration: offsets.at(-1) ?? 0, shortened };
}

/** How many entries have appeared at virtual time `position` (binary search). */
export function countAt(timeline: Timeline, position: number): number {
  const { offsets } = timeline;
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((offsets[mid] ?? Infinity) <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The virtual time at which exactly `n` entries have appeared. */
export function positionOf(timeline: Timeline, n: number): number {
  if (n <= 0) return 0;
  return timeline.offsets[Math.min(n, timeline.offsets.length) - 1] ?? 0;
}

export type Playback = { position: number; playing: boolean; speed: number };

export const INITIAL_PLAYBACK: Playback = { position: 0, playing: false, speed: 1 };

/** Advances by `realMs` of wall time at the playback speed; stops at the end. */
export function advance(playback: Playback, timeline: Timeline, realMs: number): Playback {
  if (!playback.playing) return playback;
  const position = playback.position + Math.max(0, realMs) * playback.speed;
  return position >= timeline.duration ? { ...playback, position: timeline.duration, playing: false } : { ...playback, position };
}

/** Re-maps a position when the timeline changes (e.g. idle gaps toggled): the same number of entries stays applied. */
export function remap(playback: Playback, from: Timeline, to: Timeline): Playback {
  return { ...playback, position: positionOf(to, countAt(from, playback.position)) };
}
