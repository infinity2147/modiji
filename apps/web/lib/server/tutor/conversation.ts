/**
 * The trainee's voice coach as a conversation: whatever the trainee says (a final transcript in a novice session,
 * handed over by the interview's utterance path) or types (`/tutor/chat`) gets an answer, grounded in the expert's
 * confirmed rulebook and the case the trainee is working on, and spoken through the same authorized path as every
 * other coach turn (`queueCoachTurn` → gate → nonce → custom LLM speaks exactly this text).
 *
 * LLMs infer, code enforces:
 * - The model (Sonnet 5.5, structured output, ~6 s deadline) sees only the confirmed rules (plain wording, the
 *   expert's own words, the trainee's rung on the ladder), the current case's decision features with the trainee's
 *   edits, what the RULEBOOK implies for it (`expectedOutcome`; the hidden-policy oracle is never consulted, a
 *   static test guards the tutor's imports), the trainee's prediction, selection, warnings and decision on it, the
 *   last turns of the conversation and any screen observations perception recorded. Nothing else.
 * - Its reply is checked by code (`checkReply`): cited rules must be ones it was shown, the reply short and free of
 *   control text, every quote of the expert verbatim from a cited rule, no claim about "the expert" without a
 *   cited rule, and no outcome given away while a prediction is pending. A reply that fails, a late or failed
 *   call, or no model at all falls back to a deterministic template from the rulebook (`origin: "template"`):
 *   the coach ALWAYS answers.
 * - A trainee who keeps talking supersedes the reply being prepared: only a reply to the trainee's latest words
 *   is queued (a newer utterance or chat message on the ledger means this one is stale), and nothing is queued
 *   or written once the session went off the record or changed its privacy epoch meanwhile.
 * - Provenance: `tutor.coached` (trigger `reply`) cites the trainee's words (utterance or chat entries), the entry
 *   that put the current case on screen, and the cited rules' entries (added by `queueCoachTurn`).
 */
import "server-only";
import { z } from "zod";
import {
  MASTERY_LEVELS,
  actionPhrase,
  findFeature,
  formatValue,
  isUnknown,
  parseLedgerPayload,
  ruleFires,
  wordCount,
  type ActionId,
  type ConfirmedRule,
  type LedgerEntry,
  type MasteryLevel,
} from "@vashistha/core";
import type { Claude, Ledger } from "@vashistha/core/server";
import { KYC_DOMAIN, type KycCase } from "@vashistha/core/domains/kyc";
import { ReviewEditsSchema } from "../../contracts/casedesk";
import type { CoachTurnView } from "../../contracts/tutor";
import { ApiFailure } from "../casedesk/http";
import type { LoadedSession } from "../casedesk/session";
import { entry } from "../interview/ledger";
import { REASONING_MODEL } from "../interview/llm";
import { briefingId } from "./briefing";
import { MAX_COACH_CHARS, clampSpeech, queueCoachTurn } from "./coach";
import type { TutorDeps } from "./deps";
import { casePrompt, expectedOutcome, type Expected } from "./predict";
import { isStopRule, primaryQuote, taughtRules, thenText, whenText } from "./rules";
import { caseLookup, entryContext, loadNoviceSession, requireSessionCase, type ReviewEdits } from "./session";
import { tutorRecord, type Recorded, type TutorRecord } from "./state";

/** The model that writes coach replies (`CLAUDE_MODELS.reasoning`; Haiku 4.5 is the frame extractor's and retires in October 2026). */
export const COACH_MODEL = REASONING_MODEL;
/** A spoken reply must come quickly; a late one is replaced by the template. */
export const COACH_DEADLINE_MS = 6_000;
/** What a reply may say: one to three short spoken sentences. */
export const MAX_REPLY_WORDS = 60;
/** Conversation turns the model sees before the trainee's latest words. */
const HISTORY_TURNS = 8;
/** Turns `TutorState.coach` carries for live captions. */
export const CAPTION_TURNS = 20;
/** Vision screen observations the model sees (perception, when it ran). */
const VISION_EVENTS = 5;
/** Rules listed to the model, at most (a rulebook is small; this bounds the prompt). */
const MAX_PROMPT_RULES = 30;

