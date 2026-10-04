"use client";

/**
 * The confirmed rulebook with the last change animated (plan §7.5 #4: "diff animates, revision++").
 * A rule can be corrected here: its numeric thresholds edited, with the expert's words. When a
 * teach-back is awaiting confirmation, the correction is recorded as a teach-back correction and a
 * new teach-back is written.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PredicateSchema, type ComparisonOp, type Predicate } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { DebriefState, ExpertActionRequest, RuleChange, RuleView } from "@/lib/contracts/debrief";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TraceButton } from "@/components/lineage/lineage-trace";
import { addCondition, numericComparisons, replaceComparison } from "@/lib/debrief-predicate-edit";
import { QuoteForm } from "./quote-form";

const OPS: ComparisonOp[] = [">", ">=", "<", "<="];
const OP_TEXT: Record<string, string> = { ">": "above", ">=": "at least", "<": "below", "<=": "at most" };

export function RulebookPanel({ state, act }: { state: DebriefState; act: (body: ExpertActionRequest) => Promise<void> }) {
  const teachBackId = state.teachBack !== null && state.teachBack.current && state.teachBack.confirmedEntryId === null ? state.teachBack.entryId : undefined;
  return (
    <Card aria-label="Confirmed rulebook">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Confirmed rulebook
          <motion.span key={state.rulebookRevision} initial={{ scale: 1.6, color: "#2563eb" }} animate={{ scale: 1, color: "inherit" }} className="font-mono text-sm" data-testid="rulebook-revision">
            revision {state.rulebookRevision}
          </motion.span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <AnimatePresence mode="popLayout">{state.lastChange !== null && <ChangeCard key={state.lastChange.rulebookRevision} change={state.lastChange} />}</AnimatePresence>
        {state.rules.length === 0 && <p className="text-muted-foreground">No confirmed rules yet. Confirm a proposed rule below.</p>}
        <ul className="space-y-2">
          {state.rules.map((r) => (
            <RuleRow key={r.rule.id} view={r} changed={state.lastChange?.ruleId === r.rule.id} teachBackId={teachBackId} act={act} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ChangeCard({ change }: { change: RuleChange }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -10, backgroundColor: "rgba(250, 204, 21, 0.35)" }}
      animate={{ opacity: 1, y: 0, backgroundColor: "rgba(250, 204, 21, 0.08)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8 }}
      className="rounded-lg border p-3 text-sm"
      data-testid="rule-diff"
    >
      <p className="font-medium">
        Revision {change.rulebookRevision}: rule {change.kind}
        {change.fields.length > 0 && <span className="text-muted-foreground"> · {change.fields.filter((f) => f !== "evidence" && f !== "confirmedBy" && f !== "revision").join(", ")}</span>}
      </p>
      {change.before !== null && (
        <motion.p initial={{ opacity: 1 }} animate={{ opacity: 0.6 }} transition={{ delay: 0.4 }} className="text-red-700 line-through">
          When {change.before.when}: {change.before.then}
          {change.before.overrides.length > 0 && ` (overrides ${change.before.overrides.length})`}
        </motion.p>
      )}
      {change.after !== null && (
        <motion.p initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.6 }} className="text-emerald-800">
          When {change.after.when}: {change.after.then}
          {change.after.overrides.length > 0 && ` (overrides ${change.after.overrides.length})`}
        </motion.p>
      )}
      {change.reason !== null && <p className="mt-1 text-xs text-muted-foreground">{change.reason}</p>}
    </motion.div>
  );
}

function RuleRow({ view, changed, teachBackId, act }: { view: RuleView; changed: boolean; teachBackId: string | undefined; act: (body: ExpertActionRequest) => Promise<void> }) {
  const { rule } = view;
  const quote = rule.evidence.find((e) => e.kind === "expert_quote");
  const [editing, setEditing] = useState(false);
  const comparisons = numericComparisons(rule.predicate);
  const [edits, setEdits] = useState(() => comparisons.map((c) => ({ op: c.op, value: c.value })));
  const [extra, setExtra] = useState<Predicate | null>(null);
  const [deleting, setDeleting] = useState(false);
  return (
    <motion.li layout className={`rounded-lg border p-3 ${changed ? "border-amber-400" : ""}`} data-testid="rule" data-rule-id={rule.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={rule.kind === "guardrail" ? "destructive" : "secondary"}>{rule.kind}</Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {rule.id} · r{rule.revision} · priority {rule.priority}
        </span>
        <span className="text-xs text-muted-foreground">explains {view.explains} decision(s)</span>
        <TraceButton entryId={view.entryId} label={`rule ${rule.id}`} className="ml-auto" />
      </div>
      <p className="mt-1">
        <span className="text-muted-foreground">When</span> {view.when} <span className="text-muted-foreground">→</span> <strong>{view.then}</strong>
      </p>
      {quote?.kind === "expert_quote" && (
        <blockquote className="mt-1 border-l-2 pl-2 text-sm text-muted-foreground italic">
          “{quote.exactQuote}” <span className="not-italic">({quote.provenance === "human_voice" ? "spoken" : "typed"})</span>
        </blockquote>
      )}
      {!editing && !deleting && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="xs" onClick={() => setEditing(true)}>
            Correct this rule
          </Button>
          <Button type="button" variant="destructive" size="xs" onClick={() => setDeleting(true)}>
            Delete rule
          </Button>
        </div>
      )}
      {deleting && (
        <div className="mt-2 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2" role="group" aria-label={`Delete rule ${rule.id}`}>
          <p className="text-sm">
            Delete this rule from the confirmed rulebook? Say why in your own words: your reason is kept in the audit trail.
          </p>
          <QuoteForm
            submitLabel="Delete rule"
            placeholder="e.g. This rule is wrong — we never auto-approve on that basis."
            onSubmit={async (q) => {
              await act({ action: "retire_rule", ruleId: rule.id, quote: q });
              setDeleting(false);
            }}
          />
          <Button type="button" variant="ghost" size="xs" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
        </div>
      )}
      {editing && (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <QuoteForm
            submitLabel={teachBackId === undefined ? "Revise rule" : "Correct teach-back"}
            placeholder="e.g. No — at exactly a quarter we already ask for documents."
            onSubmit={async (q) => {
              const edited = comparisons.reduce((p, c, i) => replaceComparison(p, c.path, edits[i]?.op ?? c.op, edits[i]?.value ?? c.value), rule.predicate);
              const predicate = extra === null ? edited : addCondition(edited, extra);
              await act({ action: "revise_rule", ruleId: rule.id, predicate, quote: q, ...(teachBackId !== undefined && { teachBackId }) });
              setEditing(false);
            }}
          >
            {comparisons.map((c, i) => (
              <div key={c.path.join(".")} className="flex items-center gap-2 text-sm">
                <span className="font-mono">{c.feature}</span>
                <select
                  aria-label={`Operator for ${c.feature}`}
                  className="rounded border bg-background px-1 py-0.5"
                  value={edits[i]?.op ?? c.op}
                  onChange={(e) => {
                    const op = OPS.find((o) => o === e.target.value);
                    if (op !== undefined) setEdits((all) => all.map((x, j) => (j === i ? { ...x, op } : x)));
                  }}
                >
                  {OPS.map((op) => (
                    <option key={op} value={op}>
                      {OP_TEXT[op]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Threshold for ${c.feature}`}
                  type="number"
                  className="w-24 rounded border bg-background px-1 py-0.5"
                  value={edits[i]?.value ?? c.value}
                  onChange={(e) => setEdits((all) => all.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))}
                />
              </div>
            ))}
            <ConditionBuilder onChange={setExtra} />
          </QuoteForm>
        </div>
      )}
    </motion.li>
  );
}

/** "Only when …": one extra condition on a domain feature, validated as a predicate before it is offered. */
function ConditionBuilder({ onChange }: { onChange: (p: Predicate | null) => void }) {
  const [feature, setFeature] = useState("");
  const [op, setOp] = useState("==");
  const [value, setValue] = useState("");
  const f = KYC_DOMAIN.features.find((x) => x.id === feature);
  const ops = f?.type === "number" ? [">", ">=", "<", "<=", "=="] : ["==", "!="];
  const values = f?.type === "enum" ? f.values : f?.type === "boolean" ? ["true", "false"] : [];
  const update = (next: { feature?: string; op?: string; value?: string }): void => {
    const nf = next.feature ?? feature;
    const no = next.op ?? op;
    const nv = next.value ?? value;
    setFeature(nf);
    setOp(no);
    setValue(nv);
    const def = KYC_DOMAIN.features.find((x) => x.id === nf);
    const literal = def?.type === "number" ? (nv.trim() === "" ? undefined : Number(nv)) : def?.type === "boolean" ? (nv === "" ? undefined : nv === "true") : nv === "" ? undefined : nv;
    const parsed = literal === undefined ? undefined : PredicateSchema.safeParse({ [no]: [{ var: nf }, literal] });
    onChange(parsed?.success === true ? parsed.data : null);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Only when">
      <span className="text-muted-foreground">Only when</span>
      <select aria-label="Condition feature" className="rounded border bg-background px-1 py-0.5" value={feature} onChange={(e) => update({ feature: e.target.value, op: "==", value: "" })}>
        <option value="">(no extra condition)</option>
        {KYC_DOMAIN.features.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {f !== undefined && (
        <>
          <select aria-label="Condition operator" className="rounded border bg-background px-1 py-0.5" value={op} onChange={(e) => update({ op: e.target.value })}>
            {ops.map((o) => (
              <option key={o} value={o}>
                {OP_TEXT[o] ?? (o === "==" ? "is" : "is not")}
              </option>
            ))}
          </select>
          {values.length > 0 ? (
            <select aria-label="Condition value" className="rounded border bg-background px-1 py-0.5" value={value} onChange={(e) => update({ value: e.target.value })}>
              <option value="">—</option>
              {values.map((v) => (
                <option key={v} value={v}>
                  {v.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label="Condition value" type="number" className="w-24 rounded border bg-background px-1 py-0.5" value={value} onChange={(e) => update({ value: e.target.value })} />
          )}
        </>
      )}
    </div>
  );
}
