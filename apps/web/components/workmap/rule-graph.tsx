"use client";

/**
 * The confirmed rulebook as a graph: one column per decision family, rules by priority (highest
 * first), guardrails marked, and the explicit override edges between them. Click a rule to trace it.
 */
import { motion } from "framer-motion";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { ConfirmedRule } from "@vashistha/core";
import type { WorkMapResponse } from "@/lib/contracts/debrief";

const COL_W = 300;
const NODE_W = 260;
const NODE_H = 58;
const GAP = 22;
const TOP = 34;

function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
}

export function RuleGraph({ rules, text, onTrace }: { rules: readonly ConfirmedRule[]; text: WorkMapResponse["ruleText"]; onTrace: (rule: ConfirmedRule) => void }) {
  const families = KYC_DOMAIN.decisionFamilies.filter((f) => rules.some((r) => r.decisionFamily === f.id));
  const pos = new Map<string, { x: number; y: number }>();
  families.forEach((f, col) =>
    rules
      .filter((r) => r.decisionFamily === f.id)
      .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
      .forEach((r, row) => pos.set(r.id, { x: 20 + col * COL_W, y: TOP + row * (NODE_H + GAP) })),
  );
  const height = Math.max(...[...pos.values()].map((p) => p.y + NODE_H + 20), 120);
  const width = Math.max(families.length * COL_W + 20, 320);
  const edges = rules.flatMap((r) => r.overrides.flatMap((o) => (pos.has(o) && pos.has(r.id) ? [{ from: r.id, to: o }] : [])));
  if (rules.length === 0) return <p className="text-muted-foreground">No confirmed rules.</p>;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Rule graph" data-testid="rule-graph">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {families.map((f, col) => (
        <text key={f.id} x={20 + col * COL_W} y={18} className="fill-muted-foreground text-[12px] font-semibold uppercase">
          {f.label}
        </text>
      ))}
      {edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (a === undefined || b === undefined) return null;
        const x1 = a.x + NODE_W;
        const x2 = b.x + NODE_W;
        const bend = Math.max(x1, x2) + 30;
        return (
          <motion.path
            key={`${e.from}-${e.to}`}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.8 }}
            d={`M ${x1} ${a.y + NODE_H / 2} C ${bend} ${a.y + NODE_H / 2}, ${bend} ${b.y + NODE_H / 2}, ${x2} ${b.y + NODE_H / 2}`}
            fill="none"
            stroke="currentColor"
            className="text-amber-600"
            strokeDasharray="4 3"
            markerEnd="url(#arrow)"
          >
            <title>overrides</title>
          </motion.path>
        );
      })}
      {rules.map((r) => {
        const p = pos.get(r.id);
        if (p === undefined) return null;
        const t = text[r.id];
        const guard = r.effect.type === "forbid" || r.effect.type === "require_approval";
        return (
          <g key={r.id} transform={`translate(${p.x}, ${p.y})`} onClick={() => onTrace(r)} className="cursor-pointer" role="button" aria-label={`Rule ${r.id}`} data-rule-id={r.id}>
            <rect width={NODE_W} height={NODE_H} rx={8} className={guard ? "fill-red-50 stroke-red-400" : "fill-card stroke-border"} strokeWidth={1.5} />
            <text x={10} y={20} className="fill-foreground text-[12px] font-medium">
              {clip(t?.then ?? r.id, 36)} · p{r.priority}
            </text>
            <text x={10} y={40} className="fill-muted-foreground text-[11px]">
              {clip(`when ${t?.when ?? ""}`, 44)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