/** Anything that looks like the control channel (`⟦ctl:…⟧`) is never the trainee's words and never coach speech. */
const CONTROL_MARK = /⟦|⟧|ctl:/;

// ── The conversation as the ledger records it ──

/** One conversation turn; `english` is what the model reads (a trainee's verified translation, else the words). */
export type CoachTurn = CoachTurnView & { english: string };

/** The kinds that say which case is on the trainee's screen (latest wins; returning to the queue clears it). */
function caseOf(e: LedgerEntry): string | null | undefined {
  switch (e.kind) {
    case "screen.event": {
      const p = parseLedgerPayload(e, "screen.event");
      if (p.kind === "navigate") return null;
      return p.caseId;
    }
    case "tutor.intent":
      return parseLedgerPayload(e, "tutor.intent").caseId;
    case "tutor.prediction":
      return parseLedgerPayload(e, "tutor.prediction").caseId;
    case "case.decision":
      return parseLedgerPayload(e, "case.decision").caseId;
    default:
      return undefined;
  }
}

const FOLD_KINDS = [
  "utterance.transcript",
  "utterance.translated",
  "tutor.chat",
  "tutor.coached",
  "question.queued",
  "question.dropped",
  "gate.authorized",
  "question.requeued",
  "screen.event",
  "tutor.intent",
  "tutor.prediction",
  "case.decision",
] as const;

export type CoachFold = {
  turns: CoachTurn[];
  /** The case on the trainee's screen now, and the entry that put it there (a provenance parent of a reply). */
  current: { caseId: string; entryId: string } | null;
  /** The analyst risk rating the trainee set per case (the only reviewer edit), from selections and field changes. */
  riskRatings: Map<string, unknown>;
  /** The latest trainee words (utterance or chat entry id): a reply to anything older is superseded. */
  latestTraineeEntry: string | undefined;
  /** Vision screen observations (perception), oldest first. */
  vision: LedgerEntry[];
};

/**
 * Folds the coach conversation from the session's ledger: trainee turns (final transcripts and typed chat), coach
 * turns (coach replies and nudges, the welcome briefing, stop-rule warnings), the case on screen, the trainee's
 * risk rating per case, and perception's screen observations. Coach turns that were withdrawn before they were
 * spoken are left out, except replies to the trainee (a typed reply was read even if never voiced).
 */
export function foldCoach(ledger: Pick<Ledger, "list">, sessionId: string): CoachFold {
  const turns: CoachTurn[] = [];
  const triggers = new Map<string, string>();
  const spoken = new Set<string>();
  const dropped = new Set<string>();
  const riskRatings = new Map<string, unknown>();
  const vision: LedgerEntry[] = [];
  let current: CoachFold["current"] = null;
  let latestTraineeEntry: string | undefined;
  const caseNow = (): string | null => current?.caseId ?? null;
  for (const e of ledger.list(sessionId, { kinds: FOLD_KINDS })) {
    const onScreen = caseOf(e);
    if (onScreen === null) current = null;
    else if (onScreen !== undefined) current = { caseId: onScreen, entryId: e.id };
    switch (e.kind) {
      case "utterance.transcript": {
        if (e.source !== "voice") break;
        const p = parseLedgerPayload(e, "utterance.transcript");
        if (CONTROL_MARK.test(p.text)) break;
        turns.push({ id: e.id, role: "trainee", text: p.text, english: p.text, at: e.occurredAt, caseId: caseNow(), trigger: null, spoken: true });
        latestTraineeEntry = e.id;
        break;
      }
      case "utterance.translated": {
        const p = parseLedgerPayload(e, "utterance.translated");
        const turn = turns.findLast((t) => t.id === p.utteranceId);
        if (turn !== undefined) turn.english = p.translation;
        break;
      }
      case "tutor.chat": {
        const { text } = parseLedgerPayload(e, "tutor.chat");
        turns.push({ id: e.id, role: "trainee", text, english: text, at: e.occurredAt, caseId: caseNow(), trigger: null, spoken: false });
        latestTraineeEntry = e.id;
        break;
      }
      case "tutor.coached": {
        const p = parseLedgerPayload(e, "tutor.coached");
        triggers.set(p.questionId, p.trigger);
        break;
      }
      case "question.queued": {
        const q = parseLedgerPayload(e, "question.queued");
        if (q.kind !== "coach_turn" && q.kind !== "intervention") break;
        const trigger = q.kind === "coach_turn" ? (triggers.get(q.id) ?? "reply") : q.id === briefingId(sessionId) ? "briefing" : "intervention";
        turns.push({ id: q.id, role: "coach", text: q.text, english: q.text, at: e.occurredAt, caseId: q.target.caseId ?? null, trigger, spoken: false });
        break;
      }
      case "gate.authorized":
        spoken.add(parseLedgerPayload(e, "gate.authorized").questionId);
        break;
      case "question.requeued":
        spoken.delete(parseLedgerPayload(e, "question.requeued").questionId);
        break;
      case "question.dropped":
        dropped.add(parseLedgerPayload(e, "question.dropped").questionId);
        break;
      case "screen.event": {
        const p = parseLedgerPayload(e, "screen.event");
        if (e.source === "vision") vision.push(e);
        else if (p.kind === "field_change" && p.field === "riskRating" && p.caseId !== undefined) riskRatings.set(p.caseId, p.to);
        break;
      }
      case "tutor.intent": {
        const p = parseLedgerPayload(e, "tutor.intent");
        riskRatings.set(p.caseId, (p.edits as Record<string, unknown>)["riskRating"]);
        break;
      }
    }
  }
  const visible = turns.flatMap((t) => {
    if (t.role === "trainee") return [t];
    const said = spoken.has(t.id);
    if (dropped.has(t.id) && !said && t.trigger !== "reply") return [];
    return [{ ...t, spoken: said }];
  });
  return { turns: visible, current, riskRatings, latestTraineeEntry, vision: vision.slice(-VISION_EVENTS) };
}

