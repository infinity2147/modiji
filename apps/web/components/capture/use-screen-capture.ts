"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { describeError, type FetchFn } from "@/lib/client/api";
import { fetchVisionState } from "@/lib/client/capture/api";
import { createBrowserCaseIdTracker, createBrowserRedactor, encodePng, personNames, startScreenShare } from "@/lib/client/capture/browser";
import { createCapturePipeline, type CapturePipeline, type CaptureStats, type CaptureStatus } from "@/lib/client/capture/pipeline";
import { usePrivacyController } from "@/lib/client/voice/use-interview";

const browserFetch: FetchFn = (input, init) => fetch(input, init);

export type ScreenCapture = {
  /** Null until the session's vision state has loaded. */
  status: CaptureStatus | null;
  stats: CaptureStats | null;
  /** Why the last "Share screen" attempt or the initial load failed. */
  error: string | undefined;
  share: () => void;
  stop: () => void;
};

/**
 * The capture pipeline for one CaseDesk session. Off the record comes from the workspace's privacy
 * controller (`PrivacyContext`): every change is forwarded synchronously to the pipeline, which stops
 * the share and cancels queued uploads before the server is even told.
 */
export function useScreenCapture(sessionId: string, cases: readonly KycCase[]): ScreenCapture {
  const privacy = usePrivacyController();
  const [pipeline, setPipeline] = useState<CapturePipeline | null>(null);
  const [, setVersion] = useState(0);
  const [error, setError] = useState<string>();
  const names = useRef<string[]>([]);
  names.current = personNames(cases);
  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;

  useEffect(() => {
    let cancelled = false;
    let created: CapturePipeline | null = null;
    const { redactor, terminate } = createBrowserRedactor(() => names.current);
    fetchVisionState(browserFetch, sessionId).then(
      ({ vision }) => {
        if (cancelled) return;
        created = createCapturePipeline({
          sessionId,
          fetch: browserFetch,
          privacy: privacyRef.current?.state() ?? { offRecord: vision.offRecord, epoch: vision.privacyEpoch },
          lastFrameSeq: vision.lastFrameSeq,
          redactor,
          caseIdTracker: createBrowserCaseIdTracker(),
          encode: encodePng,
        });
        created.subscribe(() => setVersion((v) => v + 1));
        setPipeline(created);
      },
      (failure: unknown) => {
        if (!cancelled) setError(describeError(failure));
      },
    );
    return () => {
      cancelled = true;
      created?.dispose();
      setPipeline(null);
      void terminate();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!pipeline || !privacy) return;
    pipeline.setPrivacy(privacy.state());
    return privacy.subscribe((state) => pipeline.setPrivacy(state));
  }, [pipeline, privacy]);

  const share = useCallback(() => {
    if (!pipeline) return;
    setError(undefined);
    // getDisplayMedia runs synchronously inside this click, as the browser requires.
    startScreenShare().then(
      (grabber) => {
        if (!pipeline.start(grabber)) setError("Capture is paused while off the record.");
      },
      (failure: unknown) =>
        setError(failure instanceof DOMException && failure.name === "NotAllowedError" ? "Screen sharing was not allowed." : describeError(failure)),
    );
  }, [pipeline]);

  const stop = useCallback(() => pipeline?.stop(), [pipeline]);

  return { status: pipeline?.status() ?? null, stats: pipeline?.stats() ?? null, error, share, stop };
}
