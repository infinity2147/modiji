"use client";

/**
 * A solver witness as the expert sees it: the case in domain words, the debrief question queued for
 * the interviewer, its status, and — for when voice is not used — the explicit answers, each with the
 * expert's own words.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { ActionIdSchema } from "@vashistha/core";
import type { DebriefState, ExpertActionRequest, WitnessStatus, WitnessView } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TraceButton } from "@/components/lineage/lineage-trace";
import { numericComparisons, replaceComparison } from "@/lib/debrief-predicate-edit";
import { QuoteForm } from "./quote-form";
import { witnessTarget } from "@/lib/client/voice/question-cues";

const KIND_LABEL = { unresolved: "No rule decides", conflict: "Rules conflict", boundary: "Threshold check", disagreement: "Experts disagree" } as const;
const STATUS_VARIANT: Record<WitnessStatus, "default" | "secondary" | "outline" | "destructive"> = {
  open: "destructive",
  queued: "default",
  asked: "default",
  resolved: "secondary",
  acknowledged: "secondary",
  confirmed: "secondary",
  superseded: "outline",
};

export function actionLabel(id: string): string {
  return KYC_DOMAIN.actions.find((a) => a.id === id)?.label ?? id;
}

const FLIP: Record<string, ">" | ">=" | "<" | "<="> = { ">": ">=", ">=": ">", "<": "<=", "<=": "<" };

export function WitnessCard({ view, state, act }: { view: WitnessView; state: DebriefState; act: (body: ExpertActionRequest) => Promise<void> }) {
  const w = view.witness;
  const actionable = view.current && (view.status === "open" || view.status === "queued" || view.status === "asked");
  return (
    <motion.li layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} data-testid="witness" data-kind={w.kind} data-status={view.status} {...witnessTarget(w.id)}>
      <Card size="sm" className={actionable ? "" : "opacity-75"}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={w.kind === "boundary" ? "outline" : "destructive"}>{KIND_LABEL[w.kind]}</Badge>
            <Badge variant={STATUS_VARIANT[view.status]}>{view.status === "acknowledged" ? "expert: escalate to controller" : view.status}</Badge>
            <span className="font-mono text-[0.7rem] text-muted-foreground">{w.id}</span>
            <TraceButton entryId={view.foundEntryId} label={`witness ${w.kind}`} className="ml-auto" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {view.question !== null && (
            <p className="rounded-md bg-accent px-2 py-1.5 font-medium" data-testid="witness-question">
              “{view.question.text}”
            </p>
          )}
          {view.conditions.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {view.conditions.map((c) => (
                <li key={c} className="rounded border px-1.5 py-0.5 text-xs">
                  {c}
                </li>
              ))}
            </ul>
          )}
          {w.kind === "conflict" && <p className="text-xs text-muted-foreground">Equal priority, no override: {w.actions.map(actionLabel).join(" vs ")}.</p>}
          {view.resolution !== null && <p className="text-xs text-muted-foreground">Resolution: {view.resolution.resolution.replaceAll("_", " ")}</p>}
          {actionable && <Answers view={view} state={state} act={act} />}
        </CardContent>
      </Card>
    </motion.li>
  );
}

function Answers({ view, state, act }: { view: WitnessView; state: DebriefState; act: (body: ExpertActionRequest) => Promise<void> }) {
  const w = view.witness;
  const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === w.decisionFamily);
  const [decision, setDecision] = useState<string>(view.suggestedAction ?? family?.actions[0] ?? "");
  const [winner, setWinner] = useState(0);

  if (w.kind === "unresolved")
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {view.cellRule !== null && (
          <QuoteForm
            submitLabel="Add rule for these cases"
            placeholder="e.g. Small verified owner — that's a straight approval."
            onSubmit={(quote) => act({ action: "add_rule_for_witness", witnessId: w.id, decision: ActionIdSchema.parse(decision), quote })}
          >
            <label className="block text-xs text-muted-foreground">
              Decision for: {view.cellRule.text}
              <select aria-label="Decision" className="mt-1 block w-full rounded border bg-background px-1 py-1 text-sm text-foreground" value={decision} onChange={(e) => setDecision(e.target.value)}>
                {family?.actions.map((a) => (
                  <option key={a} value={a}>
                    {actionLabel(a)}
                  </option>
                ))}
              </select>
            </label>
          </QuoteForm>
        )}
        <Acknowledge witnessId={w.id} act={act} />
      </div>
    );

  if (w.kind === "conflict") {
    const [a, b] = w.ruleIds;
    const win = winner === 0 ? a : b;
    const lose = winner === 0 ? b : a;
    const winnerRule = state.rules.find((r) => r.rule.id === win)?.rule;
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <QuoteForm
          submitLabel="This one applies"
          placeholder="e.g. Documents first — the PEP review comes after."
          disabled={winnerRule === undefined}
          onSubmit={(quote) => act({ action: "revise_rule", ruleId: win, overrides: [...(winnerRule?.overrides ?? []), lose], witnessId: w.id, quote })}
        >
          <fieldset className="space-y-1 text-sm">
            {w.actions.map((x, i) => (
              <label key={x} className="flex items-center gap-2">
                <input type="radio" name={`winner-${w.id}`} checked={winner === i} onChange={() => setWinner(i)} />
                {actionLabel(x)}
              </label>
            ))}
          </fieldset>
        </QuoteForm>
        <Acknowledge witnessId={w.id} act={act} />
      </div>
    );
  }

  if (w.kind === "boundary") {
    const rule = state.rules.find((r) => r.rule.id === w.ruleId)?.rule;
    const atom = rule === undefined ? undefined : numericComparisons(rule.predicate).find((c) => c.feature === w.feature && c.value === w.threshold);
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <QuoteForm submitLabel="Rule is right at the threshold" placeholder="e.g. Yes, exactly 25% is still fine." onSubmit={(quote) => act({ action: "confirm_boundary", witnessId: w.id, quote })} />
        {rule !== undefined && atom !== undefined && (
          <QuoteForm
            submitLabel={atom.op === ">" || atom.op === "<" ? "Include the threshold" : "Exclude the threshold"}
            placeholder="e.g. No — at exactly 25% we already ask for documents."
            onSubmit={(quote) =>
              act({ action: "revise_rule", ruleId: rule.id, predicate: replaceComparison(rule.predicate, atom.path, FLIP[atom.op] ?? atom.op, atom.value), witnessId: w.id, quote })
            }
          />
        )}
      </div>
    );
  }
  return null;
}

function Acknowledge({ witnessId, act }: { witnessId: string; act: (body: ExpertActionRequest) => Promise<void> }) {
  return (
    <QuoteForm
      submitLabel="Escalate to controller"
      placeholder="e.g. That one isn't mine to decide — escalate to the controller."
      onSubmit={(quote) => act({ action: "acknowledge_witness", witnessId, resolution: "escalate_to_controller", quote })}
    />
  );
}
