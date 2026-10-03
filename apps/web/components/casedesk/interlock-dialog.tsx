"use client";

import { useState } from "react";
import { AlertCircle, Ban, Loader2, Quote, ShieldAlert } from "lucide-react";
import type { ExpertQuoteEvidence, GuardrailResult } from "@vashistha/core";
import { actionLabel, featureLabel } from "@/lib/client/domain";
import { formatTimestamp } from "@/lib/client/format";
import type { DecisionOverride } from "@/lib/client/session-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { InterlockPromptState } from "./use-workspace";

const NOTE_MAX = 500;

function EvidenceQuote({ evidence }: { evidence: ExpertQuoteEvidence }) {
  return (
    <figure className="grid gap-1.5 rounded-md border bg-muted/40 p-3">
      <blockquote className="flex gap-2 text-[13px] leading-relaxed">
        <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-medium text-foreground">“{evidence.exactQuote}”</p>
      </blockquote>
      <figcaption className="pl-5.5 text-[11px] text-muted-foreground tabular-nums">
        Expert, {evidence.provenance === "human_voice" ? "spoken" : "typed"} ·{" "}
        <time>
          {formatTimestamp(evidence.t0Ms)}–{formatTimestamp(evidence.t1Ms)}
        </time>{" "}
        · {evidence.relation === "supports" ? "supports the rule" : "contradicts the rule"}
      </figcaption>
    </figure>
  );
}

function ResultDetails({ result }: { result: GuardrailResult }) {
  return (
    <div className="grid gap-4">
      {result.missingFeatures.length > 0 && (
        <section aria-labelledby="missing-heading" className="grid gap-1.5">
          <h3 id="missing-heading" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Missing information
          </h3>
          <ul className="list-inside list-disc text-[13px]">
            {result.missingFeatures.map((feature) => (
              <li key={feature}>{featureLabel(feature)}</li>
            ))}
          </ul>
        </section>
      )}
      {result.matchedRules.length > 0 && (
        <section aria-labelledby="rules-heading" className="grid gap-1.5">
          <h3 id="rules-heading" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Matched rules
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            {result.matchedRules.map((rule) => (
              <li key={rule} className="rounded border bg-card px-1.5 py-0.5 font-mono text-[11px]">
                {rule}
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.evidence.length > 0 && (
        <section aria-labelledby="evidence-heading" className="grid gap-1.5">
          <h3 id="evidence-heading" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Expert evidence
          </h3>
          <div className="grid gap-2">
            {result.evidence.map((evidence) => (
              <EvidenceQuote key={`${evidence.utteranceId}-${evidence.t0Ms}`} evidence={evidence} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const TITLES = {
  forbid: "Blocked by a confirmed guardrail",
  needs_approval: "Approval required",
  insufficient_information: "Insufficient information",
  allow: "Allowed",
} as const;

function OverrideForm({
  prompt,
  onResolve,
  onCancel,
}: {
  prompt: InterlockPromptState;
  onResolve: (override: DecisionOverride) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  const submit = (kind: DecisionOverride["kind"]) => {
    if (trimmed !== "") onResolve({ kind, note: trimmed });
  };
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit("acknowledged");
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="override-note">Note (required)</Label>
        <Textarea
          id="override-note"
          required
          maxLength={NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={prompt.submitting}
          placeholder="Why you are committing anyway, or what the reviewer should check"
          className="min-h-20"
        />
      </div>
      {prompt.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Commit failed — nothing was committed</AlertTitle>
          <AlertDescription>{prompt.error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={prompt.submitting}>
          Cancel
        </Button>
        <Button type="button" variant="outline" disabled={trimmed === "" || prompt.submitting} onClick={() => submit("escalated")}>
          Escalate
        </Button>
        <Button type="submit" disabled={trimmed === "" || prompt.submitting}>
          {prompt.submitting && <Loader2 data-icon="inline-start" className="animate-spin" />}
          Acknowledge and commit
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Renders the server's interlock result. A `forbid` offers no way to commit. */
export function InterlockDialog({
  prompt,
  onResolve,
  onDismiss,
}: {
  prompt: InterlockPromptState | undefined;
  onResolve: (override: DecisionOverride) => void;
  onDismiss: () => void;
}) {
  const decision = prompt?.result.decision ?? "forbid";
  const blocked = prompt?.kind === "blocked";
  return (
    <Dialog open={prompt !== undefined} onOpenChange={(open) => !open && onDismiss()}>
      {prompt && (
        <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-xl" showCloseButton={!prompt.submitting}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              {blocked ? (
                <Ban aria-hidden className="size-4.5 text-destructive" />
              ) : (
                <ShieldAlert aria-hidden className="size-4.5 text-amber-600" />
              )}
              {TITLES[decision]}
            </DialogTitle>
            <DialogDescription>
              {blocked ? (
                <>
                  The Save interlock forbids <strong className="text-foreground">{actionLabel(prompt.request.action)}</strong> for{" "}
                  <span className="font-mono">{prompt.request.caseId}</span>. Nothing was committed.
                </>
              ) : (
                <>
                  <strong className="text-foreground">{actionLabel(prompt.request.action)}</strong> for{" "}
                  <span className="font-mono">{prompt.request.caseId}</span> can only be committed with an
                  acknowledgement or an escalation. Both are recorded with your note.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <ResultDetails result={prompt.result} />

          {blocked ? (
            <DialogFooter>
              <Button type="button" onClick={onDismiss}>
                Return to case
              </Button>
            </DialogFooter>
          ) : (
            <OverrideForm key={prompt.checkId} prompt={prompt} onResolve={onResolve} onCancel={onDismiss} />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
