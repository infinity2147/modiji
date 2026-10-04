/**
 * The coach's spoken welcome (a "briefing"): when a trainee turns on the voice coach, the tutor says in a few
 * sentences what it has learned from the experts, where this trainee stands on it, and the one rule to watch
 * for. It is precomputed from the confirmed rulebook and the trainee's own mastery, never from a model, and it
 * is spoken through the same authorized-question path as every intervention: queued as an ephemeral
 * `intervention` question, authorized by the browser gate, spoken exactly as written.
 */
import "server-only";
import { MASTERY_LEVELS, type Question } from "@vashistha/core";
import { parseLedgerPayload } from "@vashistha/core";
import type { TutorRule } from "../../contracts/tutor";
import type { LoadedSession } from "../casedesk/session";
import { entry } from "../interview/ledger";
import type { TutorDeps } from "./deps";
import { INTERVENTION_PRIORITY } from "./monitor";
import { REVIEW_FAMILY } from "./rules";
import { entryContext } from "./session";

/** The first name only, letters (and a hyphen or apostrophe), so a display name can never inject anything into speech. */
export function spokenName(displayName: string | undefined): string | undefined {
  const first = displayName?.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "");
  return first === undefined || first === "" ? undefined : first.slice(0, 30);
}

const RUNG = (r: TutorRule): number => MASTERY_LEVELS.indexOf(r.level);

/** The rule to watch for first: the least-learned one (ties: rulebook order). */
export function focusRule(rules: readonly TutorRule[]): TutorRule | undefined {
  return rules
    .map((rule, order) => ({ rule, order }))
    .sort((a, b) => RUNG(a.rule) - RUNG(b.rule) || a.order - b.order)[0]?.rule;
}

/** The spoken briefing, or null when there is nothing to teach (no confirmed rules): the coach says nothing it cannot back up. */
export function briefingText(input: { name: string | undefined; rules: readonly TutorRule[] }): string | null {
  const { rules } = input;
  const focus = focusRule(rules);
  if (focus === undefined) return null;
  const count = rules.length;
  const untested = rules.filter((r) => r.level === "untested").length;
  const mastered = rules.filter((r) => r.level === "mastered").length;
  const progress =
    mastered === count
      ? "You have mastered all of them, so we will test the edges."
      : untested === count
        ? "You have not tried any yet, so we start from the basics."
        : `You have already worked with ${count - untested} of them.`;
  const watch = `Watch for this one: when ${focus.when}, ${focus.then}.`.slice(0, 220);
  return [
    input.name === undefined ? "Hi, I am your coach." : `Hi ${input.name}, I am your coach.`,
    `I have learned ${count} rule${count === 1 ? "" : "s"} from the experts.`,
    progress,
    watch,
    "Read the case, make your decision, and I will check it with you before you save.",
  ].join(" ");
}

export type BriefingResult = { queued: true; text: string } | { queued: false; reason: "no_rules" | "already_given" };

/** The briefing's question id: one per session, so reconnecting never repeats it. */
export const briefingId = (sessionId: string): string => `briefing-${sessionId}`;

/** Queues the welcome for speech, once per session. */
export function queueBriefing(deps: TutorDeps, loaded: LoadedSession, input: { name: string | undefined; rules: readonly TutorRule[]; caseId?: string | undefined }): BriefingResult {
  const text = briefingText({ name: input.name, rules: input.rules });
  if (text === null) return { queued: false, reason: "no_rules" };
  const { session, info } = loaded;
  const id = briefingId(session.id);
  const given = deps.ledger.list(session.id, { kinds: ["question.queued"] }).some((e) => parseLedgerPayload(e, "question.queued").id === id);
  if (given) return { queued: false, reason: "already_given" };
  const question: Question = {
    id,
    sessionId: session.id,
    kind: "intervention",
    text,
    decisionFamily: REVIEW_FAMILY,
    target: { candidateIds: [], ...(input.caseId !== undefined && { caseId: input.caseId }) },
    value: INTERVENTION_PRIORITY,
    reason: "welcome briefing when the coach connects",
    ephemeral: true,
    createdAt: deps.now(),
    contextVersion: deps.authorizations.getContextVersion(session.id),
    parentIds: [info.startedEntryId],
  };
  deps.ledger.append(entry(entryContext(deps, loaded), "question.queued", "engine", [info.startedEntryId], question));
  return { queued: true, text };
}
