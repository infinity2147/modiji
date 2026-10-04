/**
 * The coach reacts to what the trainee does (the proactive side of the voice coach). Each nudge is a short spoken
 * `coach_turn` (`queueCoachTurn`: authorized gate path, `tutor.coached` with the trigger and the rules it teaches
 * from), written by code from the confirmed rulebook — the rule in plain words, the facts of the case it reads,
 * and the expert's own words (the English translation when they spoke another language). Never a model, never the
 * hidden oracle: what the expert "would do" is `expectedOutcome` over the confirmed rules, with the trainee's edits.
 *
 * Triggers and their once-per semantics (folded from the ledger, so a restart never repeats one):
 *   - `case_opened`: the trainee opened an undecided case — orientation (ask for a prediction when the case asks
 *     for one, else point at what the rules check). Once per case. A welcome briefing still waiting goes first
 *     (it is queued above every coach turn), so the orientation follows it instead of interrupting it.
 *   - `prediction`: the reveal of a recorded prediction, right or wrong, with the expert's reason. Once per case
 *     (a case has one prediction).
 *   - `off_track`: a selected outcome the rules disagree with while no stop-rule fires (stop-rules are the
 *     monitor's interventions, which always win: a selection with an intervention never gets a nudge). Once per
 *     (case, selected outcome) that was not withdrawn unspoken; a waiting one is dropped when the selection changes.
 *     Switching to the expected outcome after a spoken warning gets a short "That's it".
 *   - `committed`: feedback on a saved decision, a rung moved up, and the next case to open.
 *   - `idle` / `stuck`: the client asks for a hint on an open undecided case (`POST …/tutor/nudge`). Once per case
 *     per reason.
 */
import "server-only";
import {
  MASTERY_LEVELS,
  actionPhrase,
  evaluatePredicate,
  featurePhrase,
  findFeature,
  formatValue,
  isVarRef,
  parseLedgerPayload,
  predicateNode,
  wordCount,
  type ActionId,
  type ConfirmedRule,
  type FeatureId,
  type LedgerEntry,
  type LedgerPayload,
  type MasteryLevel,
  type Predicate,
} from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { KYC_DOMAIN, type KycCase } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import { ReviewEditsSchema } from "../../contracts/casedesk";
import { CoachNudgeRequestSchema, type CoachNudgeResponseSchema } from "../../contracts/tutor";
import { sessionCases } from "../casedesk/cases";
import { json, readJson, respond } from "../casedesk/http";
import { requireOnRecord, type LoadedSession } from "../casedesk/session";
import { entry } from "../interview/ledger";
import { queueCoachTurn, waitingCoachTurns, type CoachTrigger } from "./coach";
import type { TutorDeps } from "./deps";
import { weakestRules } from "./practice";
import { casePrompt, expectedOutcome, type Expected } from "./predict";
import { primaryQuote, taughtRules, thenText, whenText } from "./rules";
import { caseLookup, entryContext, loadNoviceSession, requireSessionCase, type ReviewEdits } from "./session";
import { speechOf, tutorRecord, type TutorRecord } from "./state";

/** A nudge is listened to, not read: about three short sentences. */
export const MAX_NUDGE_WORDS = 55;
/** Features named in one breath. */
const MAX_FEATURES = 3;

export type NudgeReason = z.infer<typeof CoachNudgeRequestSchema>["reason"];
export type NudgeResult = z.infer<typeof CoachNudgeResponseSchema>;

const LEVEL_WORDS: Record<MasteryLevel, string> = {
  untested: "untested",
  assisted: "assisted",
  independent_once: "independently correct once",
  boundary_correct: "correct at a boundary case",
  mastered: "mastered",
};

// ── The coach's record: its own turns, folded from the ledger ──