/** `TutorState.coach`: the latest conversation turns for live captions (oldest first). */
export function coachTurnViews(ledger: Pick<Ledger, "list">, sessionId: string): CoachTurnView[] {
  return foldCoach(ledger, sessionId)
    .turns.slice(-CAPTION_TURNS)
    .map(({ english: _english, ...view }) => view);
}

// ── What the coach knows when it answers ──

export type RuleBrief = {
  /** The label the model cites ("R1"); mapped back to the rule id by code. */
  label: string;
  rule: ConfirmedRule;
  when: string;
  then: string;
  stopRule: boolean;
  /** The expert's words as the (English) coach may voice them, or null (a quote in another language without a translation). */
  quote: string | null;
  level: MasteryLevel;
  /** On the current case: whether the rule's conditions hold (null without a case). */
  fires: boolean | "unknown" | null;
};

export type CaseBrief = {
  kycCase: KycCase;
  edits: ReviewEdits;
  /** The entry that put the case on screen. */
  anchorEntryId: string;
  /** What the expert's confirmed rules decide for it (never the oracle). */
  expected: Expected;
  /** "What would the expert decide?" is still open: the outcome must not be given away. */
  predictionPending: boolean;
  prediction: Recorded<"tutor.prediction"> | undefined;
  selected: ActionId | undefined;
  decided: ActionId | undefined;
  /** The stop-rule warnings already given on this case (their spoken text). */
  warnings: string[];
};

export type CoachContext = {
  rules: RuleBrief[];
  current: CaseBrief | null;
  history: CoachTurn[];
  vision: string[];
  /** The trainee's words being answered (English for the model). */
  words: string;
};

/** The expert's words as the English coach voices them: verbatim, or the labelled machine translation, or nothing. */
function spokenQuote(rule: ConfirmedRule): string | null {
  const quote = primaryQuote(rule);
  if (quote.language === undefined || quote.language === "en") return quote.exactQuote;
  return quote.translation ?? null;
}

function quoteSentence(brief: RuleBrief): string {
  if (brief.quote === null) return "";
  const { language } = primaryQuote(brief.rule);
  return language === undefined || language === "en" ? `The expert said: "${brief.quote}"` : `The expert said, in machine translation: "${brief.quote}"`;
}

function sessionCase(deps: TutorDeps, loaded: LoadedSession, caseId: string): KycCase | undefined {
  try {
    return requireSessionCase(deps, loaded, caseId);
  } catch {
    return undefined;
  }
}

