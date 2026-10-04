/**
 * The trainee's voice coach as a conversation: one place that queues a coach turn for speech. A turn is an
 * ephemeral `coach_turn` question, spoken through the same authorized path as every intervention (browser gate
 * → `gate.authorized` → nonce → custom LLM speaks exactly this text), with a `tutor.coached` entry saying why it
 * was raised and which confirmed rules it teaches from. Only the newest unspoken coach turn matters: queuing one
 * drops the older ones still waiting, so the coach never answers a question the trainee has moved past.
 * Interventions (stop-rule warnings) keep their own, higher priority.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { parseLedgerPayload, type LedgerPayload, type Question } from "@vashistha/core";
import type { LoadedSession } from "../casedesk/session";
import { entry, type EntryContext } from "../interview/ledger";
import type { TutorDeps } from "./deps";
import { INTERVENTION_PRIORITY } from "./monitor";
import { REVIEW_FAMILY } from "./rules";
import { entryContext, ruleEntryIds } from "./session";

/** Below interventions (safety first), above every live question. */
export const COACH_PRIORITY = INTERVENTION_PRIORITY - 10;
/** What one coach turn may say: short enough to listen to (the question schema allows 600 characters). */
export const MAX_COACH_CHARS = 480;

export type CoachTrigger = LedgerPayload<"tutor.coached">["trigger"];

export type CoachTurnInput = {
  text: string;
  trigger: CoachTrigger;
  caseId: string | null;
  ruleIds: readonly string[];
  /** The trainee utterance being answered (a `reply` to speech). */
  utteranceId?: string | null;
  origin: "llm" | "template";
  /** Ledger entries this turn answers or reacts to (the utterance, intent, decision …); rule entries are added. */
  parents: readonly string[];
  traceId?: string;
};

/**
 * Ids of coach turns queued and not yet spoken or dropped (folded from the ledger). A turn whose authorization
 * lapsed unspoken (`question.requeued`) is waiting again, keyed to its `question.queued` entry, so a newer turn
 * still supersedes it.
 */
export function waitingCoachTurns(deps: Pick<TutorDeps, "ledger">, sessionId: string): { questionId: string; entryId: string }[] {
  const queued = new Map<string, string>();
  const dropped = new Set<string>();
  const waiting = new Map<string, string>();
  for (const e of deps.ledger.list(sessionId, { kinds: ["question.queued", "gate.authorized", "question.dropped", "question.requeued"] })) {
    switch (e.kind) {
      case "question.queued": {
        const q = parseLedgerPayload(e, "question.queued");
        if (q.kind !== "coach_turn") break;
        queued.set(q.id, e.id);
        waiting.set(q.id, e.id);
        break;
      }
      case "gate.authorized":
        waiting.delete(parseLedgerPayload(e, "gate.authorized").questionId);
        break;
      case "question.dropped": {
        const { questionId } = parseLedgerPayload(e, "question.dropped");
        dropped.add(questionId);
        waiting.delete(questionId);
        break;
      }
      case "question.requeued": {
        const { questionId } = parseLedgerPayload(e, "question.requeued");
        const entryId = queued.get(questionId);
        if (entryId !== undefined && !dropped.has(questionId)) waiting.set(questionId, entryId);
        break;
      }
    }
  }
  return [...waiting].map(([questionId, entryId]) => ({ questionId, entryId }));
}

/** Clamps the spoken text to whole sentences within `MAX_COACH_CHARS`. Pure. */
export function clampSpeech(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_COACH_CHARS) return flat;
  const cut = flat.slice(0, MAX_COACH_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/**
 * Queues one coach turn (dropping older unspoken ones). Returns the question id, or null when the text is empty
 * or the session is off the record (the coach never speaks then).
 */
export function queueCoachTurn(deps: TutorDeps, loaded: LoadedSession, input: CoachTurnInput): string | null {
  const { session } = loaded;
  if (session.offRecord || session.archived) return null;
  const text = clampSpeech(input.text);
  if (text === "") return null;
  const ctx: EntryContext = entryContext(deps, loaded, input.traceId ?? randomUUID());
  const stale = waitingCoachTurns(deps, session.id);
  deps.ledger.appendMany(
    stale.map((s) => entry(ctx, "question.dropped", "engine", [s.entryId], { questionId: s.questionId, reason: "superseded" })),
  );
  const book = deps.rulebook();
  const known = new Set(book.rules.map((r) => r.id));
  const ruleIds = input.ruleIds.filter((id) => known.has(id));
  const entries = ruleEntryIds(book);
  const ruleEntries = ruleIds.flatMap((id) => entries.get(id) ?? []);
  const questionId = randomUUID();
  const coached = deps.ledger.append(
    entry(ctx, "tutor.coached", "engine", [...input.parents, ...ruleEntries], {
      questionId,
      caseId: input.caseId,
      trigger: input.trigger,
      ruleIds,
      utteranceId: input.utteranceId ?? null,
      origin: input.origin,
    }),
  );
  const question: Question = {
    id: questionId,
    sessionId: session.id,
    kind: "coach_turn",
    text,
    decisionFamily: REVIEW_FAMILY,
    target: { candidateIds: [], ...(input.caseId !== null && { caseId: input.caseId }), ...(ruleIds[0] !== undefined && { ruleId: ruleIds[0] }) },
    value: COACH_PRIORITY,
    reason: `coach ${input.trigger}`,
    ephemeral: true,
    createdAt: deps.now(),
    contextVersion: deps.authorizations.getContextVersion(session.id),
    parentIds: [coached.id],
  };
  deps.ledger.append(entry(ctx, "question.queued", "engine", [coached.id], question));
  return questionId;
}