export type CoachedTurn = {
  entry: LedgerEntry;
  payload: LedgerPayload<"tutor.coached">;
  /** The outcome the trainee had selected when an `off_track` turn was raised (its first parent is the intent). */
  action: ActionId | undefined;
  speech: "waiting" | "spoken" | "dropped";
  /** The `question.queued` entry of its question (parent of a drop). */
  queuedId: string | undefined;
};

/** Every coach turn of the session, with its speech status. Pure fold of the ledger. */
export function coachedTurns(ledger: Pick<Ledger, "list">, sessionId: string): CoachedTurn[] {
  const intents = new Map<string, ActionId>();
  const queued = new Map<string, string>();
  const speech = new Map<string, CoachedTurn["speech"]>();
  const turns: Omit<CoachedTurn, "speech" | "queuedId">[] = [];
  const kinds = ["tutor.intent", "tutor.coached", "question.queued", "gate.authorized", "question.dropped", "question.requeued"] as const;
  for (const e of ledger.list(sessionId, { kinds })) {
    switch (e.kind) {
      case "tutor.intent":
        intents.set(e.id, parseLedgerPayload(e, "tutor.intent").proposedAction);
        break;
      case "tutor.coached":
        turns.push({ entry: e, payload: parseLedgerPayload(e, "tutor.coached"), action: intents.get(e.parentIds[0] ?? "") });
        break;
      case "question.queued": {
        const q = parseLedgerPayload(e, "question.queued");
        if (q.kind === "coach_turn") queued.set(q.id, e.id);
        break;
      }
      case "gate.authorized":
        speech.set(parseLedgerPayload(e, "gate.authorized").questionId, "spoken");
        break;
      case "question.dropped":
        speech.set(parseLedgerPayload(e, "question.dropped").questionId, "dropped");
        break;
      case "question.requeued":
        speech.set(parseLedgerPayload(e, "question.requeued").questionId, "waiting");
        break;
    }
  }
  return turns.map((t) => ({ ...t, speech: speech.get(t.payload.questionId) ?? "waiting", queuedId: queued.get(t.payload.questionId) }));
}

/**
 * Drops the case's coach turns still waiting to be spoken that `stale` says no longer apply (the trainee moved
 * on: changed the selection, saved the case). `trigger` is the entry that made them stale.
 */
export function dropCoachTurns(
  deps: Pick<TutorDeps, "ledger" | "now">,
  loaded: LoadedSession,
  input: { caseId: string; stale: (turn: CoachedTurn) => boolean; trigger: LedgerEntry },
): string[] {
  const waiting = new Set(waitingCoachTurns(deps, loaded.session.id).map((w) => w.questionId));
  const drop = coachedTurns(deps.ledger, loaded.session.id).filter(
    (t) => t.payload.caseId === input.caseId && waiting.has(t.payload.questionId) && input.stale(t),
  );
  if (drop.length === 0 || loaded.session.offRecord || loaded.session.archived) return [];
  const ctx = entryContext(deps, loaded, input.trigger.traceId);
  deps.ledger.appendMany(
    drop.map((t) =>
      entry(ctx, "question.dropped", "engine", [t.queuedId ?? t.entry.id, input.trigger.id], { questionId: t.payload.questionId, reason: "context_changed" }),
    ),
  );
  return drop.map((t) => t.payload.questionId);
}

/** Triggers the tutor raises itself about one case (a `reply` answers the trainee and is never dropped here). */
const CASE_NUDGES: ReadonlySet<CoachTrigger> = new Set(["case_opened", "off_track", "idle", "stuck"]);

// ── Words (pure) ──

/** The first of the candidates within the word budget; the last one is the fallback. */
function fit(candidates: readonly [string, ...string[]]): string {
  return candidates.find((c) => wordCount(c) <= MAX_NUDGE_WORDS) ?? candidates[candidates.length - 1] ?? candidates[0];
}