function caseBrief(deps: TutorDeps, loaded: LoadedSession, fold: CoachFold, record: TutorRecord, rules: readonly ConfirmedRule[]): CaseBrief | null {
  if (fold.current === null) return null;
  const kycCase = sessionCase(deps, loaded, fold.current.caseId);
  if (kycCase === undefined) return null;
  const rated = ReviewEditsSchema.safeParse({ riskRating: fold.riskRatings.get(kycCase.id) });
  const edits: ReviewEdits = rated.success ? rated.data : {};
  const decision = record.decisions.get(kycCase.id);
  return {
    kycCase,
    edits,
    anchorEntryId: fold.current.entryId,
    expected: expectedOutcome(rules, kycCase, edits),
    predictionPending: casePrompt(record, rules, kycCase).ask,
    prediction: record.predictions.get(kycCase.id),
    selected: decision === undefined ? record.intents.get(kycCase.id)?.payload.proposedAction : undefined,
    decided: decision?.payload.action,
    warnings: record.interventions
      .filter((i) => i.payload.caseId === kycCase.id)
      .flatMap((i) => record.interventionQuestions.get(i.payload.questionId)?.text ?? []),
  };
}

function observation(e: LedgerEntry): string {
  const p = parseLedgerPayload(e, "screen.event");
  const sure = `(confidence ${p.confidence.toFixed(2)})`;
  switch (p.kind) {
    case "open_case":
      return `opened case ${p.caseId ?? ""} ${sure}`;
    case "navigate":
      return `went back to the case queue ${sure}`;
    case "field_change": {
      const feature = findFeature(KYC_DOMAIN, p.field ?? "");
      return `changed ${feature?.label ?? p.field ?? "a field"} to ${p.to === undefined ? "?" : formatValue(feature, p.to)} ${sure}`;
    }
    case "action":
      return `chose ${p.action === undefined ? "an outcome" : actionPhrase(KYC_DOMAIN, p.action)} ${sure}`;
  }
}

/** Everything the coach may know when it answers `words`, from the ledger and the confirmed rulebook only. */
export function coachContext(deps: TutorDeps, loaded: LoadedSession, words: string): CoachContext {
  const { session } = loaded;
  const book = deps.rulebook();
  const fold = foldCoach(deps.ledger, session.id);
  const record = tutorRecord(deps.ledger, session.id);
  const current = caseBrief(deps, loaded, fold, record, book.rules);
  const lookup = current === null ? undefined : caseLookup(current.kycCase, current.edits);
  const rules = taughtRules(book.rules)
    .slice(0, MAX_PROMPT_RULES)
    .map(
      (rule, i): RuleBrief => ({
        label: `R${i + 1}`,
        rule,
        when: whenText(rule),
        then: thenText(rule),
        stopRule: isStopRule(rule),
        quote: spokenQuote(rule),
        level: record.mastery.get(rule.id) ?? "untested",
        fires: lookup === undefined ? null : ruleFires(rule, book.rules, lookup),
      }),
    );
  return {
    rules,
    current,
    history: fold.turns.slice(-HISTORY_TURNS),
    vision: fold.vision.map(observation),
    words,
  };
}

// ── The model ──

export const COACH_SYSTEM = `You are the voice coach of a trainee who is learning to review customer onboarding (KYC) cases at a fictional bank (synthetic data, fictional policy). Everything you teach comes from the confirmed rules of the bank's experts, listed in the request with each expert's own words. Your reply is spoken aloud.

How to coach:
- Speak plain English: one to three short sentences, at most ${MAX_REPLY_WORDS} words. No lists, no markdown, and never say rule labels such as R1 aloud.
- If the trainee asks a question, answer it directly first, from the listed rules and the case facts only.
- If the trainee reasons toward an outcome the expert's rules do not reach, do not just say they are wrong: point at the case fact they missed, and give the expert's own words for the rule that decides it.
- If the request says a prediction is pending on the current case, never say or hint which outcome the expert would choose. Guide the trainee to the facts that decide it and ask what they think. If they state an outcome, ask which fact made them choose it, and ask them to record their prediction on screen.
- Once the trainee has predicted or decided, you may explain the expert's outcome and why.
- Never invent a rule, a threshold, a quote or a case fact. If the listed rules do not cover what they ask, say the experts have not given a rule for that yet.
- Quote the expert only with words copied exactly from the listed expert's words (or the listed English translation), inside double quotes, and cite that rule.
- If the trainee says something unrelated to the cases, answer in a few words and steer back to the case.
- Be warm and brief. End most turns with one short question or next step, so the conversation keeps going.
- Always answer in English, even when the trainee speaks another language.
- citedRules: the labels (R1, R2, ...) of every rule your reply relies on or quotes; empty when none.`;

