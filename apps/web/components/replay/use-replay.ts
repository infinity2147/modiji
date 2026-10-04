"use client";

/**
 * Client state of the verified replay: the bundle (re-verified by the server on every load), the
 * virtual clock driven by animation frames, and the server views derived for the current position
 * (one request in flight; when it returns, the newest position is fetched next).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, requestJson, type FetchFn } from "@/lib/client/api";
import {
  IDLE_GAP_CAP_MS,
  INITIAL_PLAYBACK,
  advance,
  buildTimeline,
  countAt,
  positionOf,
  remap,
  type Playback,
  type Timeline,
} from "@/lib/client/replay/clock";
import { ReplayBundleResponseSchema, ReplayViewsResponseSchema, type ReplayBundleResponse, type ReplayViewsResponse } from "@/lib/contracts/replay";

const browserFetch: FetchFn = (input, init) => fetch(input, init);

export type BundleLoad =
  | { status: "loading" }
  | { status: "refused"; detail: string }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ReplayBundleResponse };

export function useBundle(bundleId: string): BundleLoad {
  const [load, setLoad] = useState<BundleLoad>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    requestJson(browserFetch, `/api/replays/${encodeURIComponent(bundleId)}`, ReplayBundleResponseSchema).then(
      (data) => !cancelled && setLoad({ status: "ready", data }),
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === "integrity_failed") setLoad({ status: "refused", detail: error.detail ?? "integrity check failed" });
        else if (error instanceof ApiError && error.status === 404) setLoad({ status: "missing" });
        else setLoad({ status: "error", message: describeError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bundleId]);
  return load;
}

export type Clock = {
  timeline: Timeline;
  playback: Playback;
  /** Entries applied at the current position. */
  n: number;
  skipIdle: boolean;
  play: () => void;
  pause: () => void;
  seek: (n: number) => void;
  setSpeed: (speed: number) => void;
  setSkipIdle: (skip: boolean) => void;
};

export function useClock(times: readonly number[]): Clock {
  const [skipIdle, setSkipIdleState] = useState(true);
  const timeline = useMemo(() => buildTimeline(times, skipIdle ? IDLE_GAP_CAP_MS : null), [times, skipIdle]);
  const [playback, setPlayback] = useState<Playback>(INITIAL_PLAYBACK);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  useEffect(() => {
    if (!playback.playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = now - last;
      last = now;
      setPlayback((p) => advance(p, timelineRef.current, dt));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playback.playing]);

  const setSkipIdle = useCallback(
    (skip: boolean) => {
      const next = buildTimeline(times, skip ? IDLE_GAP_CAP_MS : null);
      setPlayback((p) => remap(p, timelineRef.current, next));
      setSkipIdleState(skip);
    },
    [times],
  );

  return {
    timeline,
    playback,
    n: countAt(timeline, playback.position),
    skipIdle,
    play: () => setPlayback((p) => ({ ...p, playing: true, position: p.position >= timeline.duration ? 0 : p.position })),
    pause: () => setPlayback((p) => ({ ...p, playing: false })),
    seek: (n) => setPlayback((p) => ({ ...p, position: positionOf(timelineRef.current, n) })),
    setSpeed: (speed) => setPlayback((p) => ({ ...p, speed })),
    setSkipIdle,
  };
}

export type ViewsState = { views: ReplayViewsResponse | null; pending: boolean; error: string | undefined };

/** Server views for position n; keeps the last result while the next is derived. */
export function useReplayViews(bundleId: string, n: number): ViewsState {
  const [state, setState] = useState<ViewsState>({ views: null, pending: true, error: undefined });
  const want = useRef(n);
  want.current = n;
  const inFlight = useRef(false);
  const alive = useRef(true);

  const pump = useCallback(() => {
    if (inFlight.current) return;
    const target = want.current;
    inFlight.current = true;
    setState((s) => ({ ...s, pending: true }));
    requestJson(browserFetch, `/api/replays/${encodeURIComponent(bundleId)}/views?n=${target}`, ReplayViewsResponseSchema)
      .then(
        (views) => alive.current && setState({ views, pending: want.current !== target, error: undefined }),
        (error: unknown) =>
          alive.current &&
          setState((s) => ({ ...s, pending: false, error: error instanceof ApiError && error.kind === "invalid_response" && error.detail !== undefined ? `${describeError(error)} ${error.detail}` : describeError(error) })),
      )
      .finally(() => {
        inFlight.current = false;
        if (alive.current && want.current !== target) pump();
      });
  }, [bundleId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    pump();
  }, [n, pump]);
  return state;
}
