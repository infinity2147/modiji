"use client";

import { motion } from "framer-motion";
import { Hourglass } from "lucide-react";
import type { HudRow, HudStatus } from "@vashistha/core";
import type { GateSnapshot } from "@/lib/client/gate/gate-session";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<HudStatus, string> = {
  LISTENING: "bg-slate-800 text-slate-100",
  WAITING: "bg-amber-500 text-amber-950",
  ASKING: "bg-emerald-600 text-white",
};

function ConditionChip({ row }: { row: HudRow }) {
  return (
    <li
      aria-label={`${row.label}: ${row.ok ? "clear" : row.text}`}
      className={cn(
        "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap tabular-nums transition-colors duration-300",
        row.ok ? "text-emerald-300" : "bg-amber-400/15 text-amber-200",
      )}
    >
      <span className="text-slate-300">{row.label}</span>
      {!row.ok && <Hourglass aria-hidden className="size-3" />}
      <span>{row.ok ? "✓" : row.text}</span>
    </li>
  );
}

/**
 * The judge HUD (plan §7.2): the gate's status, its three judge-facing conditions, the top question's
 * value and the reason line — a pure rendering of the core `hudModel` over the live gate evaluation.
 */
export function HudBar({ gate, voiceLive }: { gate: GateSnapshot | null; voiceLive: boolean }) {
  if (!gate) {
    return (
      <div className="flex h-11 items-center px-4 text-xs text-slate-400" role="status">
        Starting the speech gate…
      </div>
    );
  }
  const { hud } = gate;
  const queued = gate.queue.length;
  // With no live conversation the queue is not offered to the gate (nobody could hear a question).
  const reason =
    !voiceLive && queued > 0 && !gate.offRecord
      ? `${queued} question${queued === 1 ? "" : "s"} queued · voice not connected, nothing will be asked`
      : hud.reason;

  return (
    <section aria-label="Speech gate" className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-slate-100">
      <motion.span
        key={hud.status}
        role="status"
        aria-label={`Gate status: ${hud.status}`}
        initial={{ opacity: 0.4, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        className={cn("rounded px-2 py-0.5 font-mono text-xs font-semibold tracking-wider", STATUS_STYLE[hud.status])}
      >
        {hud.status}
      </motion.span>
      <ul aria-label="Gate conditions" className="flex items-center gap-1">
        {hud.judge.map((row) => (
          <ConditionChip key={row.key} row={row} />
        ))}
      </ul>
      <div className="flex items-center gap-2 text-xs" aria-label="Question value">
        <span className="text-slate-300">Question value</span>
        <span aria-hidden className="relative h-2 w-24 overflow-hidden rounded-full bg-slate-700">
          <motion.span
            className="absolute inset-y-0 left-0 rounded-full bg-sky-400"
            animate={{ width: `${(hud.value?.level ?? 0) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </span>
        <span className="font-mono tabular-nums">{hud.value?.text ?? "—"}</span>
      </div>
      <p className="min-w-0 flex-1 truncate text-xs text-slate-300" title={reason}>
        <span className="text-slate-400">Reason: </span>
        {reason}
      </p>
    </section>
  );
}