/** What the model may return. Flat and fully required, as constrained decoding needs. */
export const LlmCoachReplySchema = z.strictObject({
  reply: z.string().describe(`What the coach says aloud: plain spoken English, at most ${MAX_REPLY_WORDS} words`),
  citedRules: z.array(z.string()).describe("Labels (R1, R2, ...) of every listed rule the reply relies on or quotes; empty when none"),
  intent: z
    .enum(["answer", "hint", "check_understanding", "correct_misconception", "encourage", "off_topic"])
    .describe("What this turn does for the trainee"),
});
export type LlmCoachReply = z.infer<typeof LlmCoachReplySchema>;

function featureLines(c: CaseBrief): string[] {
  const lookup = caseLookup(c.kycCase, c.edits);
  return KYC_DOMAIN.features.flatMap((f) => {
    const v = lookup(f.id);
    return isUnknown(v) ? [] : [`  ${f.label}: ${formatValue(f, v)}`];
  });
}

function ruleLine(r: RuleBrief): string {
  const quote = r.quote === null ? "(the expert's words are in another language, untranslated)" : `"${r.quote}"`;
  const fires = r.fires === null ? "" : ` On the current case: ${r.fires === true ? "applies" : r.fires === false ? "does not apply" : "cannot tell (details missing)"}.`;
  return `${r.label}${r.stopRule ? " [stop rule]" : ""}: when ${r.when}, ${r.then}. Expert's words: ${quote} Trainee's mastery: ${r.level}.${fires}`;
}

function caseSection(ctx: CoachContext): string[] {
  const c = ctx.current;
  if (c === null) return ["CURRENT CASE: none open (the trainee is at the case queue)."];
  const label = (ids: readonly string[]): string => ids.map((id) => ctx.rules.find((r) => r.rule.id === id)?.label ?? "an unlisted rule").join(", ");
  const expected =
    c.expected.kind === "decided"
      ? `the expert's rules decide: ${actionPhrase(KYC_DOMAIN, c.expected.action)} (by ${label(c.expected.ruleIds)})`
      : `no outcome: ${c.expected.reason}`;
  const lines = [`CURRENT CASE ${c.kycCase.id} (${c.kycCase.customer.entityType}, ${c.kycCase.customer.country}):`, ...featureLines(c)];
  lines.push(
    c.predictionPending
      ? `PREDICTION PENDING: the trainee has not yet said what the expert would decide. Do NOT reveal or hint the outcome. (For you only: ${expected}.)`
      : `What the expert's rules imply: ${expected}.`,
  );
  if (c.prediction !== undefined)
    lines.push(`Trainee's prediction: ${actionPhrase(KYC_DOMAIN, c.prediction.payload.predicted)} (${c.prediction.payload.correct ? "correct" : "wrong"}; revealed to the trainee).`);
  if (c.selected !== undefined) lines.push(`Outcome the trainee has selected (not saved yet): ${actionPhrase(KYC_DOMAIN, c.selected)}.`);
  if (c.decided !== undefined) lines.push(`Decision the trainee saved: ${actionPhrase(KYC_DOMAIN, c.decided)}.`);
  for (const w of c.warnings) lines.push(`Warning the coach already gave on this case: ${w}`);
  return lines;
}

/** The request the model sees. Built from the rulebook, the case and the conversation only. */
export function coachPrompt(ctx: CoachContext): string {
  const rules = ctx.rules.length === 0 ? ["(none yet: the experts have not confirmed any rule)"] : ctx.rules.map(ruleLine);
  const history = ctx.history.length === 0 ? ["(this is the first thing the trainee says)"] : ctx.history.map((t) => `${t.role === "trainee" ? "Trainee" : "Coach"}: ${t.english}`);
  return [
    "EXPERT RULES (confirmed):",
    ...rules,
    "",
    ...caseSection(ctx),
    ...(ctx.vision.length === 0 ? [] : ["", "WHAT THE SCREEN CAPTURE SAW RECENTLY (machine vision, may be wrong):", ...ctx.vision.map((v) => `  ${v}`)]),
    "",
    "CONVERSATION SO FAR:",
    ...history,
    "",
    `THE TRAINEE JUST SAID: ${ctx.words}`,
  ].join("\n");
}

