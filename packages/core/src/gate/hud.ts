import {
  CONDITION_KEYS,
  CONDITION_LABELS,
  describeQuestion,
  formatWait,
  type ConditionKey,
  type GateEvaluation,
} from "./evaluate";

export type HudStatus = "LISTENING" | "WAITING" | "ASKING";

export type HudRow = { key: ConditionKey; label: string; ok: boolean; /** "✓", "wait 0.8 s" or "wait" */ text: string };

export type HudModel = {
  status: HudStatus;
  /** The three judge-view rows, in plan order: Typing · Speaking · Screen moving. */
  judge: HudRow[];
  /** Every condition (Engineering view). */
  rows: HudRow[];
  /** The question's value on a 0..1 bar (1 bit = full scale), or null when nothing is queued. */
  value: { level: number; text: string } | null;
  reason: string;
  /** One-line rendering, e.g. "WAITING · Typing wait 0.8 s · Speaking ✓ · Screen moving ✓ · Question value ████████ 0.83". */
  line: string;
};

const JUDGE_KEYS: readonly ConditionKey[] = ["typingIdle", "userSilent", "screenIdle"];
/** A yes/no question carries at most 1 bit of information, so 1 bit fills the bar. */
const VALUE_FULL_SCALE_BITS = 1;
const BAR_CELLS = 10;

function row(e: GateEvaluation, key: ConditionKey): HudRow {
  const { ok, waitMs } = e.conditions[key];
  const wait = formatWait(waitMs);
  const text = ok ? "✓" : wait === null ? "wait" : `wait ${wait}`;
  return { key, label: CONDITION_LABELS[key], ok, text };
}

/** Pure projection of a gate evaluation onto the judge HUD (plan §7.2). */
export function hudModel(e: GateEvaluation): HudModel {
  const asking = e.decision === "authorize" ? e.question : e.conditions.notOffRecord.ok ? e.inFlight : null;
  const status: HudStatus = asking !== null ? "ASKING" : e.question !== null ? "WAITING" : "LISTENING";
  const shown = asking ?? e.question;
  const value =
    shown === null
      ? null
      : { level: Math.min(1, Math.max(0, shown.value / VALUE_FULL_SCALE_BITS)), text: shown.value.toFixed(2) };
  const rows = CONDITION_KEYS.map((k) => row(e, k));
  const judge = JUDGE_KEYS.map((k) => row(e, k));
  const parts = [status, ...judge.map((r) => `${r.label} ${r.text}`)];
  if (value !== null) parts.push(`Question value ${"█".repeat(Math.round(value.level * BAR_CELLS))} ${value.text}`);
  return {
    status,
    judge,
    rows,
    value,
    reason: asking !== null ? describeQuestion(asking) : e.reason,
    line: parts.join(" · "),
  };
}
