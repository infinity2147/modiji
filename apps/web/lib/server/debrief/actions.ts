/**
 * The debrief's writes (plan §7.5): witness rebuilds, expert actions, voice answers and teach-backs.
 * LLMs infer, experts confirm, code enforces: a rule enters or changes only on the expert's own
 * words — a typed `expert.statement` or a voice utterance — and only through evidence-validated
 * promotion (`promoteToConfirmedRule`). After every rulebook change the solver reruns: witnesses it no
 * longer finds are recorded as resolved by that change, new ones are recorded and asked.
 *
 * Writes for one session run strictly in order (`serially`), so each step reads the previous one's
 * entries. Every entry is registry-validated by the interview layer's `entry()` before it is appended,
 * and a derivation is validated before the expert statement it rests on is written (a refused
 * action leaves no trace).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  ConfirmedRuleSchema,
  QuestionSchema,
  RULE_PRIORITY_BY_KIND,
  SCREEN_FRAME_KIND,
  StatedRuleSchema,
  canonicalJson,
  cellPredicate,
  conditionListToPredicate,
  contentId,
  explainObserved,
  parseLedgerPayload,
  promoteToConfirmedRule,
  typecheckPredicate,
  type ActionId,
  type CandidateRule,
  type ConfirmedRule,
  type DecisionFamily,
  type ExpertQuoteEvidence,
  type LedgerEntry,
  type LedgerReader,
  type NonQuoteLink,
  type PromotionResult,
  type Question,
  type StatedRule,
  type Witness,
} from "@vashistha/core";
import type { ExpertActionRequest } from "../../contracts/debrief";
import { ApiFailure } from "../casedesk/http";
import { requireOnRecord } from "../casedesk/session";
import { quoteLanguageFields } from "../interview/language";
import { localizeQuestion } from "../interview/llm";
import { entry, type EntryContext, type PayloadInput } from "../interview/ledger";
import type { DebriefDeps } from "./deps";
import { witnessQuestion } from "./questions";
import { DOMAIN, cellOf, expertIdOf, isGap, isOpen, pendingVoiceAnswers, ruleEntries, snapshot, type Snapshot } from "./state";
import { writeTeachBack } from "./teachback";

/** Priority of decision rules confirmed in the debrief (the interview engine's priority for plain decisions). */
const DEBRIEF_RULE_PRIORITY = RULE_PRIORITY_BY_KIND.decision;
/** Frames cited per quote at most. */
const MAX_MOMENT_IDS = 8;
/** "yes", "that's right", "correct" … with no "but"/"not": the only voice reply taken as a teach-back confirmation. */
const AFFIRMATIVE = /^\s*(yes|yeah|yep|correct|exactly|right|that'?s (right|correct))\b/i;
const HEDGED = /\b(but|except|no|not|wrong|unless|however)\b/i;
/** Stands in for the expert statement's id while a derivation is validated before anything is written. */
const PENDING_STATEMENT = "pending-expert-statement";

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(text) && !HEDGED.test(text);
}

