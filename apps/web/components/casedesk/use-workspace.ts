"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ActionId, GuardrailResult } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { ApiError, describeError, listCases, type FetchFn } from "@/lib/client/api";
import { createDomEventEmitter, type DomChannelStatus, type DomEventEmitter } from "@/lib/client/dom-events";
import { commit, save, type SaveOutcome, type SaveRequest } from "@/lib/client/save-flow";
import {
  readLedger,
  summariseLedger,
  type DecisionOverride,
  type DecisionRecord,
  type RiskRating,
} from "@/lib/client/session-state";
import type { SessionRef } from "@/lib/client/session-url";
import { privacyFromLedger, type PrivacyBase } from "@/lib/client/voice/privacy";
import type { CaptureControl, GateSensors } from "@/lib/client/voice/use-interview";

const browserFetch: FetchFn = (input, init) => fetch(input, init);

export type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; cases: readonly KycCase[]; privacy: PrivacyBase };

export type Draft = { riskRating: RiskRating; outcome: ActionId | undefined };

export type SaveState = { status: "idle" } | { status: "saving"; caseId: string } | { status: "error"; caseId: string; message: string };

/** An interlock result the reviewer must respond to before anything is committed. */
export type InterlockPromptState = {
  kind: "blocked" | "needs_override";
  request: SaveRequest;
  checkId: string;
  result: GuardrailResult;
  submitting: boolean;
  error: string | undefined;
};

export type Workspace = {
  load: LoadState;
  retryLoad: () => void;
  selectedCase: KycCase | undefined;
  openCase: (caseId: string) => void;
  draftFor: (kycCase: KycCase) => Draft;
  setRiskRating: (kycCase: KycCase, rating: RiskRating) => void;
  setOutcome: (kycCase: KycCase, action: ActionId) => void;
  decisions: ReadonlyMap<string, DecisionRecord>;
  /** The case committed most recently in this page view (drives the success animation). */
  lastCommitted: string | undefined;
  saveState: SaveState;
  saveCase: (kycCase: KycCase) => void;
  prompt: InterlockPromptState | undefined;
  resolvePrompt: (override: DecisionOverride) => void;
  dismissPrompt: () => void;
  channel: DomChannelStatus;
  /** Off-record hooks for the DOM channel (plan §7.8). */
  capture: CaptureControl;
};

/**
 * CaseDesk state and actions. `sensors` (filled in by the interview loop) hears the gate-relevant
 * moments: a case opened, an edit, a committed decision.
 */
