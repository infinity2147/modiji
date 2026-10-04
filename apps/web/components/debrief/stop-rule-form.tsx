"use client";

/**
 * "Add a stop-rule" (plan §7.3, §7.7): a guardrail the expert states outright — "Never approve a
 * customer on a high-risk country list at desk level". The expert picks the conditions over the
 * domain's features, what the rule enforces (never allow an action, or require someone's sign-off
 * first), the moment of their capture it refers to, and types their exact words. The server converts
 * and type-checks the conditions, ties the words to a real redacted screen frame of that moment and
 * refuses without one; the confirmed rule then drives the Save interlock, the tutor's guardrail monitor
 * and the MCP `check_action` export.
 */
import { useId, useState } from "react";
import { APPROVAL_ROLES, type ApprovalRole, type LlmCondition } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { DebriefState, ExpertActionRequest, StopRuleConditions } from "@/lib/contracts/debrief";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuoteForm } from "./quote-form";
import { actionLabel } from "./witness-card";

type Row = { feature: string; op: LlmCondition["op"]; value: string };
type Enforce = "forbid" | "require_approval";

const OP_TEXT: Record<LlmCondition["op"], string> = { "==": "is", "!=": "is not", ">": "above", ">=": "at least", "<": "below", "<=": "at most" };
const SELECT = "rounded border bg-background px-1 py-0.5";
const EMPTY_ROW: Row = { feature: "", op: "==", value: "" };

function roleLabel(role: ApprovalRole): string {
  return role.replaceAll("_", " ");
}

/** A row as a parser-form condition, or undefined while incomplete; the server type-checks it again. */
function toCondition(row: Row): LlmCondition | undefined {
  const f = KYC_DOMAIN.features.find((x) => x.id === row.feature);
  if (f === undefined || row.value.trim() === "") return undefined;
  if (f.type === "number") {
    const n = Number(row.value);
    return Number.isFinite(n) ? { feature: f.id, op: row.op, value: n } : undefined;
  }
  if (f.type === "boolean") return { feature: f.id, op: row.op, value: row.value === "true" };
  return { feature: f.id, op: row.op, value: row.value };
}