/** Runs `task` after the session's earlier debrief writes have settled. */
function serially<T>(deps: DebriefDeps, sessionId: string, task: () => Promise<T>): Promise<T> {
  const run = (deps.store.tails.get(sessionId) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  deps.store.tails.set(sessionId, settled);
  void settled.then(() => {
    if (deps.store.tails.get(sessionId) === settled) deps.store.tails.delete(sessionId);
  });
  return run;
}

type Kind = Parameters<typeof entry>[1];

/** Appends registry-validated entries for one request, collecting their ids. */
class Writer {
  readonly ids: string[] = [];
  private readonly ctx: EntryContext;

  constructor(
    private readonly deps: DebriefDeps,
    snap: Snapshot,
    traceId: string,
  ) {
    this.ctx = { sessionId: snap.loaded.session.id, occurredAt: deps.now(), traceId, privacyEpoch: snap.loaded.session.privacyEpoch };
  }

  append<K extends Kind>(kind: K, source: LedgerEntry["source"], parents: readonly (string | undefined)[], payload: PayloadInput<K>): LedgerEntry {
    const parentIds = [...new Set(parents.filter((p): p is string => p !== undefined))];
    const written = this.deps.ledger.append(entry(this.ctx, kind, source, parentIds, payload));
    this.ids.push(written.id);
    return written;
  }
}

/** The session's redacted screen frames (perception uploads), in ledger order. */
function sessionFrames(snap: Snapshot): LedgerEntry[] {
  return snap.entries.filter((e) => e.kind === SCREEN_FRAME_KIND && e.source === "client");
}

function nonEmpty(ids: readonly string[]): [string, ...string[]] | undefined {
  const [first, ...rest] = ids.slice(-MAX_MOMENT_IDS);
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * The redacted screen frames a typed quote is tied to (ExpertQuoteEvidence requires at least one):
 * the frames captured while the decisions concerned were worked; else the session's latest frame —
 * every frame of the session precedes the expert's typed words. Only real `frame.received` entries
 * count: DOM screen events never stand in for a frame. Undefined when the expert never shared their
 * screen.
 */
function screenMoment(snap: Snapshot, decisionIds: readonly string[]): [string, ...string[]] | undefined {
  const concerned = snap.decisions.filter((d) => decisionIds.includes(d.entry.id)).flatMap((d) => d.frameIds);
  return nonEmpty(concerned) ?? nonEmpty(sessionFrames(snap).slice(-1).map((f) => f.id));
}

/**
 * The frames of an explicit moment of the session (`momentEntryId`): the frame itself; a decision's
 * own frames, else the latest frame before it; for any other entry, the latest frame at or before it.
 * Without a moment, the session's latest frame. Never a frame captured after the moment.
 */
function momentFrames(snap: Snapshot, momentEntryId: string | undefined): [string, ...string[]] | undefined {
  if (momentEntryId === undefined) return screenMoment(snap, []);
  const moment = snap.entries.find((e) => e.id === momentEntryId);
  if (moment === undefined) throw new ApiFailure(400, "unknown_moment", `${momentEntryId} is not an entry of this session`);
  if (moment.kind === SCREEN_FRAME_KIND && moment.source === "client") return [moment.id];
  const own = snap.decisions.find((d) => d.entry.id === moment.id)?.frameIds ?? [];
  return nonEmpty(own) ?? nonEmpty(sessionFrames(snap).filter((f) => f.sequence <= moment.sequence).slice(-1).map((f) => f.id));
}

function noScreenFrame(): ApiFailure {
  return new ApiFailure(
    409,
    "no_screen_frame",
    "no redacted screen frame of this session is on record at or before the expert's words: share your screen during capture, so every confirmed rule shows what the expert saw",
  );
}

function requireMoment(snap: Snapshot, decisionIds: readonly string[]): [string, ...string[]] {
  const moment = screenMoment(snap, decisionIds);
  if (moment === undefined) throw noScreenFrame();
  return moment;
}

type RuleShape = Pick<ConfirmedRule, "id" | "decisionFamily" | "kind" | "predicate" | "effect" | "priority" | "overrides">;

/** Observed decisions of the session that `rule` explains once it is in the rulebook. */
function explainedBy(snap: Snapshot, rule: RuleShape): string[] {
  const rules: RuleShape[] = [...snap.book.rules.filter((r) => r.id !== rule.id), rule];
  return snap.decisions
    .filter((d) => d.decisionFamily === rule.decisionFamily && explainObserved(snap.domain, rules, d).ruleIds.includes(rule.id))
    .map((d) => d.entry.id);
}

function familyDecisionIds(snap: Snapshot, family: string): string[] {
  return snap.decisions.filter((d) => d.decisionFamily === family).map((d) => d.entry.id);
}

function familyOf(id: string): DecisionFamily {
  const family = DOMAIN.decisionFamilies.find((f) => f.id === id);
  if (family === undefined) throw new ApiFailure(400, "unknown_family", `no decision family ${id}`);
  return family;
}

function typedQuote(statementId: string, text: string, moment: [string, ...string[]]): ExpertQuoteEvidence {
  return { kind: "expert_quote", utteranceId: statementId, exactQuote: text, t0Ms: 0, t1Ms: 0, frameIds: moment, eventIds: [], relation: "supports", provenance: "human_text" };
}

function decisionLinks(ids: readonly string[]): NonQuoteLink[] {
  return ids.map((ledgerEntryId) => ({ kind: "observed_decision", ledgerEntryId }));
}

/** The ledger as promotion sees it before the expert statement is written. */
function withPendingStatement(deps: DebriefDeps): LedgerReader {
  return { get: (id) => (id === PENDING_STATEMENT ? { id, source: "expert", kind: "expert.statement" } : deps.ledger.get(id)) };
}

function promoted(result: PromotionResult): ConfirmedRule {
  if (!result.ok) throw new ApiFailure(422, "promotion_rejected", result.errors.map((e) => e.code).join(", "));
  return result.rule;
}

// ── Rule derivations ──

type NewRule = {
  ruleId: string;
  family: string;
  source: { candidate: CandidateRule } | { predicate: ConfirmedRule["predicate"]; action: ActionId };
  evidence: [ExpertQuoteEvidence, ...ExpertQuoteEvidence[]];
  confirmationEntryId: string;
  ledger: LedgerReader;
};

function newRule(deps: DebriefDeps, snap: Snapshot, input: NewRule): ConfirmedRule {
  const expertId = expertIdOf(snap.loaded);
  const predicate = "candidate" in input.source ? input.source.candidate.predicate : input.source.predicate;
  const action = "candidate" in input.source ? input.source.candidate.predictedAction : input.source.action;
  const shape: RuleShape = { id: input.ruleId, decisionFamily: input.family, kind: "decision", predicate, effect: { type: "recommend", action }, priority: DEBRIEF_RULE_PRIORITY, overrides: [] };
  const [quote] = input.evidence;
  return promoted(
    promoteToConfirmedRule({
      ruleId: input.ruleId,
      domain: snap.domain,
      decisionFamily: input.family,
      source:
        "candidate" in input.source
          ? { candidate: input.source.candidate }
          : { statedRule: { predicate, action, kind: "decision", effect: { type: "recommend", action }, exactQuote: quote.exactQuote, t0Ms: quote.t0Ms, t1Ms: quote.t1Ms } },
      priority: DEBRIEF_RULE_PRIORITY,
      overrides: [],
      evidence: input.evidence,
      links: decisionLinks(explainedBy(snap, shape)),
      confirmation: { expertId, at: deps.now(), method: "debrief", ledgerEntryId: input.confirmationEntryId },
      expertId,
      schemaVersion: snap.schemaVersion,
      ledger: input.ledger,
    }),
  );
}

type Revision = { predicate: ConfirmedRule["predicate"]; priority: number; overrides: string[] };

/**
 * The next revision of `old`: the expert's correction first in its evidence and confirmations, the
 * earlier quotes kept. The new predicate and quote pass the same validation as a promotion (the
 * nominal action only satisfies the family check; the rule keeps its own effect and kind).
 */
function revisedRule(
  deps: DebriefDeps,
  snap: Snapshot,
  input: { old: ConfirmedRule; change: Revision; quote: ExpertQuoteEvidence; confirmationEntryId: string; method: "debrief" | "teach_back"; ledger: LedgerReader },
): ConfirmedRule {
  const { old, change } = input;
  const unknownOverride = change.overrides.find((id) => id === old.id || !snap.book.rules.some((r) => r.id === id));
  if (unknownOverride !== undefined) throw new ApiFailure(400, "invalid_override", `${unknownOverride} is not another live rule`);
  const family = familyOf(old.decisionFamily);
  const nominal = old.effect.type === "recommend" || old.effect.type === "forbid" ? old.effect.action : family.actions[0];
  if (nominal === undefined) throw new ApiFailure(400, "unknown_family", `family ${family.id} has no actions`);
  const expertId = expertIdOf(snap.loaded);
  const check = promoted(
    promoteToConfirmedRule({
      ruleId: old.id,
      domain: snap.domain,
      decisionFamily: old.decisionFamily,
      // The stated rule is a validation vehicle (quote in evidence, predicate, family); `kind` and `effect` below keep the rule's own.
      source: {
        statedRule: { predicate: change.predicate, action: nominal, kind: "decision", effect: { type: "recommend", action: nominal }, exactQuote: input.quote.exactQuote, t0Ms: input.quote.t0Ms, t1Ms: input.quote.t1Ms },
      },
      kind: old.kind,
      effect: old.effect,
      priority: change.priority,
      overrides: change.overrides,
      evidence: [input.quote],
      confirmation: { expertId, at: deps.now(), method: input.method, ledgerEntryId: input.confirmationEntryId },
      expertId,
      schemaVersion: snap.schemaVersion,
      ledger: input.ledger,
    }),
  );
  return ConfirmedRuleSchema.parse({
    ...old,
    predicate: change.predicate,
    priority: change.priority,
    overrides: change.overrides,
    revision: old.revision + 1,
    evidence: [check.evidence[0], ...old.evidence],
    confirmedBy: [check.confirmedBy[0], ...old.confirmedBy],
  });
}

/** Quotes of the expert's own statement behind an `expert_statement` candidate (answer parser output, voice). */
function statedQuotes(snap: Snapshot, candidate: CandidateRule, moment: [string, ...string[]]): ExpertQuoteEvidence[] {
  if (candidate.origin !== "expert_statement") return [];
  return snap.entries.flatMap((e) => {
    if (e.kind !== "answer.parsed") return [];
    const outcome = snap.engine.answers.get(e.id);
    const stated = outcome?.statedRules.find((s) => s.status === "candidate" && s.candidateId === candidate.id);
    if (stated === undefined) return [];
    const { utteranceId } = parseLedgerPayload(e, "answer.parsed");
    const utterance = snap.engine.utterances.get(utteranceId);
    const [first, ...rest] = utterance?.frameIds ?? [];
    const quote: ExpertQuoteEvidence = {
      kind: "expert_quote",
      utteranceId,
      exactQuote: stated.rule.exactQuote,
      t0Ms: stated.rule.t0Ms,
      t1Ms: stated.rule.t1Ms,
      frameIds: first === undefined ? moment : [first, ...rest],
      eventIds: [],
      relation: "supports",
      provenance: "human_voice",
      // A quote in another language keeps the original words; its machine translation is attached for display.
      ...quoteLanguageFields(utterance, stated.rule.exactQuote),
    };
    return [quote];
  });
}

/**
 * The question as the session's expert hears it (plan §7.11): translated into their language by the
 * interview's localizer (`textEnglish` keeps the English original); unchanged for English, without a
 * model, or when the translation is rejected. Only this stored text is ever authorised and spoken.
 */
function inExpertLanguage(deps: DebriefDeps, snap: Snapshot, question: Question): Promise<Question> {
  return localizeQuestion(deps.claude, question, snap.engine.expert?.language ?? "en", deps.log);
}

// ── Solver rerun ──

/** Witnesses current before a rule change that the solver no longer finds: resolved by that change. */
async function resolveVanished(deps: DebriefDeps, before: Snapshot, w: Writer, ruleEntry: LedgerEntry, kind: "rule_added" | "rule_revised"): Promise<Snapshot> {
  const after = await snapshot(deps, before.loaded.session.id);
  for (const wit of before.current) {
    const found = before.found.get(wit.id);
    if (found === undefined || before.resolutions.has(wit.id) || after.current.some((c) => c.id === wit.id)) continue;
    w.append("witness.resolved", "engine", [found.entry.id, ruleEntry.id], { witnessId: wit.id, resolution: kind, ledgerEntryId: ruleEntry.id });
  }
  return snapshot(deps, before.loaded.session.id);
}

/**
 * Records every current witness (`witness.found`, source solver), queues a debrief question for each
 * open one that has none live, and drops queued questions whose witness is closed or gone. (The
 * interview engine's requeue supersedes only live-interview kinds, never these.)
 */
async function recordAndAsk(deps: DebriefDeps, snap: Snapshot, w: Writer): Promise<void> {
  const sessionId = snap.loaded.session.id;
  const contextVersion = deps.authorizations.getContextVersion(sessionId);
  const ruleEntryIds = ruleEntries(snap.book);
  for (const wit of snap.current) {
    let found = snap.found.get(wit.id)?.entry;
    if (found === undefined) {
      const rules = snap.book.rules.filter((r) => r.decisionFamily === wit.decisionFamily).map((r) => ruleEntryIds.get(r.id));
      const parents = rules.length > 0 ? rules : familyDecisionIds(snap, wit.decisionFamily);
      found = w.append("witness.found", "solver", parents, wit);
    }
    if (!isOpen(snap, wit)) continue;
    const record = snap.questions.get(wit.id);
    if (record?.status === "queued" || record?.status === "asked") continue;
    w.append("question.queued", "engine", [found.id], await inExpertLanguage(deps, snap, witnessQuestion(snap, wit, { createdAt: deps.now(), contextVersion, parentIds: [found.id] })));
  }
  for (const [witnessId, record] of snap.questions) {
    if (record.status !== "queued") continue;
    const wit = snap.current.find((c) => c.id === witnessId);
    if (wit !== undefined && isOpen(snap, wit)) continue;
    const closedByExpert = snap.resolutions.has(witnessId) || snap.boundaryConfirmed.has(witnessId);
    w.append("question.dropped", "engine", [record.queuedEntryId], { questionId: record.question.id, reason: closedByExpert ? "superseded" : "context_changed" });
  }
  for (const record of snap.teachBackQuestions.values()) {
    const current = snap.teachBack !== undefined && record.question.parentIds.includes(snap.teachBack.entry.id) && snap.teachBack.rulebookRevision === snap.book.revision;
    if (record.status === "queued" && (!current || snap.teachBack?.confirmedEntryId !== undefined))
      w.append("question.dropped", "engine", [record.queuedEntryId], { questionId: record.question.id, reason: current ? "superseded" : "context_changed" });
  }
}

/**
 * Applies one voice answer to a debrief question, if it settles something: an affirmative reply to
 * the current teach-back confirms it; an unresolved witness answered with an action (answer parser)
 * gains the rule for its decision cell, quoted from the utterance. Returns the rule change, if any.
 */
function applyVoiceAnswer(deps: DebriefDeps, snap: Snapshot, w: Writer, utterance: LedgerEntry): { entry: LedgerEntry } | undefined {
  const record = snap.engine.utterances.get(utterance.id);
  const question = record?.questionId === undefined ? undefined : snap.engine.questions.get(record.questionId)?.question;
  if (record === undefined || question === undefined) return undefined;
  if (question.kind === "teach_back") {
    const tb = snap.teachBack;
    if (tb !== undefined && question.parentIds.includes(tb.entry.id) && tb.rulebookRevision === snap.book.revision && tb.confirmedEntryId === undefined && isAffirmative(record.text))
      w.append("teachback.confirmed", "engine", [tb.entry.id, utterance.id], { utteranceId: utterance.id, rulebookRevision: tb.rulebookRevision });
    return undefined;
  }
  const witnessId = question.target.witnessId;
  const wit = snap.current.find((c) => c.id === witnessId);
  const parsed = snap.entries.findLast((e) => e.kind === "answer.parsed" && parseLedgerPayload(e, "answer.parsed").utteranceId === utterance.id);
  const action = parsed === undefined ? undefined : parseLedgerPayload(parsed, "answer.parsed").answeredAction;
  if (wit?.kind !== "unresolved" || action === undefined || parsed === undefined || !isOpen(snap, wit)) return undefined;
  if (!familyOf(wit.decisionFamily).actions.includes(action)) return undefined;
  const predicate = cellPredicate(cellOf(snap, wit));
  if (predicate === undefined) return undefined;
  const [frame, ...frames] = record.frameIds;
  const moment = frame === undefined ? screenMoment(snap, familyDecisionIds(snap, wit.decisionFamily)) : ([frame, ...frames] as [string, ...string[]]);
  if (moment === undefined) {
    deps.log.info(`[debrief] voice answer ${utterance.id} not applied: no redacted screen frame is on record for it`);
    return undefined;
  }
  const quote: ExpertQuoteEvidence = {
    kind: "expert_quote",
    utteranceId: utterance.id,
    exactQuote: record.text,
    t0Ms: record.t0Ms,
    t1Ms: record.t1Ms,
    frameIds: moment,
    eventIds: [],
    relation: "supports",
    provenance: "human_voice",
    ...quoteLanguageFields(record, record.text),
  };
  const rule = newRule(deps, snap, {
    ruleId: contentId("rule", canonicalJson({ utterance: utterance.id, witness: wit.id })),
    family: wit.decisionFamily,
    source: { predicate, action },
    evidence: [quote],
    confirmationEntryId: utterance.id,
    ledger: deps.ledger,
  });
  const ruleEntry = w.append("rule.confirmed", "engine", [parsed.id, utterance.id, snap.found.get(wit.id)?.entry.id, ...explainedBy(snap, rule)], { rule });
  return { entry: ruleEntry };
}

async function rebuild(deps: DebriefDeps, sessionId: string, w: Writer): Promise<Snapshot> {
  let snap = await snapshot(deps, sessionId);
  for (const utterance of pendingVoiceAnswers(snap)) {
    const change = applyVoiceAnswer(deps, snap, w, utterance);
    snap = change === undefined ? await snapshot(deps, sessionId) : await resolveVanished(deps, snap, w, change.entry, "rule_added");
  }
  await recordAndAsk(deps, snap, w);
  return snap;
}

/** POST …/witnesses: apply pending voice answers, rerun the solver, record and ask. */
export function rebuildWitnesses(deps: DebriefDeps, sessionId: string): Promise<string[]> {
  return serially(deps, sessionId, async () => {
    const snap = await snapshot(deps, sessionId);
    requireOnRecord(snap.loaded.session);
    const w = new Writer(deps, snap, randomUUID());
    await rebuild(deps, sessionId, w);
    return w.ids;
  });
}

// ── Teach-back ──

async function teachBack(deps: DebriefDeps, snap: Snapshot, w: Writer): Promise<void> {
  const rules = snap.book.rules;
  if (rules.length === 0) throw new ApiFailure(409, "no_confirmed_rules", "a teach-back is written from confirmed rules only, and there are none yet");
  const prose = await writeTeachBack(deps.claude, deps.models.prose, rules);
  if (prose.note !== undefined) deps.log.info(`[debrief] teach-back uses the template: ${prose.note}`);
  const entryIds = ruleEntries(snap.book);
  const tb = w.append("teachback.generated", "engine", rules.map((r) => entryIds.get(r.id)), {
    text: prose.text,
    ruleIds: rules.map((r) => r.id).sort(),
    rulebookRevision: snap.book.revision,
    origin: prose.origin,
  });
  const sessionId = snap.loaded.session.id;
  for (const record of snap.teachBackQuestions.values())
    if (record.status === "queued") w.append("question.dropped", "engine", [record.queuedEntryId, tb.id], { questionId: record.question.id, reason: "superseded" });
  w.append(
    "question.queued",
    "engine",
    [tb.id],
    await inExpertLanguage(deps, snap, QuestionSchema.parse({
      id: contentId("q", canonicalJson({ s: sessionId, k: "teach_back", t: tb.id })),
      sessionId,
      kind: "teach_back",
      text: prose.text,
      target: { candidateIds: [] },
      value: 1,
      reason: "teach-back of the confirmed rules",
      ephemeral: false,
      createdAt: deps.now(),
      contextVersion: deps.authorizations.getContextVersion(sessionId),
      parentIds: [tb.id],
    })),
  );
}

/** POST …/teachback: writes (Opus or template) and queues a teach-back of the rulebook in force. */
export function generateTeachBack(deps: DebriefDeps, sessionId: string): Promise<string[]> {
  return serially(deps, sessionId, async () => {
    const snap = await snapshot(deps, sessionId);
    requireOnRecord(snap.loaded.session);
    const w = new Writer(deps, snap, randomUUID());
    await teachBack(deps, snap, w);
    return w.ids;
  });
}

// ── Explicit expert actions (UI, when voice is not used) ──

/**
 * The stop-rule the expert typed, as a stated guardrail: the condition list converted and type-checked
 * against the domain, the action checked against the family, and refused when the same guardrail is
 * already in force.
 */
function statedStopRule(snap: Snapshot, req: Extract<ExpertActionRequest, { action: "confirm_stop_rule" }>): StatedRule {
  const family = familyOf(req.decisionFamily);
  if (!family.actions.includes(req.effect.action)) throw new ApiFailure(400, "invalid_action", `${req.effect.action} is not an action of ${family.id}`);
  const converted = conditionListToPredicate(req.when);
  if (!converted.ok) throw new ApiFailure(400, "invalid_predicate", converted.reasons.join("; "));
  const issues = typecheckPredicate(converted.predicate, snap.domain.features);
  if (issues.length > 0) throw new ApiFailure(400, "invalid_predicate", issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; "));
  const effect = req.effect.type === "forbid" ? req.effect : { type: req.effect.type, role: req.effect.role };
  const stated = StatedRuleSchema.safeParse({ predicate: converted.predicate, action: req.effect.action, kind: "guardrail", effect, exactQuote: req.quote, t0Ms: 0, t1Ms: 0 });
  if (!stated.success) throw new ApiFailure(400, "invalid_stop_rule", stated.error.issues.map((i) => i.message).join("; "));
  const same = canonicalJson([family.id, stated.data.predicate, stated.data.effect]);
  if (snap.book.rules.some((r) => canonicalJson([r.decisionFamily, r.predicate, r.effect]) === same))
    throw new ApiFailure(409, "rule_exists", "this stop-rule is already in the confirmed rulebook");
  return stated.data;
}

function currentWitness(snap: Snapshot, witnessId: string): { witness: Witness; found: LedgerEntry } {
  const witness = snap.current.find((c) => c.id === witnessId);
  if (witness === undefined) throw new ApiFailure(409, "witness_not_current", "the solver no longer finds this case under the current rulebook");
  const found = snap.found.get(witnessId)?.entry;
  if (found === undefined) throw new ApiFailure(409, "witness_not_recorded", "rebuild the witnesses first");
  if (!isOpen(snap, witness)) throw new ApiFailure(409, "witness_closed", "the expert already answered this case");
  return { witness, found };
}

export type ActionResult = { statementId: string; derivedIds: string[] };

export function applyExpertAction(deps: DebriefDeps, sessionId: string, req: ExpertActionRequest): Promise<ActionResult> {
  return serially(deps, sessionId, async () => {
    const snap = await snapshot(deps, sessionId);
    requireOnRecord(snap.loaded.session);
    const w = new Writer(deps, snap, randomUUID());
    const pending = withPendingStatement(deps);
    const statement = (parents: readonly (string | undefined)[], payload: PayloadInput<"expert.statement">): LedgerEntry =>
      w.append("expert.statement", "expert", parents, payload);
    let statementEntry: LedgerEntry;
    let change: { entry: LedgerEntry; kind: "rule_added" | "rule_revised" } | undefined;
    let regenerateTeachBack = false;

    switch (req.action) {
      case "confirm_candidate": {
        const fam = snap.engine.families.get(req.decisionFamily);
        const candidate = fam?.set.candidates.find((c) => c.id === req.candidateId);
        if (candidate === undefined) throw new ApiFailure(404, "candidate_not_found", `no candidate ${req.candidateId} in family ${req.decisionFamily}`);
        const probe: RuleShape = { id: PENDING_STATEMENT, decisionFamily: req.decisionFamily, kind: "decision", predicate: candidate.predicate, effect: { type: "recommend", action: candidate.predictedAction }, priority: DEBRIEF_RULE_PRIORITY, overrides: [] };
        const explained = explainedBy(snap, probe);
        const moment = requireMoment(snap, explained.length > 0 ? explained : familyDecisionIds(snap, req.decisionFamily));
        const evidence = (statementId: string, ledger: LedgerReader): ConfirmedRule =>
          newRule(deps, snap, {
            ruleId: contentId("rule", canonicalJson({ candidate: candidate.id, statement: statementId })),
            family: req.decisionFamily,
            source: { candidate },
            evidence: [typedQuote(statementId, req.quote, moment), ...statedQuotes(snap, candidate, moment)],
            confirmationEntryId: statementId,
            ledger,
          });
        evidence(PENDING_STATEMENT, pending);
        const hypotheses = snap.entries.findLast((e) => e.kind === "hypotheses.updated" && parseLedgerPayload(e, "hypotheses.updated").decisionFamily === req.decisionFamily);
        statementEntry = statement([hypotheses?.id], { text: req.quote, intent: "confirm_candidate", target: { candidateId: candidate.id } });
        const rule = evidence(statementEntry.id, deps.ledger);
        change = { entry: w.append("rule.confirmed", "engine", [statementEntry.id, hypotheses?.id, ...explained], { rule }), kind: "rule_added" };
        break;
      }
      case "add_rule_for_witness": {
        const { witness, found } = currentWitness(snap, req.witnessId);
        if (witness.kind !== "unresolved") throw new ApiFailure(409, "not_unresolved", "only an unresolved case gains a rule for its decision cell");
        if (!familyOf(witness.decisionFamily).actions.includes(req.decision))
          throw new ApiFailure(400, "invalid_action", `${req.decision} is not an action of ${witness.decisionFamily}`);
        const predicate = cellPredicate(cellOf(snap, witness));
        if (predicate === undefined) throw new ApiFailure(409, "empty_cell", "no rule decides this family yet: confirm a proposed rule first");
        const moment = requireMoment(snap, familyDecisionIds(snap, witness.decisionFamily));
        const make = (statementId: string, ledger: LedgerReader): ConfirmedRule =>
          newRule(deps, snap, {
            ruleId: contentId("rule", canonicalJson({ witness: witness.id, statement: statementId })),
            family: witness.decisionFamily,
            source: { predicate, action: req.decision },
            evidence: [typedQuote(statementId, req.quote, moment)],
            confirmationEntryId: statementId,
            ledger,
          });
        make(PENDING_STATEMENT, pending);
        const question = snap.questions.get(witness.id)?.queuedEntryId;
        statementEntry = statement([found.id, question], { text: req.quote, intent: "add_rule_for_witness", target: { witnessId: witness.id, action: req.decision } });
        const rule = make(statementEntry.id, deps.ledger);
        change = { entry: w.append("rule.confirmed", "engine", [statementEntry.id, found.id, ...explainedBy(snap, rule)], { rule }), kind: "rule_added" };
        break;
      }
      case "revise_rule": {
        const old = snap.book.rules.find((r) => r.id === req.ruleId);
        if (old === undefined) throw new ApiFailure(404, "rule_not_found", `no live rule ${req.ruleId}`);
        const next: Revision = { predicate: req.predicate ?? old.predicate, priority: req.priority ?? old.priority, overrides: [...new Set(req.overrides ?? old.overrides)].sort() };
        if (canonicalJson(next) === canonicalJson({ predicate: old.predicate, priority: old.priority, overrides: [...old.overrides].sort() }))
          throw new ApiFailure(400, "no_change", "the revision changes nothing");
        const tb = req.teachBackId === undefined ? undefined : snap.teachBack;
        if (req.teachBackId !== undefined && tb?.entry.id !== req.teachBackId) throw new ApiFailure(409, "teachback_not_current", "correct the latest teach-back");
        const witnessFound = req.witnessId === undefined ? undefined : snap.found.get(req.witnessId)?.entry;
        if (req.witnessId !== undefined && witnessFound === undefined) throw new ApiFailure(409, "witness_not_recorded", "rebuild the witnesses first");
        const moment = requireMoment(snap, explainedBy(snap, old).length > 0 ? explainedBy(snap, old) : familyDecisionIds(snap, old.decisionFamily));
        const method = tb === undefined ? "debrief" : "teach_back";
        const make = (statementId: string, ledger: LedgerReader): ConfirmedRule =>
          revisedRule(deps, snap, { old, change: next, quote: typedQuote(statementId, req.quote, moment), confirmationEntryId: statementId, method, ledger });
        make(PENDING_STATEMENT, pending);
        statementEntry = statement([ruleEntries(snap.book).get(old.id), witnessFound?.id, tb?.entry.id], {
          text: req.quote,
          intent: "revise_rule",
          target: { ruleId: old.id, ...(req.witnessId !== undefined && { witnessId: req.witnessId }), ...(tb !== undefined && { teachBackId: tb.entry.id }) },
        });
        const rule = make(statementEntry.id, deps.ledger);
        change = {
          entry: w.append("rule.revised", "engine", [statementEntry.id, ruleEntries(snap.book).get(old.id), witnessFound?.id], {
            rule,
            reason: `${tb === undefined ? "expert correction" : "teach-back correction"}: "${req.quote}"`,
          }),
          kind: "rule_revised",
        };
        regenerateTeachBack = tb !== undefined;
        break;
      }
      case "acknowledge_witness": {
        const { witness, found } = currentWitness(snap, req.witnessId);
        if (!isGap(witness)) throw new ApiFailure(409, "not_a_gap", "only unresolved or conflicting cases are acknowledged");
        statementEntry = statement([found.id, snap.questions.get(witness.id)?.queuedEntryId], { text: req.quote, intent: "acknowledge_witness", target: { witnessId: witness.id } });
        w.append("witness.resolved", "engine", [statementEntry.id, found.id], { witnessId: witness.id, resolution: req.resolution, ledgerEntryId: statementEntry.id });
        break;
      }
      case "confirm_boundary": {
        const { witness, found } = currentWitness(snap, req.witnessId);
        if (witness.kind !== "boundary") throw new ApiFailure(409, "not_a_boundary", "only threshold checks are confirmed as they stand");
        statementEntry = statement([found.id, snap.questions.get(witness.id)?.queuedEntryId], { text: req.quote, intent: "confirm_boundary", target: { witnessId: witness.id } });
        break;
      }
      case "confirm_stop_rule": {
        const stated = statedStopRule(snap, req);
        const frames = momentFrames(snap, req.momentEntryId);
        if (frames === undefined) throw noScreenFrame();
        const momentDecision = snap.decisions.find((d) => d.entry.id === req.momentEntryId)?.entry.id;
        const make = (statementId: string, ledger: LedgerReader): ConfirmedRule =>
          promoted(
            promoteToConfirmedRule({
              ruleId: contentId("rule", canonicalJson({ stopRule: statementId })),
              domain: snap.domain,
              decisionFamily: req.decisionFamily,
              source: { statedRule: stated },
              priority: RULE_PRIORITY_BY_KIND.guardrail,
              overrides: [],
              evidence: [typedQuote(statementId, req.quote, frames)],
              links: decisionLinks(momentDecision === undefined ? [] : [momentDecision]),
              confirmation: { expertId: expertIdOf(snap.loaded), at: deps.now(), method: "debrief", ledgerEntryId: statementId },
              expertId: expertIdOf(snap.loaded),
              schemaVersion: snap.schemaVersion,
              ledger,
            }),
          );
        make(PENDING_STATEMENT, pending);
        statementEntry = statement([req.momentEntryId], { text: req.quote, intent: "confirm_stop_rule", target: { action: req.effect.action } });
        const rule = make(statementEntry.id, deps.ledger);
        change = { entry: w.append("rule.confirmed", "engine", [statementEntry.id, req.momentEntryId], { rule }), kind: "rule_added" };
        break;
      }
      case "confirm_teachback": {
        const tb = snap.teachBack;
        if (tb?.entry.id !== req.teachBackId || tb.rulebookRevision !== snap.book.revision)
          throw new ApiFailure(409, "teachback_not_current", "only the teach-back of the rulebook in force can be confirmed");
        if (tb.confirmedEntryId !== undefined) throw new ApiFailure(409, "teachback_confirmed", "this teach-back is already confirmed");
        statementEntry = statement([tb.entry.id], { text: req.quote, intent: "confirm_teachback", target: { teachBackId: tb.entry.id } });
        w.append("teachback.confirmed", "engine", [tb.entry.id, statementEntry.id], { utteranceId: statementEntry.id, rulebookRevision: tb.rulebookRevision });
        break;
      }
    }

    const after = change === undefined ? await snapshot(deps, sessionId) : await resolveVanished(deps, snap, w, change.entry, change.kind);
    await recordAndAsk(deps, after, w);
    if (regenerateTeachBack) await teachBack(deps, await snapshot(deps, sessionId), w);
    return { statementId: statementEntry.id, derivedIds: w.ids.filter((id) => id !== statementEntry.id) };
  });
}
