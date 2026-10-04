/**
 * The gate HUD of a recorded session, derived from its ledger only (pure). The live HUD renders the
 * gate's evaluation of activity signals that are deliberately NOT recorded (timing only), so a replay
 * cannot recompute WAITING's live countdowns. What the ledger does prove is shown, with the live HUD's
 * own wording: a question is queued (WAITING, its value), the gate authorized it (ASKING, with the
 * condition snapshot recorded at that moment, `gate.authorized.conditions`), the expert answered or
 * the question was dropped (back to LISTENING/WAITING). Reasons use the core `describeQuestion`.
 */
import { CONDITION_LABELS, describeQuestion, parseLedgerPayload, type HudRow, type HudStatus, type LedgerEntry, type Question } from "@vashistha/core";

export type ReplayHud = {
  status: HudStatus;
  /** Typing · Speaking · Screen moving as recorded at authorization; null when the ledger has no snapshot for this moment. */
  judge: HudRow[] | null;
  value: { level: number; text: string } | null;
  reason: string;
};

const JUDGE_KEYS = ["typingIdle", "userSilent", "screenIdle"] as const;
/** As in the live HUD: 1 bit fills the bar. */
const VALUE_FULL_SCALE_BITS = 1;

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const valueOf = (q: Question): { level: number; text: string } => ({ level: Math.min(1, Math.max(0, q.value / VALUE_FULL_SCALE_BITS)), text: q.value.toFixed(2) });

export function replayHud(entries: readonly LedgerEntry[]): ReplayHud {
  const questions = new Map<string, Question>();
  const queued = new Map<string, Question>();
  let asking: { question: Question | undefined; questionId: string; conditions: Record<string, boolean> } | null = null;
  let offRecord = false;

  for (const e of entries) {
    switch (e.kind) {
      case "question.queued": {
        const q = safely(() => parseLedgerPayload(e, "question.queued"));
        if (q) {
          questions.set(q.id, q);
          queued.set(q.id, q);
        }
        break;
      }
      case "question.dropped": {
        const p = safely(() => parseLedgerPayload(e, "question.dropped"));
        if (p) {
          queued.delete(p.questionId);
          if (asking?.questionId === p.questionId) asking = null;
        }
        break;
      }
      case "gate.authorized": {
        const p = safely(() => parseLedgerPayload(e, "gate.authorized"));
        if (p) {
          asking = { question: questions.get(p.questionId), questionId: p.questionId, conditions: p.conditions };
          queued.delete(p.questionId);
        }
        break;
      }
      case "question.requeued": {
        const p = safely(() => parseLedgerPayload(e, "question.requeued"));
        const q = p === undefined ? undefined : questions.get(p.questionId);
        if (p && q) {
          queued.set(p.questionId, q);
          if (asking?.questionId === p.questionId) asking = null;
        }
        break;
      }
      // The expert answered: the floor is theirs again.
      case "utterance.transcript":
      case "expert.statement":
        asking = null;
        break;
      case "privacy.off_record":
        offRecord = true;
        asking = null;
        break;
      case "privacy.on_record":
        offRecord = false;
        break;
    }
  }

  if (offRecord) return { status: "LISTENING", judge: null, value: null, reason: "Off the record — nothing is captured or asked" };
  if (asking !== null) {
    const { conditions, question } = asking;
    const judge = JUDGE_KEYS.map((key): HudRow => {
      const ok = conditions[key] ?? false;
      return { key, label: CONDITION_LABELS[key], ok, text: ok ? "✓" : "wait" };
    });
    return {
      status: "ASKING",
      judge,
      value: question === undefined ? null : valueOf(question),
      reason: question === undefined ? "Authorized question (text not in this session's ledger)" : describeQuestion(question),
    };
  }
  const top = [...queued.values()].sort((a, b) => b.value - a.value)[0];
  if (top !== undefined)
    return {
      status: "WAITING",
      judge: null,
      value: valueOf(top),
      reason: `${queued.size} queued · ${describeQuestion(top)} · waits until the expert pauses (gate timing is not recorded)`,
    };
  return { status: "LISTENING", judge: null, value: null, reason: "Listening · no question queued" };
}
