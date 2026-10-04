/**
 * The debrief as a short conversation (chat or voice) instead of forms. The engine leads: it works through an
 * agenda computed from the debrief state (proposed rules, unexplained decisions, the solver's open cases, proposed
 * concepts, hard stops, the teach-back) and the expert answers in their own words.
 *
 * LLMs infer, experts confirm, code enforces:
 * - A plain yes / no / skip is read by code. A free answer is read by the model (interpret.ts), checked by code,
 *   and READ BACK; nothing is saved until the expert's next reply is a plain yes.
 * - Saving goes through the same expert actions as the old forms (`applyExpertAction`, `applyConceptAction`),
 *   so every rule still needs the expert's exact words and a screen frame, and passes promotion.
 * - Every turn is in the ledger (`debrief.asked` / `debrief.replied` / `debrief.understood`); the agent's text is
 *   deterministic.
 * - A spoken reply (the interviewer's voice) counts only for the turn now waiting, is understood in English (the
 *   utterance's verified translation), and is cited as the utterance itself (`human_voice`): a rule saved after a
 *   read-back quotes the statement the expert made, not the "yes" that confirmed it.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  QuestionSchema,
  actionPhrase,
  canonicalJson,
  contentId,
  describePredicate,
  parseLedgerPayload,
  type ActionId,
  type ConfirmedRule,
  type LedgerEntry,
  type Witness,
} from "@vashistha/core";
import { ConceptActionRequestSchema, type ConceptActionRequest } from "../../contracts/concepts";
import {
  ExpertActionRequestSchema,
  type DebriefConversation,
  type DebriefState,
  type DebriefTurn,
  type ExpertActionRequest,
  type WitnessView,
} from "../../contracts/debrief";
import { numericComparisons, replaceComparison } from "../../debrief-predicate-edit";
import { ApiFailure } from "../casedesk/http";
import { requireOnRecord } from "../casedesk/session";
import type { UtteranceRecord } from "../interview/engine-state";
import { entry, type EntryContext, type PayloadInput } from "../interview/ledger";
import { localizeQuestion } from "../interview/llm";
import type { SchemaDeps } from "../schema/deps";
import { applyConceptAction, conceptsState } from "../schema/service";
import { applyExpertAction, generateTeachBack, isAffirmative, rebuildWitnesses, type SpokenWords } from "./actions";
import type { DebriefDeps } from "./deps";
import { interpretReply, type InterpretContext, type Reading } from "./interpret";
import { DOMAIN, byProposalWeight, debriefState, snapshot, type Snapshot } from "./state";
import { effectPhrase } from "./text";

export type ConversationDeps = { debrief: DebriefDeps; schema: SchemaDeps };

type Topic = PayloadInput<"debrief.asked">["topic"];
type Intent = PayloadInput<"debrief.understood">["intent"];

/** Keeps the debrief to a few minutes: the heaviest few of each kind; the rest stay on the rulebook page. */
const MAX_PROPOSALS = 4;
const MAX_UNEXPLAINED = 3;
const MAX_WITNESSES = 4;

