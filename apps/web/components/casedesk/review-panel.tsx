"use client";

import { motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import type { ActionId } from "@vashistha/core";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { REVIEW_OUTCOMES, RISK_RATINGS, actionLabel, riskRatingLabel } from "@/lib/client/domain";
import { shortId } from "@/lib/client/format";
import type { DecisionRecord, RiskRating } from "@/lib/client/session-state";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Draft, SaveState } from "./use-workspace";

const DECISION_TEXT = {
  allow: "Allowed — no confirmed rule objected",
  forbid: "Forbidden",
  needs_approval: "Needed approval",
  insufficient_information: "Insufficient information",
} as const;

function DecisionSummary({ decision, fresh }: { decision: DecisionRecord; fresh: boolean }) {
  return (
    <motion.div
      initial={fresh ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="grid gap-3"
    >
      <p role="status" className="flex items-center gap-2 text-sm font-medium text-emerald-700">
        <CheckCircle2 aria-hidden className="size-4" />
        Decision committed
      </p>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className="font-medium">{actionLabel(decision.action)}</dd>
        <dt className="text-muted-foreground">Risk rating</dt>
        <dd className="font-medium">{decision.riskRating === undefined ? "—" : riskRatingLabel(decision.riskRating)}</dd>
        <dt className="text-muted-foreground">Interlock</dt>
        <dd>
          {DECISION_TEXT[decision.result.decision]}
          {decision.result.matchedRules.length > 0 && (
            <span className="text-muted-foreground"> · {decision.result.matchedRules.length} rule(s) matched</span>
          )}
        </dd>
        {decision.override && (
          <>
            <dt className="text-muted-foreground">{decision.override.kind === "escalated" ? "Escalated" : "Acknowledged"}</dt>
            <dd className="italic">“{decision.override.note}”</dd>
          </>
        )}
        <dt className="text-muted-foreground">Ledger entry</dt>
        <dd className="font-mono text-xs" title={decision.decisionId}>
          {shortId(decision.decisionId)}
        </dd>
      </dl>
    </motion.div>
  );
}

export function ReviewPanel({
  kycCase,
  draft,
  decision,
  fresh,
  saveState,
  locked,
  onRiskRating,
  onOutcome,
  onSave,
}: {
  kycCase: KycCase;
  draft: Draft;
  decision: DecisionRecord | undefined;
  /** Committed in this page view: animate the summary in. */
  fresh: boolean;
  saveState: SaveState;
  /** Saving is impossible (the event channel stopped). */
  locked: boolean;
  onRiskRating: (rating: RiskRating) => void;
  onOutcome: (action: ActionId) => void;
  onSave: () => void;
}) {
  const saving = saveState.status === "saving" && saveState.caseId === kycCase.id;
  const inert = saving || locked;
  const error = saveState.status === "error" && saveState.caseId === kycCase.id ? saveState.message : undefined;

  return (
    <Card className="gap-0 py-0 shadow-xs" role="region" aria-labelledby="review-title">
      <CardHeader className="border-b py-3!">
        <h2 id="review-title" className="font-heading leading-snug text-sm font-semibold">Review</h2>
        <CardDescription className="font-mono text-xs">{kycCase.id}</CardDescription>
      </CardHeader>

      {decision ? (
        <CardContent className="py-4">
          <DecisionSummary decision={decision} fresh={fresh} />
        </CardContent>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <CardContent className="grid gap-5 py-4">
            <div className="grid gap-2">
              <Label htmlFor="risk-rating">Risk rating</Label>
              <Select
                value={draft.riskRating}
                onValueChange={(value) => {
                  const rating = RISK_RATINGS.find((r) => r === value);
                  if (rating) onRiskRating(rating);
                }}
                disabled={inert}
              >
                <SelectTrigger id="risk-rating" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {RISK_RATINGS.map((rating) => (
                    <SelectItem key={rating} value={rating}>
                      {riskRatingLabel(rating)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <fieldset className="grid gap-2" disabled={inert}>
              <legend className="mb-2 text-sm font-medium">Outcome</legend>
              <RadioGroup
                aria-label="Outcome"
                value={draft.outcome ?? ""}
                onValueChange={(value) => {
                  const outcome = REVIEW_OUTCOMES.find((o) => o.id === value);
                  if (outcome) onOutcome(outcome.id);
                }}
                className="gap-1"
              >
                {REVIEW_OUTCOMES.map((outcome) => {
                  const id = `outcome-${outcome.id}`;
                  return (
                    <Label
                      key={outcome.id}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-2 py-2 text-[13px] font-normal transition-colors hover:bg-muted/70 has-data-checked:border-primary/40 has-data-checked:bg-accent has-data-checked:font-medium"
                    >
                      <RadioGroupItem id={id} value={outcome.id} />
                      {outcome.label}
                    </Label>
                  );
                })}
              </RadioGroup>
            </fieldset>

            {error && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Save failed — nothing was committed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
                <AlertAction>
                  <Button type="submit" size="xs" variant="outline">
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="grid gap-2 py-3">
            <Button type="submit" disabled={inert || draft.outcome === undefined} className="w-full">
              {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ShieldCheck data-icon="inline-start" />}
              {saving ? "Checking interlock…" : "Save decision"}
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Save runs the deterministic interlock against the confirmed rulebook before anything is committed.
            </p>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