class CoachDeadlineError extends Error {
  override readonly name: string = "CoachDeadlineError";
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CoachDeadlineError(`the coach model did not answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(claude: Claude, ctx: CoachContext): Promise<LlmCoachReply> {
  const { output } = await withDeadline(
    claude.structured({
      model: COACH_MODEL,
      system: COACH_SYSTEM,
      messages: [{ role: "user", content: coachPrompt(ctx) }],
      maxTokens: 400,
      cacheSystem: true,
      schema: LlmCoachReplySchema,
    }),
    COACH_DEADLINE_MS,
  );
  return output;
}

// ── Code checks ──

export type Drafted = { text: string; ruleIds: string[]; origin: "llm" | "template" };
export type Checked = { ok: true; reply: Drafted } | { ok: false; reason: string };

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Words that name each review outcome, for the "do not give the answer away" check. */
const OUTCOME_WORDS: Record<string, RegExp> = {
  approve: /\bapprov/i,
  enhancedReview: /\benhanced\b/i,
  requestDocuments: /\brequest(?:ing)?\s+(?:the\s+|more\s+|some\s+)?documents?\b|\bask(?:ing)?\s+for\s+(?:the\s+|more\s+)?documents?\b/i,
  escalateCompliance: /\bescalat/i,
  reject: /\breject|\bdecline/i,
};

/** Says what the expert said, would do or holds ("the expert would…", "the expert's rule…"); "the experts have not…" is fine. */
const SPEAKS_FOR_EXPERT = /\bexperts?(?:'s|s')?\s+(?:said|says|say|told|tells|would|wants?|always|never|rule|words|decides?)\b/i;

function namesOutcome(text: string, action: ActionId): boolean {
  const words = OUTCOME_WORDS[action];
  return words === undefined ? norm(text).includes(norm(actionPhrase(KYC_DOMAIN, action))) : words.test(text);
}

/**
 * The code-side checks of a model reply (see the module doc). Returns the reply to speak with its rule ids, or why
 * it was rejected.
 */
export function checkReply(output: LlmCoachReply, ctx: CoachContext): Checked {
  const text = output.reply.replace(/\s+/g, " ").trim();
  if (text === "") return { ok: false, reason: "empty reply" };
  if (CONTROL_MARK.test(text)) return { ok: false, reason: "control text in the reply" };
  if (wordCount(text) > MAX_REPLY_WORDS) return { ok: false, reason: `${wordCount(text)} words (at most ${MAX_REPLY_WORDS})` };
  if (text.length > MAX_COACH_CHARS) return { ok: false, reason: `${text.length} characters (at most ${MAX_COACH_CHARS})` };
  if (/\bR\d+\b/.test(text)) return { ok: false, reason: "a rule label in the spoken reply" };
  const byLabel = new Map(ctx.rules.map((r) => [r.label, r]));
  const cited: RuleBrief[] = [];
  for (const label of output.citedRules) {
    const brief = byLabel.get(label.trim().toUpperCase());
    if (brief === undefined) return { ok: false, reason: `cites ${JSON.stringify(label)}, not a listed rule` };
    if (!cited.includes(brief)) cited.push(brief);
  }
  if (cited.length === 0 && SPEAKS_FOR_EXPERT.test(text)) return { ok: false, reason: "speaks for the expert without citing a rule" };
  const sources = [...cited.flatMap((r) => (r.quote === null ? [] : [norm(r.quote)])), norm(ctx.words)];
  for (const m of text.matchAll(/["“]([^"“”]+)["”]/g)) {
    const quoted = norm(m[1] ?? "");
    if (wordCount(quoted) >= 3 && !sources.some((s) => s.includes(quoted))) return { ok: false, reason: "a quote that is not the cited expert's words" };
  }
  const c = ctx.current;
  if (c?.predictionPending === true && c.expected.kind === "decided" && namesOutcome(text, c.expected.action))
    return { ok: false, reason: "gives the outcome away while a prediction is pending" };
  return { ok: true, reply: { text, ruleIds: cited.map((r) => r.rule.id), origin: "llm" } };
}

// ── The template (no model, a late one, or a reply that failed the checks) ──

/** The first candidate that fits a spoken turn. */
function fitting(candidates: readonly string[]): string {
  const fits = candidates.find((c) => c.length <= MAX_COACH_CHARS && wordCount(c) <= MAX_REPLY_WORDS + 15);
  return fits ?? clampSpeech(candidates.at(-1) ?? "");
}

function joined(...parts: string[]): string {
  return parts.filter((p) => p !== "").join(" ");
}

/**
 * A deterministic reply from the rulebook and the case: the rule that decides the case with the expert's words
 * (or, while a prediction is pending, only the conditions to check — never the outcome), else a stop-rule that
 * fires on it, else the focus rule; always ending with a question. Never empty.
 */
export function templateReply(ctx: CoachContext): Drafted {
  const draft = (ruleIds: string[], ...candidates: string[]): Drafted => ({ text: fitting(candidates), ruleIds, origin: "template" });
  const [head, ...rest] = ctx.rules;
  if (head === undefined)
    return draft(
      [],
      "The experts have not confirmed any rules yet, so I cannot tell you what they would decide. Tell me what you notice in the case, and we will think it through together.",
    );
  const c = ctx.current;
  if (c === null) {
    // The least-learned rule (ties: rulebook order), as the briefing picks it.
    const focus = rest.reduce((best, r) => (MASTERY_LEVELS.indexOf(r.level) < MASTERY_LEVELS.indexOf(best.level) ? r : best), head);
    return draft(
      [focus.rule.id],
      `Open a case and tell me what you notice. One rule to keep in mind: when ${focus.when}, ${focus.then}. What would you check first?`,
      "Open a case and tell me what you notice first. What would you check?",
    );
  }
  if (c.expected.kind === "decided") {
    const deciding = c.expected.ruleIds.flatMap((id) => ctx.rules.filter((r) => r.rule.id === id));
    const first = deciding[0];
    if (first !== undefined && c.predictionPending)
      return draft(
        [first.rule.id],
        `Before you decide, check this: the experts have a rule for when ${first.when}. Does that hold for this case? What do you think they would do?`,
        "Before you decide, look at the facts the expert's rules depend on. What do you think the expert would do here, and why?",
      );
    if (first !== undefined)
      return draft(
        [first.rule.id],
        joined(`On this case the expert's rule is: when ${first.when}, ${first.then}.`, quoteSentence(first), "Which fact in the case tells you it applies?"),
        `On this case the expert's rule is: when ${first.when}, ${first.then}. Which fact in the case tells you it applies?`,
        `The expert's rule here says: ${first.then}. Which fact in the case tells you it applies?`,
      );
  }
  const stop = ctx.rules.find((r) => r.stopRule && r.fires === true);
  if (stop !== undefined)
    return draft(
      [stop.rule.id],
      joined(`One thing to watch on this case: ${stop.then} when ${stop.when}.`, quoteSentence(stop), "What else do you see?"),
      `One thing to watch on this case: ${stop.then} when ${stop.when}. What else do you see?`,
    );
  const reason = c.expected.kind === "none" ? c.expected.reason : "";
  return draft([], joined(reason, "What stands out to you in this case?"), "What stands out to you in this case?");
}