export function StopRuleForm({ state, act }: { state: DebriefState; act: (body: ExpertActionRequest) => Promise<void> }) {
  const id = useId();
  const [familyId, setFamilyId] = useState(KYC_DOMAIN.decisionFamilies[0]?.id ?? "");
  const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === familyId);
  const [rows, setRows] = useState<Row[]>([EMPTY_ROW]);
  const [combinator, setCombinator] = useState<StopRuleConditions["combinator"]>("all");
  const [enforce, setEnforce] = useState<Enforce>("forbid");
  const [action, setAction] = useState("");
  const [role, setRole] = useState<ApprovalRole>(APPROVAL_ROLES[0]);
  const [moment, setMoment] = useState("");

  const conditions = rows.map(toCondition);
  const complete = conditions.every((c) => c !== undefined);
  const [first, ...rest] = conditions.filter((c): c is LlmCondition => c !== undefined);
  const chosen = family?.actions.find((a) => a === action);
  const noFrames = state.screenFrames === 0;
  const ready = complete && first !== undefined && chosen !== undefined && !noFrames;
  const update = (i: number, patch: Partial<Row>): void => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Card aria-label="Add a stop-rule" data-testid="stop-rule-form">
      <CardHeader>
        <CardTitle>Add a stop-rule</CardTitle>
        <p className="text-xs text-muted-foreground">
          A guardrail you state outright, e.g. “Never approve a customer on a high-risk country list at desk level.” It blocks Save, makes the tutor intervene and stops AI agents — with your exact words and the screen you were looking at.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {noFrames && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            No screen frames were recorded in this session. Share your screen during capture: every confirmed rule must show what you saw.
          </p>
        )}
        <fieldset className="space-y-2">
          <legend className="font-medium">When</legend>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Decision</span>
            <select aria-label="Decision family" className={SELECT} value={familyId} onChange={(e) => {
                setFamilyId(e.target.value);
                setAction("");
              }}>
              {KYC_DOMAIN.decisionFamilies.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {rows.map((row, i) => {
            const f = KYC_DOMAIN.features.find((x) => x.id === row.feature);
            const ops: LlmCondition["op"][] = f?.type === "number" ? [">", ">=", "<", "<=", "==", "!="] : ["==", "!="];
            const values = f?.type === "enum" ? f.values : f?.type === "boolean" ? ["true", "false"] : [];
            return (
              <div key={i} className="flex flex-wrap items-center gap-2" data-testid="stop-rule-condition">
                <select aria-label={`Condition ${i + 1} feature`} className={SELECT} value={row.feature} onChange={(e) => update(i, { feature: e.target.value, op: "==", value: "" })}>
                  <option value="">choose a field…</option>
                  {KYC_DOMAIN.features.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
                {f !== undefined && (
                  <>
                    <select aria-label={`Condition ${i + 1} operator`} className={SELECT} value={row.op} onChange={(e) => update(i, { op: ops.find((o) => o === e.target.value) ?? "==" })}>
                      {ops.map((o) => (
                        <option key={o} value={o}>
                          {OP_TEXT[o]}
                        </option>
                      ))}
                    </select>
                    {values.length > 0 ? (
                      <select aria-label={`Condition ${i + 1} value`} className={SELECT} value={row.value} onChange={(e) => update(i, { value: e.target.value })}>
                        <option value="">—</option>
                        {values.map((v) => (
                          <option key={v} value={v}>
                            {f.type === "boolean" ? (v === "true" ? "yes" : "no") : v.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input aria-label={`Condition ${i + 1} value`} type="number" className={`w-28 ${SELECT}`} value={row.value} onChange={(e) => update(i, { value: e.target.value })} />
                    )}
                  </>
                )}
                {rows.length > 1 && (
                  <Button type="button" variant="ghost" size="xs" onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="xs" onClick={() => setRows((all) => [...all, EMPTY_ROW])} disabled={rows.length >= 8}>
              Add condition
            </Button>
            {rows.length > 1 && (
              <label className="flex items-center gap-1">
                <select aria-label="Combine conditions" className={SELECT} value={combinator} onChange={(e) => setCombinator(e.target.value === "any" ? "any" : "all")}>
                  <option value="all">all must hold</option>
                  <option value="any">any one is enough</option>
                </select>
              </label>
            )}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="font-medium">Then</legend>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`${id}-enforce`} checked={enforce === "forbid"} onChange={() => setEnforce("forbid")} />
              Never allow
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`${id}-enforce`} checked={enforce === "require_approval"} onChange={() => setEnforce("require_approval")} />
              Requires sign-off before
            </label>
            <select aria-label="Action" className={SELECT} value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">choose an action…</option>
              {(family?.actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </select>
            {enforce === "require_approval" && (
              <label className="flex items-center gap-1">
                <span className="text-muted-foreground">by a</span>
                <select aria-label="Who signs off" className={SELECT} value={role} onChange={(e) => setRole(APPROVAL_ROLES.find((r) => r === e.target.value) ?? APPROVAL_ROLES[0])}>
                  {APPROVAL_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </fieldset>
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Screen moment</span>
          <select aria-label="Screen moment" className={SELECT} value={moment} onChange={(e) => setMoment(e.target.value)}>
            <option value="">end of capture (latest frame)</option>
            {state.decisions.map((d) => (
              <option key={d.entryId} value={d.entryId}>
                {d.caseId} — {d.actionLabel}
              </option>
            ))}
          </select>
        </label>
        <QuoteForm
          submitLabel="Confirm stop-rule"
          placeholder="e.g. Never approve a customer on a high-risk country list at desk level."
          disabled={!ready}
          onSubmit={async (quote) => {
            if (first === undefined || chosen === undefined) return;
            await act({
              action: "confirm_stop_rule",
              decisionFamily: familyId,
              when: { combinator, conditions: [first, ...rest] },
              effect: enforce === "forbid" ? { type: "forbid", action: chosen } : { type: "require_approval", role, action: chosen },
              ...(moment !== "" && { momentEntryId: moment }),
              quote,
            });
            setRows([EMPTY_ROW]);
            setAction("");
            setMoment("");
          }}
        />
      </CardContent>
    </Card>
  );
}