/** The expert's words as the (English) coach may say them: verbatim in English, else the translation on record, else nothing. */
export function expertWords(rule: ConfirmedRule): string | undefined {
  const quote = primaryQuote(rule);
  if (quote.language === undefined || quote.language === "en") return quote.exactQuote;
  return quote.translation;
}

function saidLine(rule: ConfirmedRule): string | undefined {
  const words = expertWords(rule);
  if (words === undefined) return undefined;
  const translated = primaryQuote(rule).language !== undefined && primaryQuote(rule).language !== "en";
  return `In their words${translated ? ", translated" : ""}: "${words.trim().replace(/[.!?]*$/, "")}."`;
}

function phrase(action: ActionId): string {
  return actionPhrase(KYC_DOMAIN, action);
}

/** The features a predicate reads, in the order the rule reads them (as `whenText` says them), unique. */
export function featuresInOrder(p: Predicate): FeatureId[] {
  const ids: FeatureId[] = [];
  const visit = (q: Predicate): void => {
    const node = predicateNode(q);
    switch (node.key) {
      case "and":
      case "or":
      case "!":
        node.args.forEach(visit);
        return;
      case "in":
        if (isVarRef(node.args[0])) ids.push(node.args[0].var);
        return;
      default:
        for (const o of node.args) if (isVarRef(o)) ids.push(o.var);
    }
  };
  visit(p);
  return [...new Set(ids)];
}