// ── Answering ──

export type TraineeWords = {
  /** The trainee's words in English (a voice segment's verified translation, else the words as said or typed). */
  text: string;
  /** The ledger entries holding them: utterance segments (voice) or the chat entry. */
  entryIds: readonly string[];
  /** The privacy epoch they were recorded in: a reply never crosses an off-record stretch. */
  privacyEpoch: number;
};

export type CoachReply = {
  /** The queued `coach_turn` question, or null when nothing was queued (superseded by newer words). */
  questionId: string | null;
  text: string;
  ruleIds: string[];
  origin: "llm" | "template";
};

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function stopped(loaded: LoadedSession, epoch: number): boolean {
  return loaded.session.offRecord || loaded.session.archived || loaded.session.privacyEpoch !== epoch;
}

/**
 * Answers the trainee's words: drafts a reply (model, checked; else the template), then queues it as a coach turn
 * unless newer trainee words have arrived meanwhile. Returns null when the session is off the record, archived or
 * changed its privacy epoch (before or while the reply was drafted): nothing is said and nothing is written.
 */
export async function coachReply(deps: TutorDeps, sessionId: string, words: TraineeWords): Promise<CoachReply | null> {
  const loaded = loadNoviceSession(deps, sessionId);
  if (stopped(loaded, words.privacyEpoch)) return null;
  const ctx = coachContext(deps, loaded, words.text);
  let drafted: Drafted | undefined;
  const claude = deps.claude ?? null;
  if (claude !== null) {
    try {
      const checked = checkReply(await askModel(claude, ctx), ctx);
      if (checked.ok) drafted = checked.reply;
      else deps.log.info(`[tutor] coach reply to ${words.entryIds.join(", ")} rejected (${checked.reason}); template used`);
    } catch (error) {
      deps.log.warn(`[tutor] coach model failed for ${words.entryIds.join(", ")}; template used: ${describeError(error)}`);
    }
  }
  const reply = drafted ?? templateReply(ctx);
  const text = clampSpeech(reply.text);
  const after = loadNoviceSession(deps, sessionId);
  if (stopped(after, words.privacyEpoch)) {
    deps.log.info(`[tutor] session ${sessionId} went off the record while the coach answered ${words.entryIds.join(", ")}; nothing said`);
    return null;
  }
  const fold = foldCoach(deps.ledger, sessionId);
  if (fold.latestTraineeEntry !== undefined && !words.entryIds.includes(fold.latestTraineeEntry)) {
    deps.log.info(`[tutor] coach reply to ${words.entryIds.join(", ")} superseded by ${fold.latestTraineeEntry}`);
    return { questionId: null, text, ruleIds: reply.ruleIds, origin: reply.origin };
  }
  const questionId = queueCoachTurn(deps, after, {
    text,
    trigger: "reply",
    caseId: ctx.current?.kycCase.id ?? null,
    ruleIds: reply.ruleIds,
    utteranceId: words.entryIds.at(-1) ?? null,
    origin: reply.origin,
    parents: [...words.entryIds, ...(ctx.current === null ? [] : [ctx.current.anchorEntryId])],
  });
  return { questionId, text, ruleIds: reply.ruleIds, origin: reply.origin };
}