export function useWorkspace(ref: SessionRef, sensors: RefObject<GateSensors | null>): Workspace {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map());
  const [decisions, setDecisions] = useState<ReadonlyMap<string, DecisionRecord>>(new Map());
  const [lastCommitted, setLastCommitted] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [prompt, setPrompt] = useState<InterlockPromptState>();
  const [channel, setChannel] = useState<DomChannelStatus>({ state: "idle" });
  const emitterRef = useRef<DomEventEmitter | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    Promise.all([listCases(browserFetch, ref.caseSet), readLedger(browserFetch, ref.sessionId)]).then(
      ([{ cases }, entries]) => {
        if (cancelled) return;
        const session = summariseLedger(entries);
        const privacy = privacyFromLedger(entries);
        if (session.caseSet !== ref.caseSet || session.mode !== ref.mode) {
          setLoad({ status: "error", message: "This link's case set or mode does not match the recorded session." });
          return;
        }
        const emitter = createDomEventEmitter({
          sessionId: ref.sessionId,
          sessionEpoch: session.privacyEpoch,
          lastFrameSeq: session.lastFrameSeq,
          fetch: browserFetch,
        });
        emitterRef.current = emitter;
        emitter.subscribe(setChannel);
        // Reloaded while off the record: capture stays off until the reviewer resumes.
        if (privacy.offRecord) emitter.suspend();
        setChannel(emitter.status());
        setDecisions(session.decisions);
        setLoad({ status: "ready", cases, privacy });
        emitter.emit({ kind: "navigate" });
      },
      (error: unknown) => {
        if (cancelled) return;
        const notFound = error instanceof ApiError && error.status === 404;
        setLoad({ status: "error", message: notFound ? "This session does not exist on the server." : describeError(error) });
      },
    );
    return () => {
      cancelled = true;
      emitterRef.current?.dispose();
      emitterRef.current = undefined;
    };
  }, [ref.sessionId, ref.caseSet, ref.mode, attempt]);

  const cases = load.status === "ready" ? load.cases : undefined;
  const selectedCase = useMemo(() => cases?.find((c) => c.id === selectedId), [cases, selectedId]);

  const draftFor = useCallback(
    (kycCase: KycCase): Draft => drafts.get(kycCase.id) ?? { riskRating: kycCase.review.riskRating, outcome: undefined },
    [drafts],
  );

  const updateDraft = useCallback(
    (kycCase: KycCase, change: Partial<Draft>) => {
      setDrafts((current) => new Map(current).set(kycCase.id, { ...draftFor(kycCase), ...change }));
    },
    [draftFor],
  );

  const openCase = useCallback(
    (caseId: string) => {
      if (caseId === selectedId) return;
      setSelectedId(caseId);
      if (saveState.status === "error") setSaveState({ status: "idle" });
      emitterRef.current?.emit({ kind: "open_case", caseId });
      sensors.current?.caseOpened();
    },
    [selectedId, saveState.status, sensors],
  );

  const setRiskRating = useCallback(
    (kycCase: KycCase, rating: RiskRating) => {
      const from = draftFor(kycCase).riskRating;
      if (from === rating) return;
      updateDraft(kycCase, { riskRating: rating });
      emitterRef.current?.emit({ kind: "field_change", caseId: kycCase.id, field: "riskRating", from, to: rating });
      sensors.current?.edited();
    },
    [draftFor, updateDraft, sensors],
  );

  const setOutcome = useCallback(
    (kycCase: KycCase, action: ActionId) => {
      updateDraft(kycCase, { outcome: action });
      sensors.current?.edited();
    },
    [updateDraft, sensors],
  );

  /** Applies a save/commit outcome: record the decision, or raise the interlock prompt. */
  const apply = useCallback((outcome: SaveOutcome, request: SaveRequest) => {
    if (outcome.kind === "committed") {
      const { decision } = outcome;
      setDecisions((current) => new Map(current).set(decision.caseId, decision));
      setLastCommitted(decision.caseId);
      setPrompt(undefined);
      emitterRef.current?.emit({ kind: "action", caseId: decision.caseId, action: decision.action });
      sensors.current?.committed();
      return;
    }
    setPrompt({ kind: outcome.kind, request, checkId: outcome.checkId, result: outcome.result, submitting: false, error: undefined });
  }, [sensors]);

  const capture = useMemo<CaptureControl>(
    () => ({
      suspend: () => emitterRef.current?.suspend(),
      resume: (epoch) => emitterRef.current?.resume(epoch),
    }),
    [],
  );

  const saveCase = useCallback(
    (kycCase: KycCase) => {
      const emitter = emitterRef.current;
      const { riskRating, outcome } = draftFor(kycCase);
      if (!emitter || outcome === undefined || saveState.status === "saving") return;
      const request: SaveRequest = { sessionId: ref.sessionId, caseId: kycCase.id, action: outcome, riskRating };
      setSaveState({ status: "saving", caseId: kycCase.id });
      save({ fetch: browserFetch, flushEvents: () => emitter.flush() }, request).then(
        (result) => {
          setSaveState({ status: "idle" });
          apply(result, request);
        },
        (error: unknown) => setSaveState({ status: "error", caseId: kycCase.id, message: describeError(error) }),
      );
    },
    [apply, draftFor, ref.sessionId, saveState.status],
  );

  const resolvePrompt = useCallback(
    (override: DecisionOverride) => {
      if (!prompt || prompt.kind !== "needs_override" || prompt.submitting) return;
      const { request, checkId } = prompt;
      setPrompt({ ...prompt, submitting: true, error: undefined });
      commit(browserFetch, request, checkId, override).then(
        (result) => apply(result, request),
        (error: unknown) =>
          setPrompt((current) => current && { ...current, submitting: false, error: describeError(error) }),
      );
    },
    [apply, prompt],
  );

  const dismissPrompt = useCallback(() => {
    setPrompt((current) => (current?.submitting ? current : undefined));
  }, []);

  return {
    load,
    retryLoad: () => setAttempt((n) => n + 1),
    selectedCase,
    openCase,
    draftFor,
    setRiskRating,
    setOutcome,
    decisions,
    lastCommitted,
    saveState,
    saveCase,
    prompt,
    resolvePrompt,
    dismissPrompt,
    channel,
    capture,
  };
}