const PLAIN_YES = /^\s*(okay|sure|yup|absolutely|definitely|that'?s how i (do|decide) it)\b/i;
const HEDGED = /\b(but|except|no|not|wrong|unless|however)\b/i;
const PLAIN_NO = /^\s*(no|nope|nah|none|nothing( else)?|not really|no more|that'?s (all|it|everything)|i don'?t think so)\b[\s.!]*$/i;
const SKIP = /^\s*(skip|pass|next|not sure|i'?m not sure|i don'?t know|don'?t know|move on|later)\b/i;

/** What a reply to a readback (or a retry) refers back to. */
type Origin = { topic: Topic; ref: string | null };

/**
 * What a turn carries in `pending` (validated again on use). `quote` is the expert's statement being read back
 * and `utteranceId` the utterance it was said in (absent when typed): the saved rule cites that statement, never
 * the "yes" that confirms it.
 */
type Pending =
  | { kind: "expert"; request: Record<string, unknown>; quote: string; utteranceId?: string; origin: Origin }
  | { kind: "concept"; request: Record<string, unknown>; quote: string; utteranceId?: string; origin: Origin }
  | { kind: "retry"; origin: Origin }
  | { kind: "concept_range"; name: string; origin: Origin };

type Asked = { entry: LedgerEntry; promptId: string; topic: Topic; ref: string | null; text: string; pending: Pending | null };
type Replied = { entry: LedgerEntry; promptId: string; text: string; via: "chat" | "voice" };
type Understood = { entry: LedgerEntry; promptId: string; intent: Intent; origin: "rule" | "llm"; statementId: string | null; refused: string | null };

type History = { asked: Asked[]; replies: Map<string, Replied>; understood: Map<string, Understood>; order: LedgerEntry[] };

/**
 * One reply as the conversation reads it. `text` is recorded (the expert's words as given). `meaning` is what
 * code and the model read: the English translation of a non-English spoken reply, else `text`. `quote` is the
 * evidence: typed, the reply itself (`human_text`); spoken, the longest segment, a verbatim span of the
 * utterance `spoken` names (`human_voice`, original words).
 */
type Reply = { text: string; meaning: string; quote: string; spoken: SpokenWords | undefined };

/** The words a read-back carries: the quote, and the utterance it was said in. */
function wordsOf(reply: Reply): { quote: string; utteranceId?: string } {
  return { quote: reply.quote, ...(reply.spoken !== undefined && { utteranceId: reply.spoken.utteranceId }) };
}

/** The expert's words for a concept action (`ExpertWordsInputSchema`): typed, or a verbatim span of an utterance. */
function statementOf(words: { quote: string; utteranceId?: string }): { text: string; utteranceId?: string } {
  return { text: words.quote, ...(words.utteranceId !== undefined && { utteranceId: words.utteranceId }) };
}

function spokenOf(words: { utteranceId?: string }): SpokenWords | undefined {
  return words.utteranceId === undefined ? undefined : { utteranceId: words.utteranceId };
}

function history(entries: readonly LedgerEntry[]): History {
  const asked: Asked[] = [];
  const replies = new Map<string, Replied>();
  const understood = new Map<string, Understood>();
  const order: LedgerEntry[] = [];
  for (const e of entries) {
    if (e.kind === "debrief.asked") {
      const p = parseLedgerPayload(e, "debrief.asked");
      asked.push({ entry: e, promptId: p.promptId, topic: p.topic, ref: p.ref, text: p.text, pending: p.pending as Pending | null });
      order.push(e);
    } else if (e.kind === "debrief.replied") {
      const p = parseLedgerPayload(e, "debrief.replied");
      replies.set(p.promptId, { entry: e, promptId: p.promptId, text: p.text, via: p.via });
      order.push(e);
    } else if (e.kind === "debrief.understood") {
      const p = parseLedgerPayload(e, "debrief.understood");
      understood.set(p.promptId, { entry: e, promptId: p.promptId, intent: p.intent, origin: p.origin, statementId: p.statementId, refused: p.refused });
    }
  }
  return { asked, replies, understood, order };
}

function awaitingOf(h: History): Asked | undefined {
  const last = h.asked.at(-1);
  return last !== undefined && last.topic !== "closing" && !h.replies.has(last.promptId) ? last : undefined;
}

function familyOfAction(action: ActionId): string | undefined {
  return DOMAIN.decisionFamilies.find((f) => f.actions.includes(action))?.id;
}

function actionsOfFamily(family: string): ActionId[] {
  return [...(DOMAIN.decisionFamilies.find((f) => f.id === family)?.actions ?? [])];
}

const ALL_ACTIONS: ActionId[] = DOMAIN.decisionFamilies.flatMap((f) => [...f.actions]);

// ── The agenda ──

type Item = { topic: Topic; ref: string | null; text: string };

function openWitnesses(state: DebriefState): WitnessView[] {
  return state.witnesses.filter((v) => v.current && (v.status === "open" || v.status === "queued" || v.status === "asked") && v.witness.kind !== "disagreement");
}

function witnessPrompt(v: WitnessView): string {
  if (v.question !== null) return v.question.text;
  const w = v.witness;
  return w.kind === "conflict"
    ? `Two of your rules disagree on a case like ${v.conditions.join(", ")}. Which one should win?`
    : `What would you do with a case like this: ${v.conditions.join(", ")}?`;
}

/** The first thing not yet talked through, in agenda order; `closing` when everything has been. */
async function nextItem(deps: ConversationDeps, sessionId: string, h: History): Promise<Item> {
  const seen = new Set(h.asked.map((a) => `${a.topic}:${a.ref ?? ""}`));
  const unseen = (topic: Topic, ref: string) => !seen.has(`${topic}:${ref}`);
  let state = debriefState(deps.debrief, await snapshot(deps.debrief, sessionId));

  const proposal = [...state.proposals].sort(byProposalWeight).slice(0, MAX_PROPOSALS).find((p) => unseen("proposal", p.candidateId));
  if (proposal !== undefined)
    return {
      topic: "proposal",
      ref: proposal.candidateId,
      text: `Here's a rule I think you follow: when ${proposal.text}, ${actionPhrase(DOMAIN, proposal.action)}. Is that right? Say yes, no, or put it your own way.`,
    };

  const unexplained = state.decisions.filter((d) => !d.explained).slice(0, MAX_UNEXPLAINED).find((d) => unseen("unexplained", d.entryId));
  if (unexplained !== undefined)
    return { topic: "unexplained", ref: unexplained.entryId, text: `On case ${unexplained.caseId} you chose "${unexplained.actionLabel}". What made that the right call?` };

  const witness = openWitnesses(state).slice(0, MAX_WITNESSES).find((v) => unseen("witness", v.witness.id));
  if (witness !== undefined) return { topic: "witness", ref: witness.witness.id, text: witnessPrompt(witness) };

  const concept = conceptsState(deps.schema, sessionId).undefinedConcepts.find((c) => unseen("concept", c.name));
  if (concept !== undefined)
    return { topic: "concept", ref: concept.name, text: `You seem to use an idea the system doesn't have yet: "${concept.label}" (${concept.definition}). Should I add it? Yes or no.` };

  const stopAsked = h.asked.filter((a) => a.topic === "stop_rules");
  const stopDone = stopAsked.some((a) => {
    const u = h.understood.get(a.promptId);
    return u !== undefined && (u.intent === "no" || u.intent === "skip");
  });
  if (!stopDone)
    return stopAsked.length === 0
      ? { topic: "stop_rules", ref: "first", text: "Is there anything you would never allow, whatever the case? A hard stop, or something that always needs sign-off. Say it in your own words, or say no." }
      : { topic: "stop_rules", ref: `more-${stopAsked.length}`, text: "Any other hard stop? Or say no." };

  if (state.rules.length > 0) {
    if (state.teachBack === null || !state.teachBack.current) {
      await generateTeachBack(deps.debrief, sessionId);
      state = debriefState(deps.debrief, await snapshot(deps.debrief, sessionId));
    }
    const tb = state.teachBack;
    if (tb !== null && tb.confirmedEntryId === null && unseen("teach_back", tb.entryId))
      return { topic: "teach_back", ref: tb.entryId, text: /\?\s*$/.test(tb.text) ? tb.text : `${tb.text} Is that right?` };
  }

  return { topic: "closing", ref: null, text: "That's everything I needed. Thank you. If you think of another rule, or want to drop one, just tell me." };
}

// ── Reading a reply ──

function plainIntent(text: string): "yes" | "no" | "skip" | undefined {
  if (isAffirmative(text) || (PLAIN_YES.test(text) && !HEDGED.test(text))) return "yes";
  if (PLAIN_NO.test(text)) return "no";
  if (SKIP.test(text)) return "skip";
  return undefined;
}

type Outcome = {
  intent: Intent;
  origin: "rule" | "llm";
  /** Applied and saved: the `expert.statement` (or concept entry) it wrote. */
  statementId: string | null;
  refused: string | null;
  /** What to say first ("Saved."), before the next question. */
  ack: string;
  /** Ask this next instead of the agenda (a readback or a retry). */
  next?: Item & { pending: Pending };
};

const SAVED = "Saved.";

function refusalText(error: unknown): string {
  if (error instanceof ApiFailure) return error.message;
  return error instanceof Error ? error.message : "it could not be saved";
}

async function applyExpert(deps: ConversationDeps, sessionId: string, request: ExpertActionRequest, spoken: SpokenWords | undefined): Promise<{ statementId: string | null; refused: string | null }> {
  try {
    const result = await applyExpertAction(deps.debrief, sessionId, request, spoken);
    return { statementId: result.statementId, refused: null };
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    return { statementId: null, refused: refusalText(error) };
  }
}

function applyConcept(deps: ConversationDeps, sessionId: string, request: ConceptActionRequest): { statementId: string | null; refused: string | null } {
  try {
    return { statementId: applyConceptAction(deps.schema, sessionId, request).entryId, refused: null };
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error;
    return { statementId: null, refused: refusalText(error) };
  }
}

function savedOrRefused(intent: Intent, origin: "rule" | "llm", r: { statementId: string | null; refused: string | null }): Outcome {
  return { intent, origin, ...r, ack: r.refused === null ? SAVED : `I couldn't save that: ${r.refused}.` };
}

function readback(origin: Origin, text: string, pending: Omit<Extract<Pending, { kind: "expert" | "concept" }>, "origin">): Item & { pending: Pending } {
  return { topic: "readback", ref: origin.ref, text, pending: { ...pending, origin } };
}

function retry(origin: Origin, text: string): Item & { pending: Pending } {
  return { topic: origin.topic, ref: origin.ref, text, pending: { kind: "retry", origin } };
}

/** The expert's confirmed rules as the reply reader numbers them (a deletion names one by its number). */
function ruleList(state: DebriefState): string[] {
  return state.rules.map((r) => `when ${r.when}, ${r.then}`);
}

/** "Drop the rule about …": read back the exact rule; it is deleted (`retire_rule`) only after a plain yes. */
function retireReadback(state: DebriefState, origin: Origin, reading: Extract<Reading, { kind: "retire_rule" }>, reply: Reply): Outcome | undefined {
  const view = state.rules[reading.index];
  if (view === undefined) return undefined;
  const request = { action: "retire_rule", ruleId: view.rule.id };
  return {
    intent: "statement",
    origin: "llm",
    statementId: null,
    refused: null,
    ack: "",
    next: readback(origin, `So I'll delete this rule: when ${view.when}, ${view.then}. Delete it?`, { kind: "expert", request, ...wordsOf(reply) }),
  };
}

function ruleSentence(rule: ConfirmedRule): string {
  return `when ${describePredicate(rule.predicate, DOMAIN)}, ${effectPhrase(DOMAIN, rule.effect)}`;
}

/** The model's reading of a free reply, or `unclear` without a model. */
async function read(deps: ConversationDeps, snap: Snapshot, input: Omit<InterpretContext, "reply">, reply: string): Promise<Reading> {
  if (deps.debrief.claude === null) return { kind: "unclear", why: "I can only understand yes, no and skip right now (no language model)" };
  return interpretReply(deps.debrief.claude, snap.domain, { ...input, reply }, deps.debrief.log);
}

/** A free reply nobody could read: ask once more, then move on. */
function notUnderstood(asked: Asked, origin: Origin, why: string, again: string): Outcome {
  const retried = asked.pending?.kind === "retry";
  return retried
    ? { intent: "unclear", origin: "llm", statementId: null, refused: null, ack: "I still couldn't tell, so let's move on." }
    : { intent: "unclear", origin: "llm", statementId: null, refused: null, ack: `Sorry, ${why}.`, next: retry(origin, again) };
}

async function understand(deps: ConversationDeps, sessionId: string, asked: Asked, reply: Reply): Promise<Outcome> {
  const snap = await snapshot(deps.debrief, sessionId);
  const state = debriefState(deps.debrief, snap);
  const plain = plainIntent(reply.meaning);
  const origin: Origin = asked.pending !== null && asked.pending.kind !== "concept_range" && asked.topic === "readback" ? asked.pending.origin : { topic: asked.topic, ref: asked.ref };
  const moveOn = (intent: Intent, ack = "Okay."): Outcome => ({ intent, origin: "rule", statementId: null, refused: null, ack });

  // A readback: only a plain yes applies what was read back.
  if (asked.topic === "readback") {
    const p = asked.pending;
    if (plain === "yes" && p !== null && (p.kind === "expert" || p.kind === "concept")) {
      if (p.kind === "expert") {
        const parsed = ExpertActionRequestSchema.safeParse({ ...p.request, quote: p.quote });
        if (!parsed.success) return { ...moveOn("yes"), refused: "the read-back no longer matches a valid action", ack: "I couldn't save that, sorry." };
        const outcome = savedOrRefused("yes", "rule", await applyExpert(deps, sessionId, parsed.data, spokenOf(p)));
        return parsed.data.action === "retire_rule" && outcome.refused === null ? { ...outcome, ack: "Deleted." } : outcome;
      }
      const parsed = ConceptActionRequestSchema.safeParse({ ...p.request, statement: statementOf(p) });
      if (!parsed.success) return { ...moveOn("yes"), refused: "the read-back no longer matches a valid action", ack: "I couldn't save that, sorry." };
      return savedOrRefused("yes", "rule", applyConcept(deps, sessionId, parsed.data));
    }
    if (plain === "skip" || plain === "no")
      return plain === "no"
        ? { intent: "no", origin: "rule", statementId: null, refused: null, ack: "Okay, not saved.", next: retry(origin, "Tell me again in your own words, or say skip.") }
        : moveOn("skip", "Okay, not saved.");
    // Anything else: treat it as a new attempt at the original question.
    return understand(deps, sessionId, { ...asked, topic: origin.topic, ref: origin.ref, pending: { kind: "retry", origin } }, reply);
  }

  switch (asked.topic) {
    case "proposal": {
      const proposal = state.proposals.find((p) => p.candidateId === asked.ref);
      if (proposal === undefined) return moveOn("skip", "That one is already settled.");
      if (plain === "yes")
        return savedOrRefused(
          "yes",
          "rule",
          await applyExpert(deps, sessionId, { action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: reply.quote }, reply.spoken),
        );
      if (plain === "no") return moveOn("no", "Okay, I won't keep that one.");
      if (plain === "skip") return moveOn("skip");
      const reading = await read(deps, snap, { question: asked.text, allowed: ["decision_rule"], context: `Proposed rule: when ${proposal.text}, ${actionPhrase(DOMAIN, proposal.action)}`, actions: actionsOfFamily(proposal.decisionFamily) }, reply.meaning);
      return statedRule(asked, origin, reading, reply, "Is the proposed rule right? Say yes, no, or tell me the rule your way.");
    }
    case "unexplained": {
      const decision = state.decisions.find((d) => d.entryId === asked.ref);
      if (decision === undefined || plain !== undefined) return moveOn(plain ?? "skip");
      const family = familyOfAction(decision.action);
      const reading = await read(
        deps,
        snap,
        { question: asked.text, allowed: ["decision_rule"], context: `On case ${decision.caseId} the expert chose ${decision.actionLabel}.`, actions: family === undefined ? [decision.action] : actionsOfFamily(family) },
        reply.meaning,
      );
      return statedRule(asked, origin, reading, reply, `What about case ${decision.caseId} made it "${decision.actionLabel}"?`);
    }
    case "witness":
      return witnessReply(deps, snap, state, asked, origin, reply, plain);
    case "concept": {
      const concept = conceptsState(deps.schema, sessionId).undefinedConcepts.find((c) => c.name === asked.ref);
      if (concept === undefined) return moveOn("skip", "That one is already settled.");
      if (asked.pending?.kind === "concept_range") {
        const reading = await read(deps, snap, { question: asked.text, allowed: ["range"], context: `New numeric concept: ${concept.label} (${concept.definition})`, actions: [] }, reply.meaning);
        if (reading.kind !== "range") return notUnderstood(asked, origin, reading.kind === "unclear" ? reading.why : "I didn't hear a range", `What's the smallest and largest value of "${concept.label}"?`);
        const request = { action: "confirm", name: concept.name, definition: { type: "number", label: concept.label, description: concept.definition, min: reading.min, max: reading.max, integer: reading.integer } };
        return {
          intent: "statement",
          origin: "llm",
          statementId: null,
          refused: null,
          ack: "",
          next: readback(origin, `So "${concept.label}" goes from ${reading.min} to ${reading.max}${reading.integer ? ", whole numbers only" : ""}. Add it?`, { kind: "concept", request, ...wordsOf(reply) }),
        };
      }
      if (plain === "no") return savedOrRefused("no", "rule", applyConcept(deps, sessionId, { action: "dismiss", name: concept.name, reason: "not_a_concept", statement: statementOf(wordsOf(reply)) }));
      if (plain === "yes") {
        if (concept.type === "number")
          return { intent: "yes", origin: "rule", statementId: null, refused: null, ack: "", next: { topic: "concept", ref: concept.name, text: `What's the smallest and largest value of "${concept.label}"?`, pending: { kind: "concept_range", name: concept.name, origin } } };
        const definition =
          concept.type === "enum"
            ? { type: "enum" as const, label: concept.label, description: concept.definition, values: concept.values }
            : { type: "boolean" as const, label: concept.label, description: concept.definition };
        return savedOrRefused("yes", "rule", applyConcept(deps, sessionId, { action: "confirm", name: concept.name, definition, statement: statementOf(wordsOf(reply)) }));
      }
      return plain === "skip" ? moveOn("skip") : notUnderstood(asked, origin, "please answer yes or no", `Should I add "${concept.label}"? Yes or no.`);
    }
    case "stop_rules": {
      if (plain === "no" || plain === "skip") return moveOn(plain, "Okay.");
      if (plain === "yes") return { intent: "yes", origin: "rule", statementId: null, refused: null, ack: "", next: retry(origin, "Go ahead: what should never happen, or what needs sign-off?") };
      const reading = await read(
        deps,
        snap,
        {
          question: asked.text,
          allowed: ["stop_rule", "decision_rule", "retire_rule"],
          context: "The expert is stating a hard stop (never allow an action, or only with sign-off), another rule they follow, or asking to delete one of their rules.",
          actions: ALL_ACTIONS,
          rules: ruleList(state),
        },
        reply.meaning,
      );
      if (reading.kind === "retire_rule") return retireReadback(state, origin, reading, reply) ?? notUnderstood(asked, origin, "I couldn't tell which rule you want to delete", "Which rule should I delete?");
      if (reading.kind === "decision_rule") return statedRule(asked, origin, reading, reply, "Tell me the rule again in your own words.");
      if (reading.kind !== "stop_rule") return notUnderstood(asked, origin, reading.kind === "unclear" ? reading.why : "that didn't sound like a hard stop", "Tell me the hard stop again: what should never happen, and when?");
      const decisionFamily = familyOfAction(reading.action);
      if (decisionFamily === undefined) return notUnderstood(asked, origin, "I couldn't tell which decision you meant", "Which action should never happen?");
      const effect = reading.effect === "forbid" ? { type: "forbid" as const, action: reading.action } : { type: "require_approval" as const, role: reading.role ?? "compliance_officer", action: reading.action };
      const what = effectPhrase(DOMAIN, effect);
      const request = { action: "confirm_stop_rule", decisionFamily, when: { combinator: reading.combinator, conditions: reading.conditions }, effect };
      return { intent: "statement", origin: "llm", statementId: null, refused: null, ack: "", next: readback(origin, `So the hard stop is: when ${describePredicate(reading.predicate, DOMAIN)}, ${what}. Save it?`, { kind: "expert", request, ...wordsOf(reply) }) };
    }
    case "teach_back": {
      const tb = state.teachBack;
      if (tb === null || tb.entryId !== asked.ref || !tb.current) return moveOn("skip", "The rules changed since, so I'll read it again later.");
      if (plain === "yes") return savedOrRefused("yes", "rule", await applyExpert(deps, sessionId, { action: "confirm_teachback", teachBackId: tb.entryId, quote: reply.quote }, reply.spoken));
      if (plain === "skip") return moveOn("skip");
      if (plain === "no") return { intent: "no", origin: "rule", statementId: null, refused: null, ack: "", next: retry(origin, "What did I get wrong? Tell me the rule as it should be.") };
      const family = state.rules[0]?.rule.decisionFamily ?? DOMAIN.decisionFamilies[0]?.id ?? "";
      const reading = await read(
        deps,
        snap,
        { question: asked.text, allowed: ["decision_rule", "retire_rule"], context: `The teach-back said: ${tb.text}`, actions: family === "" ? ALL_ACTIONS : actionsOfFamily(family), rules: ruleList(state) },
        reply.meaning,
      );
      if (reading.kind === "retire_rule") return retireReadback(state, origin, reading, reply) ?? notUnderstood(asked, origin, "I couldn't tell which rule you want to delete", "Which rule should I delete?");
      return statedRule(asked, origin, reading, reply, "Tell me the rule as it should be.");
    }
    case "closing":
      return moveOn("skip");
  }
}

/** A decision rule stated in the expert's words: read back, or ask again. */
function statedRule(asked: Asked, origin: Origin, reading: Reading, reply: Reply, again: string): Outcome {
  if (reading.kind !== "decision_rule") return notUnderstood(asked, origin, reading.kind === "unclear" ? reading.why : "I didn't hear a rule in that", again);
  const decisionFamily = familyOfAction(reading.action);
  if (decisionFamily === undefined) return notUnderstood(asked, origin, "I couldn't tell which decision you meant", again);
  const request = { action: "confirm_stated_rule", decisionFamily, when: { combinator: reading.combinator, conditions: reading.conditions }, decision: reading.action };
  return {
    intent: "statement",
    origin: "llm",
    statementId: null,
    refused: null,
    ack: "",
    next: readback(origin, `So the rule is: when ${describePredicate(reading.predicate, DOMAIN)}, ${actionPhrase(DOMAIN, reading.action)}. Save it?`, { kind: "expert", request, ...wordsOf(reply) }),
  };
}

const FLIP: Record<string, ">" | ">=" | "<" | "<="> = { ">": ">=", ">=": ">", "<": "<=", "<=": "<" };

async function witnessReply(
  deps: ConversationDeps,
  snap: Snapshot,
  state: DebriefState,
  asked: Asked,
  origin: Origin,
  reply: Reply,
  plain: "yes" | "no" | "skip" | undefined,
): Promise<Outcome> {
  const view = openWitnesses(state).find((v) => v.witness.id === asked.ref);
  const moveOn = (intent: Intent, ack = "Okay."): Outcome => ({ intent, origin: "rule", statementId: null, refused: null, ack });
  if (view === undefined) return moveOn("skip", "That case is already settled.");
  if (plain === "skip") return moveOn("skip");
  const w: Witness = view.witness;
  const sessionId = snap.loaded.session.id;

  if (w.kind === "boundary") {
    if (plain === "yes") return savedOrRefused("yes", "rule", await applyExpert(deps, sessionId, { action: "confirm_boundary", witnessId: w.id, quote: reply.quote }, reply.spoken));
    const rule = state.rules.find((r) => r.rule.id === w.ruleId)?.rule;
    const atom = rule === undefined ? undefined : numericComparisons(rule.predicate).find((a) => a.feature === w.feature && a.value === w.threshold);
    if (plain === "no" && rule !== undefined && atom !== undefined) {
      const predicate = replaceComparison(rule.predicate, atom.path, FLIP[atom.op] ?? atom.op, atom.value);
      const request = { action: "revise_rule", ruleId: rule.id, predicate, witnessId: w.id };
      return { intent: "no", origin: "rule", statementId: null, refused: null, ack: "", next: readback(origin, `So the rule should be: when ${describePredicate(predicate, DOMAIN)}, ${effectPhrase(DOMAIN, rule.effect)}. Save that change?`, { kind: "expert", request, ...wordsOf(reply) }) };
    }
    return notUnderstood(asked, origin, "please answer yes or no", "Is the rule right at exactly that value? Yes or no.");
  }

  if (w.kind === "conflict") {
    const [first, second] = w.ruleIds.map((id) => state.rules.find((r) => r.rule.id === id)?.rule);
    if (first === undefined || second === undefined) return moveOn("skip", "Those rules changed since, so let's move on.");
    if (plain !== undefined) return notUnderstood(asked, origin, "I need to know which rule should win", `Which should win: the first rule (${ruleSentence(first)}) or the second (${ruleSentence(second)})?`);
    const reading = await read(
      deps,
      snap,
      { question: asked.text, allowed: ["choose_rule", "escalate", "out_of_scope"], context: `First rule: ${ruleSentence(first)}. Second rule: ${ruleSentence(second)}.`, actions: [...w.actions] },
      reply.meaning,
    );
    if (reading.kind === "choose_rule") {
      const [winner, loser] = reading.rule === "first" ? [first, second] : [second, first];
      const request = { action: "revise_rule", ruleId: winner.id, overrides: [...winner.overrides, loser.id], witnessId: w.id };
      return { intent: "statement", origin: "llm", statementId: null, refused: null, ack: "", next: readback(origin, `So "${ruleSentence(winner)}" wins over "${ruleSentence(loser)}". Save that?`, { kind: "expert", request, ...wordsOf(reply) }) };
    }
    return acknowledgeOrRetry(asked, origin, w, reading, reply, "Which rule should win, the first or the second?");
  }

  // unresolved: what would the expert do here?
  if (plain !== undefined && !(plain === "yes" && view.suggestedAction !== null)) return notUnderstood(asked, origin, "I need to know what you'd do", "What would you do with this case?");
  const reading: Reading =
    plain === "yes" && view.suggestedAction !== null
      ? { kind: "choose_action", action: view.suggestedAction }
      : await read(deps, snap, { question: asked.text, allowed: ["choose_action", "escalate", "out_of_scope"], context: `The case: ${view.conditions.join(", ")}.`, actions: actionsOfFamily(w.decisionFamily) }, reply.meaning);
  if (reading.kind === "choose_action") {
    if (view.cellRule === null) return moveOn("statement", "Noted. Confirm one of the proposed rules first, then I can save rules for cases like this.");
    const request = { action: "add_rule_for_witness", witnessId: w.id, decision: reading.action };
    return { intent: "statement", origin: plain === "yes" ? "rule" : "llm", statementId: null, refused: null, ack: "", next: readback(origin, `So when ${view.cellRule.text}, ${actionPhrase(DOMAIN, reading.action)}. Save that as a rule?`, { kind: "expert", request, ...wordsOf(reply) }) };
  }
  return acknowledgeOrRetry(asked, origin, w, reading, reply, "What would you do with this case?");
}

function acknowledgeOrRetry(asked: Asked, origin: Origin, w: Witness, reading: Reading, reply: Reply, again: string): Outcome {
  if (reading.kind === "escalate" || reading.kind === "out_of_scope") {
    const resolution = reading.kind === "escalate" ? "escalate_to_controller" : "out_of_scope";
    const request = { action: "acknowledge_witness", witnessId: w.id, resolution };
    const text = reading.kind === "escalate" ? "So cases like this go to the controller. Shall I note that?" : "So this case doesn't matter in practice. Shall I note that?";
    return { intent: "statement", origin: "llm", statementId: null, refused: null, ack: "", next: readback(origin, text, { kind: "expert", request, ...wordsOf(reply) }) };
  }
  return notUnderstood(asked, origin, reading.kind === "unclear" ? reading.why : "that didn't sound like an answer to this case", again);
}

// ── Writing turns ──

/** Runs `task` after the session's earlier conversation writes have settled (its own queue: expert actions queue separately). */
function serially<T>(deps: DebriefDeps, sessionId: string, task: () => Promise<T>): Promise<T> {
  const key = `${sessionId}#conversation`;
  const run = (deps.store.tails.get(key) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deps.store.tails.set(key, settled);
  void settled.then(() => {
    if (deps.store.tails.get(key) === settled) deps.store.tails.delete(key);
  });
  return run;
}

async function context(deps: DebriefDeps, sessionId: string): Promise<EntryContext> {
  const snap = await snapshot(deps, sessionId);
  requireOnRecord(snap.loaded.session);
  return { sessionId: snap.loaded.session.id, occurredAt: deps.now(), traceId: randomUUID(), privacyEpoch: snap.loaded.session.privacyEpoch };
}

/** The longest text a spoken question may carry (`QuestionSchema`). */
const SPOKEN_MAX = 600;

/**
 * Records the next turn and queues it for the interviewer's voice: a `debrief_turn` question (ephemeral, so the
 * gate need not wait for a work breakpoint), spoken only by the debrief page's voice loop and only once the gate
 * authorises exactly this text. Any earlier turn still waiting unspoken is dropped first.
 */
async function ask(deps: DebriefDeps, ctx: EntryContext, parents: readonly string[], item: Item & { pending?: Pending }, ack = ""): Promise<LedgerEntry> {
  const text = [ack, item.text].filter((t) => t !== "").join(" ");
  const promptId = randomUUID();
  const asked = deps.ledger.append(entry(ctx, "debrief.asked", "engine", parents, { promptId, topic: item.topic, ref: item.ref, text, pending: (item.pending ?? null) as never }));
  const snap = await snapshot(deps, ctx.sessionId);
  for (const r of snap.engine.questions.values())
    if (r.question.kind === "debrief_turn" && r.status === "queued")
      deps.ledger.append(entry(ctx, "question.dropped", "engine", [r.queuedEntryId, asked.id], { questionId: r.question.id, reason: "superseded" }));
  const spoken = text.length <= SPOKEN_MAX ? text : item.text.length <= SPOKEN_MAX ? item.text : undefined;
  if (spoken === undefined) {
    deps.log.warn(`[debrief] turn ${asked.id} is too long to speak (${text.length} characters): shown in the chat only`);
    return asked;
  }
  const question = QuestionSchema.parse({
    id: contentId("q", canonicalJson({ s: ctx.sessionId, debrief: promptId })),
    sessionId: ctx.sessionId,
    kind: "debrief_turn",
    text: spoken,
    target: { candidateIds: [] },
    value: 1,
    reason: "debrief conversation",
    ephemeral: true,
    createdAt: ctx.occurredAt,
    contextVersion: deps.authorizations.getContextVersion(ctx.sessionId),
    parentIds: [asked.id],
  });
  deps.ledger.append(entry(ctx, "question.queued", "engine", [asked.id], await localizeQuestion(deps.claude, question, snap.engine.expert?.language ?? "en", deps.log)));
  return asked;
}

const OPENING = "Let's go over what I learned. It takes a few minutes, and you can answer however you like.";

/** Starts or resumes: asks the next question unless one is already waiting. Witnesses are rebuilt first. */
export function startConversation(deps: ConversationDeps, sessionId: string): Promise<void> {
  return serially(deps.debrief, sessionId, async () => {
    const first = await snapshot(deps.debrief, sessionId);
    requireOnRecord(first.loaded.session);
    if (awaitingOf(history(first.entries)) !== undefined) return;
    await rebuildWitnesses(deps.debrief, sessionId);
    const h = history((await snapshot(deps.debrief, sessionId)).entries);
    const item = await nextItem(deps, sessionId, h);
    const last = h.asked.at(-1);
    if (item.topic === "closing" && last?.topic === "closing") return;
    await ask(deps.debrief, await context(deps.debrief, sessionId), last === undefined ? [] : [last.entry.id], item, h.asked.length === 0 ? OPENING : "");
  });
}

/** A spoken reply: the `debrief_turn` question it answers and its transcript segments, in order (each an `utterance.transcript`). */
export type SpokenReply = { questionId: string; utteranceIds: string[] };

/**
 * A spoken reply as the conversation reads it, or undefined when it is stale: it counts only if its question is
 * the `debrief_turn` queued for the turn now waiting (after the closing, the latest closing turn) and every
 * segment is an utterance answering that question. A reply to a turn already answered (in the chat, say) or
 * superseded is logged and ignored, never applied to whatever is asked now.
 *
 * Recorded: the expert's original words (segments joined). Read: the English translation of a segment in another
 * language when one is verified, else its words. Cited: the longest segment, verbatim, with its utterance.
 */
/** The longest reply a `debrief.replied` entry holds. */
const REPLY_MAX = 1000;

function spokenReply(deps: DebriefDeps, snap: Snapshot, asked: Asked | undefined, spoken: SpokenReply): Reply | undefined {
  const question = snap.engine.questions.get(spoken.questionId)?.question;
  if (asked === undefined || question?.kind !== "debrief_turn" || !question.parentIds.includes(asked.entry.id)) {
    deps.log.info(`[debrief] spoken reply to ${spoken.questionId} ignored: it does not answer the turn now waiting (stale)`);
    return undefined;
  }
  const segments = spoken.utteranceIds.map((id) => snap.engine.utterances.get(id)).filter((u): u is UtteranceRecord => u?.questionId === spoken.questionId);
  const [first, ...rest] = segments;
  if (first === undefined || segments.length !== spoken.utteranceIds.length) {
    deps.log.warn(`[debrief] spoken reply to ${spoken.questionId} ignored: its segments are not utterances answering that question`);
    return undefined;
  }
  const longest = rest.reduce((a, b) => (b.text.length > a.text.length ? b : a), first);
  const words = segments.map((u) => u.text).join(" ");
  return {
    // The reply record shows at most REPLY_MAX characters; the full words stay in the utterances it cites as parents.
    text: words.length <= REPLY_MAX ? words : `${words.slice(0, REPLY_MAX - 1)}…`,
    meaning: segments.map((u) => (u.language !== "en" && u.translation !== undefined ? u.translation.text : u.text)).join(" "),
    quote: longest.text,
    spoken: { utteranceId: longest.entryId },
  };
}

/**
 * The expert's reply to the waiting question (or, after the closing, a new rule they volunteer): typed (`chat`),
 * or spoken to the interviewer (`spoken`, see `spokenReply`; a stale one is ignored). `utteranceId` is kept on
 * the record for a chat reply the client heard; only `spoken` makes the words voice evidence.
 */
export function replyToConversation(
  deps: ConversationDeps,
  sessionId: string,
  input: { text: string; via: "chat" | "voice"; utteranceId?: string; spoken?: SpokenReply },
): Promise<void> {
  return serially(deps.debrief, sessionId, async () => {
    const snap = await snapshot(deps.debrief, sessionId);
    requireOnRecord(snap.loaded.session);
    const h = history(snap.entries);
    const last = h.asked.at(-1);
    let asked = awaitingOf(h);
    if (asked === undefined && last?.topic === "closing") asked = { ...last, topic: "stop_rules", ref: "after-closing" };
    const reply: Reply | undefined = input.spoken === undefined ? { text: input.text, meaning: input.text, quote: input.text, spoken: undefined } : spokenReply(deps.debrief, snap, asked, input.spoken);
    if (reply === undefined) return;
    if (asked === undefined) throw new ApiFailure(409, "nothing_asked", "start the conversation first");
    const ctx = await context(deps.debrief, sessionId);
    const replied = deps.debrief.ledger.append(
      entry(ctx, "debrief.replied", "expert", [...new Set([asked.entry.id, ...(input.spoken?.utteranceIds ?? [])])], {
        promptId: asked.promptId,
        text: reply.text,
        via: input.via,
        utteranceId: reply.spoken?.utteranceId ?? input.utteranceId ?? null,
      }),
    );
    const outcome = await understand(deps, sessionId, asked, reply);
    const parents = [replied.id, ...(outcome.statementId === null ? [] : [outcome.statementId])];
    deps.debrief.ledger.append(
      entry(ctx, "debrief.understood", "engine", parents, {
        promptId: asked.promptId,
        replyId: replied.id,
        intent: outcome.intent,
        origin: outcome.origin,
        statementId: outcome.statementId,
        refused: outcome.refused,
      }),
    );
    // A confirmed or dismissed concept changes the feature model: rerun the solver under it before the next question.
    if (outcome.statementId !== null && (asked.topic === "concept" || asked.pending?.kind === "concept")) await rebuildWitnesses(deps.debrief, sessionId);
    const next = outcome.next ?? (await nextItem(deps, sessionId, history((await snapshot(deps.debrief, sessionId)).entries)));
    await ask(deps.debrief, { ...ctx, occurredAt: deps.debrief.now() }, [replied.id], next, outcome.ack);
  });
}

/**
 * The interview's hand-off of a spoken reply to a debrief turn (`InterviewDeps.debriefAnswer`): the transcript
 * segments collected for that turn's `debrief_turn` question, as one voice reply (stale ones are ignored).
 */
export function replyBySpeech(deps: ConversationDeps, input: { sessionId: string; questionId: string; segments: readonly { id: string; text: string }[] }): Promise<void> {
  return replyToConversation(deps, input.sessionId, {
    text: input.segments.map((s) => s.text).join(" "),
    via: "voice",
    spoken: { questionId: input.questionId, utteranceIds: input.segments.map((s) => s.id) },
  });
}

// ── The view ──

export async function conversationView(deps: ConversationDeps, sessionId: string): Promise<DebriefConversation> {
  const snap = await snapshot(deps.debrief, sessionId);
  const h = history(snap.entries);
  const turns: DebriefTurn[] = h.order.map((e) => {
    if (e.kind === "debrief.asked") {
      const p = parseLedgerPayload(e, "debrief.asked");
      return { id: e.id, role: "agent", text: p.text, at: e.occurredAt, via: null, outcome: null };
    }
    const p = parseLedgerPayload(e, "debrief.replied");
    const u = h.understood.get(p.promptId);
    return {
      id: e.id,
      role: "expert",
      text: p.text,
      at: e.occurredAt,
      via: p.via,
      outcome: u === undefined ? null : { readAs: u.intent, byModel: u.origin === "llm", saved: u.statementId !== null, refused: u.refused },
    };
  });
  const awaiting = awaitingOf(h);
  const last = h.asked.at(-1);
  return {
    sessionId: snap.loaded.session.id,
    turns,
    awaiting: awaiting === undefined ? null : { promptId: awaiting.promptId, topic: awaiting.topic, text: awaiting.text },
    done: last?.topic === "closing",
    llmAvailable: deps.debrief.claude !== null,
    session: { offRecord: snap.loaded.session.offRecord, privacyEpoch: snap.loaded.session.privacyEpoch, expertLanguage: snap.engine.expert?.language ?? "en" },
    state: debriefState(deps.debrief, snap),
  };
}

