"use client";

import { useEffect, useReducer, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, GraduationCap, Loader2, ShieldAlert, Volume2, XCircle } from "lucide-react";
import type { ActionId } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { describeError } from "@/lib/client/api";
import { REVIEW_OUTCOMES } from "@/lib/client/domain";
import type { RiskRating } from "@/lib/client/session-state";
import { INITIAL_PREDICT_STATE, decisionUnlocked, predictReducer } from "@/lib/client/tutor/predict-machine";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import { activeIntervention, interventionCard, revealCard } from "@/lib/client/tutor/view";
import type { InterventionView, PredictionView, TutorState } from "@/lib/contracts/tutor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RuleQuote } from "./rule-quote";

function PredictionPrompt({
  kycCase,
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
          Predict first: {kycCase.id} is decided by rules you have not mastered yet. Your answer is scored against the
          expert&rsquo;s confirmed rules, then revealed.
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

function RevealCard({ state, prediction }: { state: TutorState; prediction: PredictionView }) {
  const model = revealCard(state, prediction);
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
      </CardHeader>
      <CardContent className="grid gap-4 py-3">
        {model.rules.map((rule) => (
          <RuleQuote key={rule.ruleId} rule={rule} />
        ))}
      </CardContent>
    </Card>
  );
}

function InterventionCard({ state, intervention }: { state: TutorState; intervention: InterventionView }) {
  const model = interventionCard(state, intervention);
  return (
    <section
      role="alert"
      aria-labelledby="intervention-title"
      data-testid="intervention-card"
      className="grid gap-3 rounded-xl border border-red-200 bg-red-50/70 p-3"
    >
      <h2 id="intervention-title" className="flex items-start gap-2 text-sm font-semibold text-red-900">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        {model.headline}
      </h2>
      <p className="flex items-start gap-2 text-[12px] text-red-900/80">
        <Volume2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {model.speech}: <span className="italic">{model.spoken}</span>
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
 * as a violating outcome is selected — before Save.
 */
export function NoviceReview({
  tutor,
  kycCase,
  outcome,
  riskRating,
  locked,
  children,
}: {
  tutor: Tutor;
  kycCase: KycCase;
  /** The outcome selected in the review panel (not yet saved). */
  outcome: ActionId | undefined;
  riskRating: RiskRating;
  locked: boolean;
  /** The review panel. */
  children: ReactNode;
}) {
  const [predict, dispatch] = useReducer(predictReducer, INITIAL_PREDICT_STATE);
  const view = tutor.state?.cases.find((c) => c.caseId === kycCase.id);
  useEffect(() => dispatch({ type: "view", view }), [view]);

  const submit = () => {
    if (predict.phase !== "ask" || predict.choice === undefined || predict.submitting) return;
    dispatch({ type: "submit" });
    tutor.predict(kycCase.id, predict.choice, riskRating).then(
      (prediction) => dispatch({ type: "submitted", prediction }),
      (error: unknown) => dispatch({ type: "failed", message: describeError(error) }),
    );
  };

  const state = tutor.state;
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
  const intervention = activeIntervention(view, outcome);
  return (
    <div className="grid gap-2">
      {predict.phase === "revealed" && <RevealCard state={state} prediction={predict.prediction} />}
      {predict.phase === "skip" && view?.prompt.ask === false && (
        <p className="px-1 text-[11px] text-muted-foreground" data-testid="no-prediction-reason">
          Tutor: {predict.reason}
        </p>
      )}
      {intervention && <InterventionCard state={state} intervention={intervention} />}
      {children}
    </div>
  );
}
