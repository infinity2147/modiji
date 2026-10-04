"use client";

import { useEffect, useReducer, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, GraduationCap, Loader2, RotateCcw, ShieldAlert, Volume2, VolumeX, XCircle } from "lucide-react";
import type { ActionId } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { describeError } from "@/lib/client/api";
import { REVIEW_OUTCOMES } from "@/lib/client/domain";
import type { RiskRating } from "@/lib/client/session-state";
import { INITIAL_PREDICT_STATE, decisionUnlocked, predictReducer } from "@/lib/client/tutor/predict-machine";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import {
  interventionKey,
  interventionSpeech,
  interventionSpeechLine,
  revealKey,
  revealSpeech,
  useHoldTutorVoice,
  useTutorVoice,
  type TutorVoice,
} from "@/lib/client/tutor/speech";
import { activeIntervention, interventionCard, revealCard } from "@/lib/client/tutor/view";
import type { InterventionView, PredictionView, TutorState } from "@/lib/contracts/tutor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RuleQuote } from "./rule-quote";

function PredictionPrompt({
  kycCase: _kycCase,
  choice,
  submitting,
  error,
  disabled,
  onChoose,
  onSubmit,
}: {
  kycCase: KycCase;
  choice: ActionId | undefined;
  submitting: boolean;
  error: string | undefined;
  disabled: boolean;
  onChoose: (action: ActionId) => void;
  onSubmit: () => void;
}) {
  return (
    <Card className="gap-0 py-0 shadow-xs ring-1 ring-sky-200" role="region" aria-labelledby="predict-title">
      <CardHeader className="border-b py-3!">
        <h2 id="predict-title" className="flex items-center gap-2 text-sm font-semibold">
          <GraduationCap aria-hidden className="size-4 text-sky-700" />
          What would the expert decide?
        </h2>
        <CardDescription className="text-xs">
          Choose an outcome before viewing the expert&rsquo;s reasoning.
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <CardContent className="py-3">
          <fieldset disabled={disabled || submitting}>
            <legend className="sr-only">Predicted outcome</legend>
            <RadioGroup
              aria-label="Predicted outcome"
              value={choice ?? ""}
              onValueChange={(value) => {
                const outcome = REVIEW_OUTCOMES.find((o) => o.id === value);
                if (outcome) onChoose(outcome.id);
              }}
              className="gap-1"
            >
              {REVIEW_OUTCOMES.map((outcome) => {
                const id = `predict-${outcome.id}`;
                return (
                  <Label
                    key={outcome.id}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-2 py-2 text-[13px] font-normal hover:bg-muted/70 has-data-checked:border-sky-300 has-data-checked:bg-sky-50 has-data-checked:font-medium"
                  >
                    <RadioGroupItem id={id} value={outcome.id} />
                    {outcome.label}
                  </Label>
                );
              })}
            </RadioGroup>
          </fieldset>
          {error && (
            <Alert variant="destructive" className="mt-3">
              <AlertCircle />
              <AlertTitle>Prediction not recorded</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="py-3">
          <Button type="submit" className="w-full" disabled={disabled || submitting || choice === undefined}>
            {submitting && <Loader2 data-icon="inline-start" className="animate-spin" />}
            Lock in prediction
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Turns the browser's spoken coaching on or off (remembered on this device). Hidden where the browser cannot speak. */
function VoiceToggle({ voice, className = "" }: { voice: TutorVoice; className?: string }) {
  if (!voice.supported) return null;
  const label = voice.enabled ? "Turn spoken coaching off" : "Turn spoken coaching on";
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-pressed={voice.enabled}
      aria-label={label}
      title={label}
      onClick={voice.toggle}
      className={className}
      data-testid="voice-toggle"
    >
      {voice.enabled ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
    </Button>
  );
}

function RevealCard({ state, prediction, voice }: { state: TutorState; prediction: PredictionView; voice: TutorVoice }) {
  const model = revealCard(state, prediction);
  const key = revealKey(prediction.entryId);
  return (
    <Card
      className={`gap-0 py-0 shadow-xs ring-1 ${model.correct ? "ring-emerald-200" : "ring-amber-200"}`}
      role="region"
      aria-labelledby="reveal-title"
      data-testid="reveal-card"
    >
      <CardHeader className="border-b py-3!">
        <h2 id="reveal-title" className="flex items-center gap-2 text-sm font-semibold">
          {model.correct ? (
            <CheckCircle2 aria-hidden className="size-4 text-emerald-600" />
          ) : (
            <XCircle aria-hidden className="size-4 text-amber-600" />
          )}
          {model.verdict}
        </h2>
        <CardDescription className="text-xs">In the expert&rsquo;s words:</CardDescription>
        {voice.supported && (
          <CardAction className="flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Say it again"
              title={voice.held ? "Your voice coach is connected: it does the talking" : "Say it again"}
              disabled={voice.held || voice.speaking === key}
              onClick={() => voice.say(key, revealSpeech(model))}
            >
              <RotateCcw aria-hidden />
            </Button>
            <VoiceToggle voice={voice} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 py-3">
        {model.rules.map((rule) => (
          <RuleQuote key={rule.ruleId} rule={rule} />
        ))}
      </CardContent>
    </Card>
  );
}

function InterventionCard({
  state,
  intervention,
  voice,
  agentConnected,
}: {
  state: TutorState;
  intervention: InterventionView;
  voice: TutorVoice;
  agentConnected: boolean;
}) {
  const model = interventionCard(state, intervention);
  const speech = interventionSpeechLine(model.speech, intervention, {
    agentConnected,
    supported: voice.supported,
    enabled: voice.enabled,
    status: voice.status(interventionKey(intervention.questionId)),
  });
  return (
    <section
      role="alert"
      aria-labelledby="intervention-title"
      data-testid="intervention-card"
      className="grid gap-3 rounded-xl border border-red-200 bg-red-50/70 p-3"
    >
      <div className="flex items-start gap-2">
        <h2 id="intervention-title" className="flex flex-1 items-start gap-2 text-sm font-semibold text-red-900">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {model.headline}
        </h2>
        {!agentConnected && <VoiceToggle voice={voice} className="-mt-0.5 text-red-900/80 hover:text-red-900" />}
      </div>
      <p className="flex items-start gap-2 text-[12px] text-red-900/80" data-testid="intervention-speech">
        <Volume2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {speech}: <span className="italic">{model.spoken}</span>
        </span>
      </p>
      {model.rules.map((rule) => (
        <RuleQuote key={rule.ruleId} rule={rule} />
      ))}
      <p className="text-[11px] text-red-900/70">Save runs the same check: this outcome will be blocked.</p>
    </section>
  );
}

/**
 * The novice's review column for one case: at a decision node they have not mastered, the review
 * panel is replaced by the prediction prompt until they predict; then the reveal card (the expert's
 * rule, exact words and moment) sits above the review panel, and a stop-rule warning appears as soon
 * as a violating outcome is selected — before Save. The browser voice reads the reveal and the
 * warning aloud unless the tutor agent is connected (it speaks interventions itself, and the browser
 * never talks over it).
 */
export function NoviceReview({
  tutor,
  kycCase,
  outcome,
  riskRating,
  locked,
  agentConnected = false,
  children,
}: {
  tutor: Tutor;
  kycCase: KycCase;
  /** The outcome selected in the review panel (not yet saved). */
  outcome: ActionId | undefined;
  riskRating: RiskRating;
  locked: boolean;
  /** The ElevenLabs tutor agent is connected: it speaks the interventions, so the browser voice stays silent. */
  agentConnected?: boolean;
  /** The review panel. */
  children: ReactNode;
}) {
  const [predict, dispatch] = useReducer(predictReducer, INITIAL_PREDICT_STATE);
  const view = tutor.state?.cases.find((c) => c.caseId === kycCase.id);
  useEffect(() => dispatch({ type: "view", view }), [view]);

  // Spoken coaching. The hold comes first so a connected agent silences the voice before anything below speaks.
  const voice = useTutorVoice();
  useHoldTutorVoice(agentConnected);
  const { speakOnce, cancel } = voice;
  // This column belongs to one case: leaving it (another case opened) cuts off what is being said.
  useEffect(() => cancel, [cancel]);
  const state = tutor.state;
  const reviewing = state !== undefined && predict.phase !== "loading" && (decisionUnlocked(predict) || predict.phase !== "ask");
  const revealed = reviewing && predict.phase === "revealed" ? predict.prediction : undefined;
  const revealId = revealed?.entryId;
  const revealText = state && revealed ? revealSpeech(revealCard(state, revealed)) : undefined;
  useEffect(() => {
    if (revealId !== undefined && revealText !== undefined) speakOnce(revealKey(revealId), revealText);
  }, [revealId, revealText, speakOnce]);
  const intervention = reviewing ? activeIntervention(view, outcome) : undefined;
  const warningId = intervention?.questionId;
  const warningText = intervention ? interventionSpeech(intervention) : undefined;
  const agentSpokeIt = intervention?.speech === "spoken";
  useEffect(() => {
    if (warningId === undefined || warningText === undefined || agentConnected || agentSpokeIt) return;
    speakOnce(interventionKey(warningId), warningText);
  }, [warningId, warningText, agentConnected, agentSpokeIt, speakOnce]);

  const submit = () => {
    if (predict.phase !== "ask" || predict.choice === undefined || predict.submitting) return;
    dispatch({ type: "submit" });
    tutor.predict(kycCase.id, predict.choice, riskRating).then(
      (prediction) => dispatch({ type: "submitted", prediction }),
      (error: unknown) => dispatch({ type: "failed", message: describeError(error) }),
    );
  };

  // Without the tutor's view (loading, or unavailable: the side panel says why) the review panel works as usual.
  if (state === undefined || predict.phase === "loading") return children;
  if (!decisionUnlocked(predict) && predict.phase === "ask")
    return (
      <PredictionPrompt
        kycCase={kycCase}
        choice={predict.choice}
        submitting={predict.submitting}
        error={predict.error}
        disabled={locked}
        onChoose={(action) => dispatch({ type: "choose", action })}
        onSubmit={submit}
      />
    );
  return (
    <div className="grid gap-2">
      {predict.phase === "revealed" && <RevealCard state={state} prediction={predict.prediction} voice={voice} />}
      {predict.phase === "skip" && view?.prompt.ask === false && state.rules.length > 0 && (
        <p className="px-1 text-[11px] text-muted-foreground" data-testid="no-prediction-reason">
          Tutor: {predict.reason}
        </p>
      )}
      {intervention && <InterventionCard state={state} intervention={intervention} voice={voice} agentConnected={agentConnected} />}
      {children}
    </div>
  );
}