/**
 * The interview's hand-off of what a trainee said (`InterviewDeps.coachReply`): the final transcript segments of
 * one turn, answered as one. Control text is never the trainee's words. A non-English segment is read through its
 * verified translation (the coach answers in English).
 */
export async function replyBySpeech(
  deps: TutorDeps,
  input: { sessionId: string; segments: readonly { id: string; text: string; translation?: string | undefined }[] },
): Promise<void> {
  const segments = input.segments.filter((s) => !CONTROL_MARK.test(s.text));
  const first = segments[0];
  if (first === undefined) return;
  const recorded = deps.ledger.get(first.id);
  if (recorded === undefined) return;
  await coachReply(deps, input.sessionId, {
    text: segments.map((s) => s.translation ?? s.text).join(" "),
    entryIds: segments.map((s) => s.id),
    privacyEpoch: recorded.privacyEpoch,
  });
}

/**
 * The trainee typed to the coach (`/tutor/chat`): records their words (`tutor.chat`, source `client`) and answers
 * them like speech. 409 when the session is off the record (refused by the ledger, or went off while answering).
 */
export async function chatWithCoach(deps: TutorDeps, loaded: LoadedSession, text: string): Promise<{ questionId: string | null; text: string }> {
  if (CONTROL_MARK.test(text)) throw new ApiFailure(400, "control_message", "control messages are never the trainee's words");
  const said = deps.ledger.append(entry(entryContext(deps, loaded), "tutor.chat", "client", [loaded.info.startedEntryId], { text }));
  const reply = await coachReply(deps, loaded.session.id, { text, entryIds: [said.id], privacyEpoch: said.privacyEpoch });
  if (reply === null) throw new ApiFailure(409, "off_record", "the session went off the record");
  return { questionId: reply.questionId, text: reply.text };
}