/** "the country risk and the customer status". */
export function featureList(features: readonly FeatureId[]): string {
  const names = [...new Set(features)].slice(0, MAX_FEATURES).map((f) => {
    const feature = findFeature(KYC_DOMAIN, f);
    return `the ${feature === undefined ? f : featurePhrase(feature)}`;
  });
  return names.length <= 1 ? (names[0] ?? "the case details") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** "the country risk is high and the customer status is new": what the case shows on the rule's features. */
export function caseFacts(rule: ConfirmedRule, kycCase: KycCase, edits: ReviewEdits): string {
  const lookup = caseLookup(kycCase, edits);
  const facts = featuresInOrder(rule.predicate).slice(0, MAX_FEATURES).map((f) => {
    const feature = findFeature(KYC_DOMAIN, f);
    return `the ${feature === undefined ? f : featurePhrase(feature)} is ${formatValue(feature, lookup(f))}`;
  });
  return facts.length <= 1 ? (facts[0] ?? "these details") : `${facts.slice(0, -1).join(", ")} and ${facts.at(-1) ?? ""}`;
}

function rulesById(rules: readonly ConfirmedRule[], ids: readonly string[]): ConfirmedRule[] {
  return ids.flatMap((id) => rules.find((r) => r.id === id) ?? []);
}

/** The taught rules that apply to the case or cannot be ruled out on it (features the expert would look at). */
function relevantRules(rules: readonly ConfirmedRule[], kycCase: KycCase, edits: ReviewEdits): ConfirmedRule[] {
  const lookup = caseLookup(kycCase, edits);
  return taughtRules(rules).filter((r) => evaluatePredicate(r.predicate, lookup).truth !== false);
}

const withQuote = (parts: readonly (string | undefined)[]): string => parts.filter((p) => p !== undefined && p !== "").join(" ");

/** Orientation when a case opens (null: nothing the rules can say about it). */
export function orientationText(input: { ask: boolean; expected: Expected; rules: readonly ConfirmedRule[]; kycCase: KycCase }): string | null {
  const { expected, rules, kycCase } = input;
  if (expected.kind === "decided") {
    const look = featureList(rulesById(rules, expected.ruleIds).flatMap((r) => featuresInOrder(r.predicate)));
    return input.ask
      ? `Before you decide, what do you think the expert would do here? Look at ${look}.`
      : `You know the rules behind this one. Check ${look}, then make your call.`;
  }
  const relevant = relevantRules(rules, kycCase, {});
  if (relevant.length === 0) return null;
  return `The expert's rules don't settle this case on their own. Check ${featureList(relevant.flatMap((r) => featuresInOrder(r.predicate)))} first. What do you notice?`;
}

/** The reveal of a prediction, spoken. */
export function revealText(input: { correct: boolean; expected: ActionId; lead: ConfirmedRule | undefined }): string {
  const { lead } = input;
  const because = lead === undefined ? "" : `, because ${whenText(lead)}`;
  const said = lead === undefined ? undefined : saidLine(lead);
  const [opening, close] = input.correct
    ? [`Right! The expert would also ${phrase(input.expected)} here${because}.`, "Go ahead and make your decision."]
    : [`Not quite. The expert would ${phrase(input.expected)} here${because}.`, "What in this case points to that?"];
  return fit([withQuote([opening, said, close]), withQuote([opening, close])]);
}

/** The nudge for a selection the rules disagree with. */
export function offTrackText(input: { selected: ActionId; expected: ActionId; lead: ConfirmedRule | undefined; facts: string | undefined }): string {
  const { lead, facts } = input;
  const picked = `You picked ${phrase(input.selected)}`;
  const fallback = `${picked}, but the expert's rules point to ${phrase(input.expected)} here. Want to look again?`;
  if (lead === undefined || facts === undefined) return fallback;
  const said = saidLine(lead);
  return fit([
    withQuote([`${picked}, but this case has ${facts}. The expert's rule: when ${whenText(lead)}, ${thenText(lead)}.`, said, "Want to look again?"]),
    withQuote([`${picked}, but this case has ${facts}.`, said, "Want to look again?"]),
    `${picked}, but this case has ${facts}, and then the expert would ${phrase(input.expected)}. Want to look again?`,
    fallback,
  ]);
}

/** The selection now matches the rules, after a warning on this case. */
export function onTrackText(expected: ActionId): string {
  return `That's it: ${phrase(expected)} is what the expert would do here. Save it when you're ready.`;
}

/** The case to open next, and why. */
export type NextCase = { caseId: string; weakest: boolean } | null;

function nextLine(next: NextCase): string {
  if (next === null) return "That was the last open case. Ask for practice cases to keep going.";
  return next.weakest ? `Next, open case ${next.caseId}: it practises the rule you find hardest.` : `Next, open case ${next.caseId}.`;
}

/** Feedback on a saved decision. */
export function committedText(input: {
  action: ActionId;
  expected: Expected;
  lead: ConfirmedRule | undefined;
  movedUp: { rule: ConfirmedRule; to: MasteryLevel } | undefined;
  next: NextCase;
}): string {
  const { expected, lead, movedUp } = input;
  const next = nextLine(input.next);
  if (expected.kind !== "decided") return `Saved. The expert's rules don't settle this case, so there is nothing to check it against. ${next}`;
  if (input.action === expected.action) {
    const praise = `Well done: ${phrase(expected.action)} is what the expert would do here.`;
    const moved = movedUp === undefined ? undefined : `You are now at "${LEVEL_WORDS[movedUp.to]}" on the rule to ${thenText(movedUp.rule)}.`;
    return fit([withQuote([praise, moved, next]), withQuote([praise, next])]);
  }
  const because = lead === undefined ? "" : `, because ${whenText(lead)}`;
  const instead = `Saved. The expert would ${phrase(expected.action)} here instead${because}.`;
  const said = lead === undefined ? undefined : saidLine(lead);
  return fit([withQuote([instead, said, next]), withQuote([instead, next]), withQuote([`Saved. The expert would ${phrase(expected.action)} here instead.`, next])]);
}

/** A hint on an open case the trainee has been quiet on. */
export function hintText(input: {
  reason: NudgeReason;
  expected: Expected;
  rules: readonly ConfirmedRule[];
  kycCase: KycCase;
  edits: ReviewEdits;
  selected: ActionId | undefined;
}): string | null {
  const { expected, rules, kycCase, edits } = input;
  if (expected.kind !== "decided") {
    const relevant = relevantRules(rules, kycCase, edits);
    if (relevant.length === 0) return null;
    return `The expert's rules don't settle this case, so it's your call. Check ${featureList(relevant.flatMap((r) => featuresInOrder(r.predicate)))}, then decide.`;
  }
  if (input.selected === expected.action) return `Your choice matches the expert's rules. Save it when you're ready.`;
  const deciding = rulesById(rules, expected.ruleIds);
  const [lead] = deciding;
  if (input.reason === "idle" || lead === undefined)
    return `Need a hint? Check ${featureList(deciding.flatMap((r) => featuresInOrder(r.predicate)))}. What would the expert do with that?`;
  const rule = `Here's the expert's rule: when ${whenText(lead)}, ${thenText(lead)}.`;
  return fit([withQuote([rule, saidLine(lead), "Does it apply here?"]), withQuote([rule, "Does it apply here?"])]);
}

// ── Choosing the next case ──

/**
 * The next undecided case: a practice case on the weakest rule first (weakest order), then any undecided
 * practice case, then the next case after `after` in session order (wrapping round). Null when none is left.
 */
export function nextCase(deps: Pick<TutorDeps, "ledger" | "rulebook">, loaded: LoadedSession, record: TutorRecord, after: string): NextCase {
  const cases = sessionCases(deps.ledger, loaded.session.id, loaded.info).filter((c) => c.id !== after && !record.decisions.has(c.id));
  if (cases.length === 0) return null;
  const practiceRule = (id: string): string | undefined => {
    const origin = record.generated.get(id)?.payload.origin;
    return origin?.kind === "boundary_practice" || origin?.kind === "contrast_practice" ? origin.ruleId : undefined;
  };
  for (const rule of weakestRules(taughtRules(deps.rulebook().rules), record.mastery)) {
    const onRule = cases.find((c) => practiceRule(c.id) === rule.id);
    if (onRule !== undefined) return { caseId: onRule.id, weakest: true };
  }
  const practice = cases.find((c) => practiceRule(c.id) !== undefined);
  if (practice !== undefined) return { caseId: practice.id, weakest: false };
  const all = sessionCases(deps.ledger, loaded.session.id, loaded.info);
  const at = all.findIndex((c) => c.id === after);
  const later = [...all.slice(at + 1), ...all.slice(0, Math.max(at, 0))].find((c) => cases.some((u) => u.id === c.id));
  return { caseId: (later ?? cases[0] ?? { id: after }).id, weakest: false };
}

// ── Triggers ──

/**
 * Runs one trigger; a failure is logged, never thrown: the trainee's own write (intent, prediction, Save) has
 * already succeeded and does not depend on the coach.
 */
export function coachSafely(deps: Pick<TutorDeps, "log">, what: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    deps.log.error(`[tutor] coach after ${what} failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

/** `case_opened`: an `open_case` DOM event. Returns the queued question id, or null. */
export function coachCaseOpened(deps: TutorDeps, loaded: LoadedSession, event: LedgerEntry): string | null {
  if (event.kind !== "screen.event") return null;
  const { kind, caseId } = parseLedgerPayload(event, "screen.event");
  if (kind !== "open_case" || caseId === undefined) return null;
  const record = tutorRecord(deps.ledger, loaded.session.id);
  if (record.decisions.has(caseId)) return null;
  if (coachedTurns(deps.ledger, loaded.session.id).some((t) => t.payload.caseId === caseId && t.payload.trigger === "case_opened")) return null;
  const kycCase = requireSessionCase(deps, loaded, caseId);
  const { rules } = deps.rulebook();
  const expected = expectedOutcome(rules, kycCase, {});
  const text = orientationText({ ask: casePrompt(record, rules, kycCase).ask, expected, rules, kycCase });
  if (text === null) return null;
  const ruleIds = expected.kind === "decided" ? expected.ruleIds : relevantRules(rules, kycCase, {}).map((r) => r.id);
  return queueCoachTurn(deps, loaded, { text, trigger: "case_opened", caseId, ruleIds, origin: "template", parents: [event.id], traceId: event.traceId });
}

/** `prediction`: speaks the reveal of the prediction just recorded (`prediction` is its `tutor.prediction` entry). */
export function coachPrediction(deps: TutorDeps, loaded: LoadedSession, prediction: LedgerEntry): string | null {
  const p = parseLedgerPayload(prediction, "tutor.prediction");
  const [lead] = rulesById(deps.rulebook().rules, p.ruleIds);
  return queueCoachTurn(deps, loaded, {
    text: revealText({ correct: p.correct, expected: p.expected, lead }),
    trigger: "prediction",
    caseId: p.caseId,
    ruleIds: p.ruleIds,
    origin: "template",
    parents: [prediction.id],
    traceId: prediction.traceId,
  });
}

/**
 * A new selection (`intent`) on the case, before the monitor runs: the case's waiting nudges that no longer apply
 * are dropped — the orientation and hints (the trainee has chosen), and `off_track` turns about another outcome —
 * so the coach never speaks about a choice already undone, nor after a stop-rule warning on the new one.
 */
export function withdrawStaleNudges(deps: TutorDeps, loaded: LoadedSession, input: { caseId: string; action: ActionId; intent: LedgerEntry }): string[] {
  return dropCoachTurns(deps, loaded, {
    caseId: input.caseId,
    stale: (t) => CASE_NUDGES.has(t.payload.trigger) && !(t.payload.trigger === "off_track" && t.action === input.action),
    trigger: input.intent,
  });
}

/**
 * `off_track`: after the monitor ran on a selection (`intent`; `withdrawStaleNudges` ran before it). When no
 * stop-rule intervention covers this selection, a selection the rules disagree with gets one nudge, and the
 * expected one gets "That's it" after a spoken warning on the case.
 */
export function coachSelection(
  deps: TutorDeps,
  loaded: LoadedSession,
  input: { kycCase: KycCase; action: ActionId; edits: ReviewEdits; intent: LedgerEntry; intervened: boolean },
): string | null {
  const { kycCase, action } = input;
  const sessionId = loaded.session.id;
  if (input.intervened) return null;
  const { rules } = deps.rulebook();
  const expected = expectedOutcome(rules, kycCase, input.edits);
  if (expected.kind !== "decided") return null;
  const turns = coachedTurns(deps.ledger, sessionId).filter((t) => t.payload.caseId === kycCase.id && t.payload.trigger === "off_track");
  if (turns.some((t) => t.action === action && t.speech !== "dropped")) return null;
  const base = { trigger: "off_track" as const, caseId: kycCase.id, origin: "template" as const, parents: [input.intent.id], traceId: input.intent.traceId };
  if (action === expected.action) {
    const record = tutorRecord(deps.ledger, sessionId);
    const warned =
      turns.some((t) => t.action !== action && t.speech === "spoken") ||
      record.interventions.some((i) => i.payload.caseId === kycCase.id && i.payload.proposedAction !== action && speechOf(record, i.payload.questionId) === "spoken");
    return warned ? queueCoachTurn(deps, loaded, { ...base, text: onTrackText(action), ruleIds: expected.ruleIds }) : null;
  }
  const [lead] = rulesById(rules, expected.ruleIds);
  const facts = lead === undefined ? undefined : caseFacts(lead, kycCase, input.edits);
  return queueCoachTurn(deps, loaded, { ...base, text: offTrackText({ selected: action, expected: expected.action, lead, facts }), ruleIds: expected.ruleIds });
}

/**
 * `committed`: feedback on a saved decision (`decision`, its `case.decision` entry), with the rungs that moved
 * (`moved`, its `mastery.updated` entries). The case's waiting nudges are dropped either way.
 */
export function coachCommitted(
  deps: TutorDeps,
  loaded: LoadedSession,
  input: { decision: LedgerEntry; kycCase: KycCase; action: ActionId; expected: Expected; moved: readonly LedgerEntry[] },
): string | null {
  const { kycCase, expected } = input;
  dropCoachTurns(deps, loaded, { caseId: kycCase.id, stale: (t) => t.payload.trigger !== "reply", trigger: input.decision });
  const { rules } = deps.rulebook();
  const ups = input.moved.flatMap((m) => {
    if (m.kind !== "mastery.updated") return [];
    const { ruleId, from, to } = parseLedgerPayload(m, "mastery.updated");
    const rule = rules.find((r) => r.id === ruleId);
    return rule !== undefined && MASTERY_LEVELS.indexOf(to) > MASTERY_LEVELS.indexOf(from) ? [{ rule, to }] : [];
  });
  const lead = expected.kind === "decided" ? rulesById(rules, expected.ruleIds)[0] : undefined;
  const record = tutorRecord(deps.ledger, loaded.session.id);
  // The rung to mention: a rule deciding this case first, else any that moved (a stop-rule respected).
  const movedUp = ups.find((u) => expected.kind === "decided" && expected.ruleIds.includes(u.rule.id)) ?? ups[0];
  const text = committedText({ action: input.action, expected, lead, movedUp, next: nextCase(deps, loaded, record, kycCase.id) });
  const ruleIds = [...new Set([...(expected.kind === "decided" ? expected.ruleIds : []), ...ups.map((u) => u.rule.id)])];
  return queueCoachTurn(deps, loaded, {
    text,
    trigger: "committed",
    caseId: kycCase.id,
    ruleIds,
    origin: "template",
    parents: [input.decision.id, ...input.moved.map((m) => m.id)],
    traceId: input.decision.traceId,
  });
}

/** `idle` / `stuck`: a hint on an open undecided case, once per case per reason. */
export function coachNudge(deps: TutorDeps, loaded: LoadedSession, input: { caseId: string; reason: NudgeReason }): NudgeResult {
  const kycCase = requireSessionCase(deps, loaded, input.caseId);
  const sessionId = loaded.session.id;
  const record = tutorRecord(deps.ledger, sessionId);
  if (record.decisions.has(kycCase.id)) return { queued: false, reason: "decided" };
  if (coachedTurns(deps.ledger, sessionId).some((t) => t.payload.caseId === kycCase.id && t.payload.trigger === input.reason))
    return { queued: false, reason: "already_given" };
  const intent = record.intents.get(kycCase.id);
  const parsed = ReviewEditsSchema.safeParse(intent?.payload.edits ?? {});
  const edits: ReviewEdits = parsed.success ? parsed.data : {};
  const { rules } = deps.rulebook();
  const expected = expectedOutcome(rules, kycCase, edits);
  const text = hintText({ reason: input.reason, expected, rules, kycCase, edits, selected: intent?.payload.proposedAction });
  if (text === null) return { queued: false, reason: "nothing_to_say" };
  const ruleIds = expected.kind === "decided" ? expected.ruleIds : relevantRules(rules, kycCase, edits).map((r) => r.id);
  const questionId = queueCoachTurn(deps, loaded, {
    text,
    trigger: input.reason,
    caseId: kycCase.id,
    ruleIds,
    origin: "template",
    parents: [intent?.entry.id ?? loaded.info.startedEntryId],
  });
  return questionId === null ? { queued: false, reason: "nothing_to_say" } : { queued: true, questionId, text };
}

/** POST /api/sessions/:sessionId/tutor/nudge — the trainee has been idle (or stuck) on an open case: queue a hint. */
export function handleCoachNudge(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, CoachNudgeRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    const result: NudgeResult = coachNudge(deps, loaded, body);
    return json(result);
  });
}
