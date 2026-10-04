"use client";

/**
 * The tutor's client state for one novice session: the server's tutor view (rules on the ladder,
 * per-case prompts, predictions, interventions), refreshed after every tutor action and whenever the
 * session ledger grows (an intervention spoken, a decision committed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionId } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import type { JudgeFeatures, PredictionView, TutorState } from "../../contracts/tutor";
import { describeError, type FetchFn } from "../api";
import type { RiskRating } from "../session-state";
import { coachChat, coachNudge, fetchTutorState, postBriefing, postIntent, postJudgeCase, postPractice, postPrediction } from "./api";

const browserFetch: FetchFn = (input, init) => fetch(input, init);

export type Tutor = {
  state: TutorState | undefined;
  error: string | undefined;
  refresh: () => void;
  /** The novice selected an outcome (DOM channel): the guardrail monitor runs on the server. */
  intent: (caseId: string, action: ActionId, riskRating: RiskRating) => void;
  predict: (caseId: string, predicted: ActionId, riskRating: RiskRating) => Promise<PredictionView>;
  practice: () => Promise<{ cases: readonly KycCase[]; note: string | null }>;
  judgeCase: (features: JudgeFeatures) => Promise<KycCase>;
  /** Queue the coach's spoken welcome (once per session); resolves quietly if there is nothing to say. */
  briefing: (caseId?: string) => Promise<void>;
  /**
   * The trainee typed to the coach: resolves with the coach's reply text (also queued for speech when the voice
   * coach is on: `queued`). The tutor view is re-read so the conversation shows both turns.
   */
  chat: (text: string) => Promise<{ text: string; queued: boolean }>;
  /** Ask the coach for a hint on a case the trainee has been quiet on; resolves with whether one was queued. */
  nudge: (caseId: string) => Promise<boolean>;
};

export function useTutor(sessionId: string, enabled: boolean): Tutor {
  const [state, setState] = useState<TutorState>();
  const [error, setError] = useState<string>();
  const latest = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    const ticket = ++latest.current;
    fetchTutorState(browserFetch, sessionId).then(
      (next) => {
        if (ticket !== latest.current) return;
        setState(next);
        setError(undefined);
      },
      (failure: unknown) => {
        if (ticket === latest.current) setError(describeError(failure));
      },
    );
  }, [enabled, sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const intent = useCallback(
    (caseId: string, action: ActionId, riskRating: RiskRating) => {
      if (!enabled) return;
      postIntent(browserFetch, sessionId, { caseId, proposedAction: action, edits: { riskRating } }).then(
        () => refresh(),
        (failure: unknown) => setError(describeError(failure)),
      );
    },
    [enabled, refresh, sessionId],
  );

  const predict = useCallback(
    async (caseId: string, predicted: ActionId, riskRating: RiskRating) => {
      const response = await postPrediction(browserFetch, sessionId, { caseId, predicted, edits: { riskRating } });
      latest.current += 1;
      setState(response.state);
      return response.prediction;
    },
    [sessionId],
  );

  const practice = useCallback(async () => {
    const response = await postPractice(browserFetch, sessionId);
    latest.current += 1;
    setState(response.state);
    return { cases: response.cases, note: response.note };
  }, [sessionId]);

  const judgeCase = useCallback(
    async (features: JudgeFeatures) => {
      const response = await postJudgeCase(browserFetch, sessionId, { features });
      latest.current += 1;
      setState(response.state);
      return response.case;
    },
    [sessionId],
  );

  const briefing = useCallback(
    async (caseId?: string) => {
      await postBriefing(browserFetch, sessionId, caseId === undefined ? {} : { caseId });
    },
    [sessionId],
  );

  const chat = useCallback(
    async (text: string) => {
      const response = await coachChat(browserFetch, sessionId, text);
      refresh();
      return { text: response.text, queued: response.questionId !== null };
    },
    [refresh, sessionId],
  );

  const nudge = useCallback(
    async (caseId: string) => {
      const response = await coachNudge(browserFetch, sessionId, caseId, "idle");
      if (response.queued) refresh();
      return response.queued;
    },
    [refresh, sessionId],
  );

  return { state, error, refresh, intent, predict, practice, judgeCase, briefing, chat, nudge };
}
