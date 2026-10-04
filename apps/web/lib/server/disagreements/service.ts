/**
 * Two experts (plan §7.10): align their sessions, encode both rulebooks, let Z3 find a valid case where
 * they decide differently, ask each expert, and turn their answers into a revision carrying BOTH
 * experts' exact quotes. LLMs infer, experts confirm, code enforces: the solver finds the case, each
 * expert decides it in their own words, and code writes the resolution — never a model.
 *
 * Where it lives. A disagreement is recorded in each expert's LATEST expert session: `witness.found`
 * (source solver) and a `witness` question for that expert, so their own interview/debrief voice loop
 * asks it and their answer is ordinary evidence of their session (typed: `expert.statement` with intent
 * `answer_disagreement`; spoken: the utterance answering that question, read by the answer parser's
 * `answeredAction`). No new session type: every reader of a session (ledger, lineage, judge view) keeps
 * working, and the debrief of each session ignores disagreement witnesses (they belong to this flow).
 *
 * Resolution, once both experts answered the case with the SAME action y:
 *   - if one expert's rulebook already decides y on the case, its deciding rule R is revised: the other
 *     expert's confirmation and quote are added (so R joins the other expert's rulebook — `ruleExperts`),
 *     both quotes come first in its evidence (`supports`), the quotes of the rules it now overrides follow
 *     as `contradicts`, and R overrides the other expert's deciding rules (`overrides`);
 *   - otherwise (neither decides y) a new decision rule for the case's decision cell is confirmed by
 *     both, overriding both experts' deciding rules.
 * Then the solver reruns; a disagreement it no longer finds is closed (`witness.resolved` in both
 * sessions). Different answers leave the disagreement open, and the team rulebook keeps holding back the
 * disagreeing decision rules (core `teamRulebook`; guardrails always stay in force).
 *
 * Writes span two experts' sessions, so they run on one serial chain per process.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import {
  ConfirmedRuleSchema,
  MAX_QUESTION_WORDS,
  QuestionSchema,
  RULE_PRIORITY_BY_KIND,
  SCREEN_FRAME_KIND,
  actionPhrase,
  canonicalJson,
  cellPredicate,
  contentId,
  decisionCell,
  decisionRulesOf,
  effectiveOutcome,
  expertRulebook,
  featuresReferenced,
  formatValue,
  parseLedgerPayload,
  promoteToConfirmedRule,
  recordLookup,
  ruleExperts,
  ruleFires,
  supportingQuotes,
  type ActionId,
  type Confirmation,
  type ConfirmedRule,
  type DecisionFamily,
  type EffectiveOutcome,
  type ExpertQuoteEvidence,
  type LedgerEntry,
  type Question,
  type Rulebook,
} from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import type {
  BookDecisionSchema,
  DisagreementAnswer,
  DisagreementView,
  DisagreementsState,
  ExpertView,
  PairState,
  RuleCard,
} from "../../contracts/disagreements";
import { ApiFailure } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, requireOnRecord } from "../casedesk/session";
import type { ExpertRecord } from "../debrief/rulebook-store";
import { caseDescription, cellPhrases, ruleText, withinWords } from "../debrief/text";
import { engineState } from "../interview/engine-state";
import { entry, type EntryContext, type PayloadInput } from "../interview/ledger";
import { rulebookWithinModel } from "../schema/rulebook";
import type { DisagreementDeps, DisagreementWitness } from "./deps";

const DOMAIN = KYC_DOMAIN;
const SCHEMA_VERSION = CASEDESK_SCHEMA_VERSION;
const UNRESOLVED_LABEL = "unresolved";

type Pair = readonly [ExpertRecord, ExpertRecord];
type Index = 0 | 1;
const INDEXES: readonly Index[] = [0, 1];

/** Runs `task` after every earlier reconciliation write has settled. */
function serially<T>(deps: DisagreementDeps, task: () => Promise<T>): Promise<T> {
  const run = deps.store.tail.then(task);
  deps.store.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function familyOf(id: string): DecisionFamily {
  const family = DOMAIN.decisionFamilies.find((f) => f.id === id);
  if (family === undefined) throw new ApiFailure(400, "unknown_family", `no decision family ${id}`);
  return family;
}

function expertsOf(deps: DisagreementDeps, ids: readonly [string, string]): Pair {
  const directory = deps.experts();
  const [a, b] = ids.map((id) => {
    const found = directory.find((e) => e.id === id);
    if (found === undefined) throw new ApiFailure(404, "unknown_expert", `no expert session for expert ${id}`);
    return found;
  });
  if (a === undefined || b === undefined) throw new ApiFailure(400, "invalid_request", "two experts are needed");
  return [a, b];
}

function latestSession(expert: ExpertRecord): string {
  const id = expert.sessionIds.at(-1);
  if (id === undefined) throw new ApiFailure(404, "unknown_expert", `expert ${expert.id} has no session`);
  return id;
}

/** The expert's own rulebook in the base feature model (where the interlock, tutor and MCP work). */
function bookOf(deps: DisagreementDeps, expertId: string): Rulebook {
  return rulebookWithinModel(DOMAIN, expertRulebook(deps.rulebook(), expertId));
}

/** Latest rule event entry per live rule of the global rulebook. */
function ruleEntryIds(book: Rulebook): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of book.history) if (h.kind !== "retired") out.set(h.ruleId, h.ledgerEntryId);
  return out;
}

// ── What the ledger says about a pair ──

/**
 * An expert's answer. A spoken answer keeps the language it was spoken in and, when the engine stored
 * one (`utterance.translated`), its machine translation — for display; the original words are the quote.
 */
type Answer = { expert: Index; action: ActionId; entry: LedgerEntry; via: "typed" | "voice"; text: string; language?: "hi"; translation?: string };

type Recorded = {
  witness: DisagreementWitness;
  /** The latest `witness.found` of this witness in each expert's sessions (index = expert). */
  found: [LedgerEntry | undefined, LedgerEntry | undefined];
  /** Closed by a `witness.resolved` after its latest `witness.found`. */
  closed: LedgerEntry | undefined;
  questions: { expert: Index; question: Question; queuedEntryId: string; status: string; sessionId: string }[];
  answers: [Answer | undefined, Answer | undefined];
  /** The rule event written for this witness (a parent is one of its found entries). */
  resolution: LedgerEntry | undefined;
};

type Context = {
  pair: Pair;
  family: DecisionFamily;
  all: Rulebook;
  books: [Rulebook, Rulebook];
  /** Evidence entries of every session of each expert (index = expert). */
  entries: [LedgerEntry[], LedgerEntry[]];
  records: Map<string, Recorded>;
};

function samePair(w: DisagreementWitness, pair: Pair): boolean {
  const ids = new Set(pair.map((e) => e.id));
  return w.experts.every((e) => ids.has(e)) && w.experts[0] !== w.experts[1];
}

function questionIdFor(sessionId: string, witnessId: string, foundEntryId: string): string {
  return contentId("q", canonicalJson({ s: sessionId, k: "disagreement", w: witnessId, f: foundEntryId }));
}

function load(deps: DisagreementDeps, ids: readonly [string, string], familyId: string): Context {
  const pair = expertsOf(deps, ids);
  const family = familyOf(familyId);
  const all = deps.rulebook();
  const entries: [LedgerEntry[], LedgerEntry[]] = [
    pair[0].sessionIds.flatMap((s) => deps.ledger.evidence(s)),
    pair[1].sessionIds.flatMap((s) => deps.ledger.evidence(s)),
  ];
  const records = new Map<string, Recorded>();
  // Each expert's sessions in order (oldest first), each session's entries in sequence order. A
  // resolution is written in the same session as the `witness.found` it closes, so "closed" is decided
  // per session: a `witness.resolved` after the latest found entry there.
  for (const i of INDEXES)
    for (const e of entries[i]) {
      if (e.kind === "witness.found") {
        const w = parseLedgerPayload(e, "witness.found");
        if (w.kind !== "disagreement" || w.decisionFamily !== family.id || !samePair(w, pair)) continue;
        const record = records.get(w.id) ?? { witness: w, found: [undefined, undefined], closed: undefined, questions: [], answers: [undefined, undefined], resolution: undefined };
        record.found[i] = e;
        records.set(w.id, record);
      }
    }
  for (const record of records.values())
    record.closed = INDEXES.flatMap((i) => {
      const found = record.found[i];
      return found === undefined
        ? []
        : entries[i].filter(
            (e) => e.kind === "witness.resolved" && e.sessionId === found.sessionId && e.sequence > found.sequence && parseLedgerPayload(e, "witness.resolved").witnessId === record.witness.id,
          );
    }).at(-1);
  for (const record of records.values()) {
    const foundIds = new Set(record.found.flatMap((f) => (f === undefined ? [] : [f.id])));
    for (const i of INDEXES) {
      const found = record.found[i];
      if (found === undefined) continue;
      const state = engineState({ ledger: deps.ledger, store: deps.interview, config: deps.engineConfig }, found.sessionId);
      const qid = questionIdFor(found.sessionId, record.witness.id, found.id);
      const q = state.questions.get(qid);
      if (q !== undefined) record.questions.push({ expert: i, question: q.question, queuedEntryId: q.queuedEntryId, status: q.status, sessionId: found.sessionId });
      record.answers[i] = latestAnswer(deps, entries[i], found, record.witness.id, qid, i);
    }
    record.resolution = [...entries[0], ...entries[1]]
      .filter((e) => (e.kind === "rule.revised" || e.kind === "rule.confirmed") && e.parentIds.some((p) => foundIds.has(p)))
      .sort((x, y) => x.receivedAt - y.receivedAt)
      .at(-1);
  }
  return { pair, family, all, books: [bookOf(deps, pair[0].id), bookOf(deps, pair[1].id)], entries, records };
}

/** The expert's latest answer to the case after it was (last) found: typed statement or parsed voice answer. */
function latestAnswer(deps: DisagreementDeps, entries: readonly LedgerEntry[], found: LedgerEntry, witnessId: string, questionId: string, expert: Index): Answer | undefined {
  let latest: Answer | undefined;
  for (const e of entries) {
    if (e.sessionId !== found.sessionId || e.sequence <= found.sequence) continue;
    if (e.kind === "expert.statement") {
      const s = parseLedgerPayload(e, "expert.statement");
      if (s.intent === "answer_disagreement" && s.target.witnessId === witnessId && s.target.action !== undefined)
        latest = { expert, action: s.target.action, entry: e, via: "typed", text: s.text };
    } else if (e.kind === "answer.parsed") {
      const p = parseLedgerPayload(e, "answer.parsed");
      const utterance = p.questionId === questionId && p.answeredAction !== undefined ? deps.ledger.get(p.utteranceId) : undefined;
      if (utterance?.kind === "utterance.transcript" && p.answeredAction !== undefined) {
        const u = parseLedgerPayload(utterance, "utterance.transcript");
        const translated = entries.find((t) => t.kind === "utterance.translated" && parseLedgerPayload(t, "utterance.translated").utteranceId === utterance.id);
        const translation = translated === undefined ? undefined : parseLedgerPayload(translated, "utterance.translated").translation;
        latest = {
          expert,
          action: p.answeredAction,
          entry: utterance,
          via: "voice",
          text: u.text,
          ...(u.language === "hi" && { language: "hi" as const }),
          ...(u.language === "hi" && translation !== undefined && { translation }),
        };
      }
    }
  }
  return latest;
}

// ── Evidence ──

/** The latest redacted screen frame of `entry`'s session at or before it. */
function frameAtOrBefore(entries: readonly LedgerEntry[], at: LedgerEntry): string | undefined {
  return entries.filter((e) => e.sessionId === at.sessionId && e.kind === SCREEN_FRAME_KIND && e.source === "client" && e.sequence <= at.sequence).at(-1)?.id;
}

function noScreenFrame(expertId: string): ApiFailure {
  return new ApiFailure(
    409,
    "no_screen_frame",
    `no redacted screen frame of expert ${expertId}'s session is on record before their answer: every confirmed rule shows what the expert saw`,
  );
}

/** The answer as an expert quote: the expert's original words (a voice answer keeps its language and stored translation). */
function quoteOf(ctx: Context, answer: Answer, relation: ExpertQuoteEvidence["relation"]): ExpertQuoteEvidence {
  const entries = ctx.entries[answer.expert];
  if (answer.via === "typed") {
    const frame = frameAtOrBefore(entries, answer.entry);
    if (frame === undefined) throw noScreenFrame(ctx.pair[answer.expert].id);
    return { kind: "expert_quote", utteranceId: answer.entry.id, exactQuote: answer.text, t0Ms: 0, t1Ms: 0, frameIds: [frame], eventIds: [], relation, provenance: "human_text" };
  }
  const u = parseLedgerPayload(answer.entry, "utterance.transcript");
  const [first, ...rest] = u.frameIds;
  const fallback = frameAtOrBefore(entries, answer.entry);
  const frameIds: [string, ...string[]] | undefined = first !== undefined ? [first, ...rest] : fallback === undefined ? undefined : [fallback];
  if (frameIds === undefined) throw noScreenFrame(ctx.pair[answer.expert].id);
  return {
    kind: "expert_quote",
    utteranceId: answer.entry.id,
    exactQuote: u.text,
    t0Ms: u.t0Ms,
    t1Ms: u.t1Ms,
    frameIds,
    eventIds: [],
    relation,
    provenance: "human_voice",
    ...(answer.language !== undefined && { language: answer.language }),
    ...(answer.translation !== undefined && { translation: answer.translation }),
  };
}

function confirmationOf(deps: DisagreementDeps, ctx: Context, answer: Answer): Confirmation {
  return { expertId: ctx.pair[answer.expert].id, at: deps.now(), method: "debrief", ledgerEntryId: answer.entry.id };
}

function decidingRuleIds(outcome: EffectiveOutcome): string[] {
  return outcome.kind === "decided" || outcome.kind === "conflict" ? outcome.ruleIds : [];
}

function promotionOrThrow(result: ReturnType<typeof promoteToConfirmedRule>): ConfirmedRule {
  if (!result.ok) throw new ApiFailure(422, "promotion_rejected", result.errors.map((e) => e.code).join(", "));
  return result.rule;
}

// ── Writes ──

class Writer {
  readonly ids: string[] = [];
  private readonly traceId = randomUUID();
  constructor(private readonly deps: DisagreementDeps) {}

  append<K extends Parameters<typeof entry>[1]>(sessionId: string, kind: K, source: LedgerEntry["source"], parents: readonly (string | undefined)[], payload: PayloadInput<K>): LedgerEntry {
    const session = this.deps.ledger.getSession(sessionId);
    if (session === undefined) throw new ApiFailure(404, "session_not_found", `no session ${sessionId}`);
    const ctx: EntryContext = { sessionId, occurredAt: this.deps.now(), traceId: this.traceId, privacyEpoch: session.privacyEpoch };
    const written = this.deps.ledger.append(entry(ctx, kind, source, [...new Set(parents.filter((p): p is string => p !== undefined))], payload));
    this.ids.push(written.id);
    return written;
  }
}

function requireSessionsOnRecord(deps: DisagreementDeps, sessionIds: readonly string[]): void {
  for (const id of sessionIds) {
    const session = deps.ledger.getSession(id);
    if (session === undefined) throw new ApiFailure(404, "session_not_found", `no session ${id}`);
    requireOnRecord(session);
  }
}

/**
 * Writes the resolution of an open disagreement both experts answered with the same action (see the
 * module comment). Returns the rule entry; nothing is written when validation fails.
 */
function writeResolution(deps: DisagreementDeps, ctx: Context, record: Recorded, w: Writer): LedgerEntry {
  const [ansA, ansB] = record.answers;
  if (ansA === undefined || ansB === undefined || ansA.action !== ansB.action) throw new Error("writeResolution needs two equal answers");
  const y = ansA.action;
  const lookup = recordLookup(record.witness.assignment);
  const outcomes = ctx.books.map((b) => effectiveOutcome(b.rules, ctx.family, lookup)) as [EffectiveOutcome, EffectiveOutcome];
  const key = `action:${y}`;
  const decides = (o: EffectiveOutcome): string | undefined => (o.kind === "decided" ? o.outcome : undefined);
  const adopter = INDEXES.find((i) => decides(outcomes[i]) === key);
  const entryIds = ruleEntryIds(ctx.all);
  const quotes = [quoteOf(ctx, ansA, "supports"), quoteOf(ctx, ansB, "supports")] as const;
  const confirmations = [confirmationOf(deps, ctx, ansA), confirmationOf(deps, ctx, ansB)] as const;
  const contradicting = (ruleIds: readonly string[]): ExpertQuoteEvidence[] =>
    ruleIds.flatMap((id) => {
      const quote = ctx.all.rules.find((r) => r.id === id);
      const first = quote === undefined ? undefined : supportingQuotes(quote)[0];
      return first === undefined ? [] : [{ ...first, relation: "contradicts" as const }];
    });
  const foundIds = record.found.map((f) => f?.id);
  const answerIds = [ansA.entry.id, ansB.entry.id];
  const pairNames = `${ctx.pair[0].name} (${ctx.pair[0].id}) and ${ctx.pair[1].name} (${ctx.pair[1].id})`;

  if (adopter !== undefined) {
    const dissenter: Index = adopter === 0 ? 1 : 0;
    const adopterOutcome = outcomes[adopter];
    const oldId = decidingRuleIds(adopterOutcome).sort()[0];
    const old = ctx.all.rules.find((r) => r.id === oldId);
    if (old === undefined) throw new ApiFailure(409, "rule_not_live", `rule ${String(oldId)} is not live`);
    const overridden = decidingRuleIds(outcomes[dissenter]).filter((id) => id !== old.id);
    const lead = quotes[dissenter];
    const nominal = old.effect.type === "recommend" ? old.effect.action : y;
    // Validation vehicle: both quotes, both confirmations' ledger entries and the frames are checked against the ledger.
    promotionOrThrow(
      promoteToConfirmedRule({
        ruleId: old.id,
        domain: DOMAIN,
        decisionFamily: old.decisionFamily,
        source: { statedRule: { predicate: old.predicate, action: nominal, kind: "decision", effect: { type: "recommend", action: nominal }, exactQuote: lead.exactQuote, t0Ms: lead.t0Ms, t1Ms: lead.t1Ms } },
        kind: old.kind,
        effect: old.effect,
        priority: old.priority,
        overrides: old.overrides,
        evidence: [lead, quotes[adopter]],
        confirmation: confirmations[dissenter],
        expertId: old.expertId,
        schemaVersion: old.schemaVersion,
        ledger: deps.ledger,
      }),
    );
    const rule = ConfirmedRuleSchema.parse({
      ...old,
      overrides: [...new Set([...old.overrides, ...overridden])].sort(),
      revision: old.revision + 1,
      evidence: [lead, quotes[adopter], ...contradicting(overridden), ...old.evidence],
      confirmedBy: [confirmations[dissenter], confirmations[adopter], ...old.confirmedBy],
    });
    const session = record.found[dissenter]?.sessionId ?? latestSession(ctx.pair[dissenter]);
    return w.append(session, "rule.revised", "engine", [...answerIds, ...foundIds, entryIds.get(old.id)], {
      rule,
      reason: `two experts reconciled, ${pairNames}: both decide "${actionPhrase(DOMAIN, y)}" on disagreement ${record.witness.id}`,
    });
  }

  // Neither rulebook decides y: a new rule for the case's decision cell, confirmed by both experts.
  const union = [...new Map([...ctx.books[0].rules, ...ctx.books[1].rules].map((r) => [r.id, r])).values()];
  const predicate = cellPredicate(decisionCell(union, ctx.family, record.witness.assignment));
  if (predicate === undefined) throw new ApiFailure(409, "empty_cell", "no rule reads this family yet");
  const overridden = [...new Set([...decidingRuleIds(outcomes[0]), ...decidingRuleIds(outcomes[1])])].sort();
  const firing = decisionRulesOf(union, ctx.family).filter((d) => ruleFires(d.rule, union, lookup) === true).map((d) => d.rule.priority);
  const priority = Math.max(RULE_PRIORITY_BY_KIND.decision, ...firing);
  const created = promotionOrThrow(
    promoteToConfirmedRule({
      ruleId: contentId("rule", canonicalJson({ disagreement: record.witness.id, answers: answerIds })),
      domain: DOMAIN,
      decisionFamily: ctx.family.id,
      source: { statedRule: { predicate, action: y, kind: "decision", effect: { type: "recommend", action: y }, exactQuote: quotes[0].exactQuote, t0Ms: quotes[0].t0Ms, t1Ms: quotes[0].t1Ms } },
      priority,
      overrides: overridden,
      evidence: [...quotes, ...contradicting(overridden)],
      confirmation: confirmations[0],
      expertId: ctx.pair[0].id,
      schemaVersion: SCHEMA_VERSION,
      ledger: deps.ledger,
    }),
  );
  const rule = ConfirmedRuleSchema.parse({ ...created, confirmedBy: [...created.confirmedBy, confirmations[1]] });
  const session = record.found[0]?.sessionId ?? latestSession(ctx.pair[0]);
  return w.append(session, "rule.confirmed", "engine", [...answerIds, ...foundIds, ...overridden.map((id) => entryIds.get(id))], { rule });
}

function questionText(ctx: Context, w: DisagreementWitness): string {
  const union = [...ctx.books[0].rules, ...ctx.books[1].rules];
  const desc = caseDescription(cellPhrases(DOMAIN, decisionCell(union, ctx.family, w.assignment)));
  const labels = w.actions.filter((a) => a !== UNRESOLVED_LABEL).map((a) => actionPhrase(DOMAIN, a));
  const [first, second] = labels;
  const choice = first !== undefined && second !== undefined ? `${first} or ${second}` : `${first ?? "which decision"}, or something else`;
  return withinWords([`${desc} — ${choice}?`, `${desc}: what would you decide?`, `${desc}?`], MAX_QUESTION_WORDS);
}

/** Records a disagreement the solver found in both experts' latest sessions and asks each expert. */
async function recordAndAsk(deps: DisagreementDeps, ctx: Context, witness: DisagreementWitness, w: Writer): Promise<void> {
  const entryIds = ruleEntryIds(ctx.all);
  const lookup = recordLookup(witness.assignment);
  const deciding = ctx.books.flatMap((b) => decidingRuleIds(effectiveOutcome(b.rules, ctx.family, lookup))).map((id) => entryIds.get(id));
  for (const i of INDEXES) {
    const expert = ctx.pair[i];
    const sessionId = latestSession(expert);
    const found = w.append(sessionId, "witness.found", "solver", deciding, witness);
    const english = QuestionSchema.parse({
      id: questionIdFor(sessionId, witness.id, found.id),
      sessionId,
      kind: "witness",
      text: questionText(ctx, witness),
      decisionFamily: witness.decisionFamily,
      target: { candidateIds: [], witnessId: witness.id, assignment: witness.assignment },
      value: 0.8,
      reason: `solver: ${ctx.pair[0].name} and ${ctx.pair[1].name} decide this case differently`,
      ephemeral: false,
      createdAt: deps.now(),
      contextVersion: deps.authorizations.getContextVersion(sessionId),
      parentIds: [found.id],
    });
    // Spoken in the expert's language (Sonnet translation, `textEnglish` kept); English when no model is available.
    const question = QuestionSchema.parse(await deps.localize(english, expert.language));
    w.append(sessionId, "question.queued", "engine", [found.id], question);
  }
}

/**
 * One reconciliation step for the pair: resolve every open disagreement both experts answered alike,
 * rerun the solver, close what it no longer finds, record and ask what it finds anew.
 */
async function advance(deps: DisagreementDeps, ids: readonly [string, string], familyId: string, w: Writer): Promise<void> {
  let ctx = load(deps, ids, familyId);
  requireSessionsOnRecord(deps, ctx.pair.map(latestSession));
  for (const record of ctx.records.values()) {
    const [a, b] = record.answers;
    if (record.closed !== undefined || a === undefined || b === undefined || a.action !== b.action) continue;
    if (record.resolution !== undefined && [a.entry.id, b.entry.id].every((id) => record.resolution?.parentIds.includes(id))) continue;
    writeResolution(deps, ctx, record, w);
    ctx = load(deps, ids, familyId);
  }
  const current = await deps.solver({
    domain: DOMAIN,
    rulesA: ctx.books[0].rules,
    rulesB: ctx.books[1].rules,
    experts: [ctx.pair[0].id, ctx.pair[1].id],
    family: ctx.family.id,
    schemaVersion: SCHEMA_VERSION,
  });
  const currentIds = new Set(current.map((c) => c.id));
  const latestRuleEntry = [...ctx.books[0].history, ...ctx.books[1].history].map((h) => deps.ledger.get(h.ledgerEntryId)).filter((e) => e !== undefined).sort((x, y) => x.receivedAt - y.receivedAt).at(-1);
  for (const record of ctx.records.values()) {
    if (record.closed !== undefined || currentIds.has(record.witness.id)) continue;
    const cause = record.resolution ?? latestRuleEntry;
    if (cause === undefined) continue;
    const resolution = record.resolution?.kind === "rule.confirmed" ? "rule_added" : "rule_revised";
    for (const found of record.found) {
      if (found === undefined) continue;
      w.append(found.sessionId, "witness.resolved", "engine", [found.id, cause.id], { witnessId: record.witness.id, resolution, ledgerEntryId: cause.id });
    }
    for (const q of record.questions)
      if (q.status === "queued") w.append(q.sessionId, "question.dropped", "engine", [q.queuedEntryId, cause.id], { questionId: q.question.id, reason: "superseded" });
  }
  for (const witness of current) {
    const record = ctx.records.get(witness.id);
    if (record !== undefined && record.closed === undefined) continue;
    await recordAndAsk(deps, ctx, witness, w);
  }
}

// ── Public operations ──

export type PairRequest = { experts: readonly [string, string]; decisionFamily: string };

/** POST /api/disagreements: one reconciliation step, then the pair's state. */
export function searchDisagreements(deps: DisagreementDeps, req: PairRequest): Promise<{ written: string[] }> {
  return serially(deps, async () => {
    const w = new Writer(deps);
    await advance(deps, req.experts, req.decisionFamily, w);
    return { written: w.ids };
  });
}

/** POST /api/disagreements/answer: one expert decides a disagreement case in their own typed words; then a reconciliation step. */
export function answerDisagreement(
  deps: DisagreementDeps,
  req: PairRequest & { witnessId: string; expertId: string; decision: ActionId; quote: string },
): Promise<{ statementId: string; written: string[] }> {
  return serially(deps, async () => {
    const ctx = load(deps, req.experts, req.decisionFamily);
    const record = ctx.records.get(req.witnessId);
    if (record === undefined) throw new ApiFailure(404, "witness_not_found", `no recorded disagreement ${req.witnessId} between these experts`);
    if (record.closed !== undefined) throw new ApiFailure(409, "witness_closed", "this disagreement is already resolved");
    const index = INDEXES.find((i) => ctx.pair[i].id === req.expertId);
    if (index === undefined) throw new ApiFailure(400, "unknown_expert", `${req.expertId} is not one of the two experts`);
    if (!ctx.family.actions.includes(req.decision)) throw new ApiFailure(400, "invalid_action", `${req.decision} is not an action of ${ctx.family.id}`);
    const found = record.found[index];
    if (found === undefined) throw new ApiFailure(409, "witness_not_recorded", `the case was not recorded in ${req.expertId}'s session`);
    const session = deps.ledger.getSession(found.sessionId);
    if (session === undefined) throw new ApiFailure(404, "session_not_found", found.sessionId);
    requireOnRecord(session);
    if (!ctx.entries[index].some((e) => e.sessionId === found.sessionId && e.kind === SCREEN_FRAME_KIND && e.source === "client")) throw noScreenFrame(req.expertId);
    const w = new Writer(deps);
    const question = record.questions.find((q) => q.expert === index);
    const statement = w.append(found.sessionId, "expert.statement", "expert", [found.id, question?.queuedEntryId], {
      text: req.quote,
      intent: "answer_disagreement",
      target: { witnessId: record.witness.id, action: req.decision },
    });
    await advance(deps, req.experts, req.decisionFamily, w);
    return { statementId: statement.id, written: w.ids.filter((id) => id !== statement.id) };
  });
}

// ── Views ──

function expertView(e: ExpertRecord): ExpertView {
  return { id: e.id, name: e.name, language: e.language, named: e.named, sessionIds: e.sessionIds };
}

function actionLabel(action: string): string {
  if (action === UNRESOLVED_LABEL) return "No rule decides";
  return DOMAIN.actions.find((a) => a.id === action)?.label ?? action.replaceAll("_", " ");
}

function bookDecision(book: Rulebook, family: DecisionFamily, w: DisagreementWitness): z.infer<typeof BookDecisionSchema> {
  const out = effectiveOutcome(book.rules, family, recordLookup(w.assignment));
  if (out.kind === "decided") {
    const action = out.outcome.startsWith("action:") ? out.outcome.slice("action:".length) : out.outcome.slice("route:".length);
    const known = DOMAIN.actions.find((a) => a.id === action);
    return { kind: "decided", action: known === undefined ? null : known.id, label: actionLabel(action), ruleIds: out.ruleIds };
  }
  if (out.kind === "conflict") return { kind: "conflict", action: null, label: "Conflicting rules", ruleIds: out.ruleIds };
  return { kind: out.kind, action: null, label: out.kind === "unresolved" ? "No rule decides" : "Undetermined", ruleIds: [] };
}

function inFamily(rule: ConfirmedRule, family: DecisionFamily): boolean {
  return rule.decisionFamily === family.id || (rule.effect.type === "forbid" && family.actions.includes(rule.effect.action));
}

/** Rule cards of the family; `owner` is the expert whose rulebook is shown (the team view uses each rule's author). */
function cards(rules: readonly ConfirmedRule[], ctx: Pick<Context, "family" | "all">, owner: string | undefined, held: ReadonlySet<string>): RuleCard[] {
  const entryIds = ruleEntryIds(ctx.all);
  return rules
    .filter((r) => inFamily(r, ctx.family))
    .map((rule) => ({ rule, ...ruleText(DOMAIN, rule), entryId: entryIds.get(rule.id) ?? null, held: held.has(rule.id), sharedWith: ruleExperts(rule).filter((e) => e !== (owner ?? rule.expertId)) }));
}

function caseLines(ctx: Context, w: DisagreementWitness): DisagreementView["caseLines"] {
  const referenced = new Set<string>(
    [...ctx.books[0].rules, ...ctx.books[1].rules].filter((r) => r.decisionFamily === ctx.family.id).flatMap((r) => featuresReferenced(r.predicate)),
  );
  return DOMAIN.features
    .filter((f) => Object.hasOwn(w.assignment, f.id) && (referenced.size === 0 || referenced.has(f.id)))
    .map((f) => {
      const value = w.assignment[f.id];
      return { feature: f.id, label: f.label, value: value === undefined ? "—" : formatValue(f, value) };
    });
}

function answerView(ctx: Context, a: Answer | undefined): DisagreementAnswer | null {
  if (a === undefined) return null;
  return {
    expertId: ctx.pair[a.expert].id,
    action: a.action,
    actionLabel: actionLabel(a.action),
    quote: { text: a.text, ...(a.language !== undefined && { language: a.language }), ...(a.translation !== undefined && { translation: a.translation }) },
    entryId: a.entry.id,
    via: a.via,
  };
}

function resolutionView(ctx: Context, record: Recorded): DisagreementView["resolution"] {
  const e = record.resolution;
  if (e === undefined) return null;
  const event = ctx.all.history.find((h) => h.ledgerEntryId === e.id);
  const text = (r: ConfirmedRule) => ({ ...ruleText(DOMAIN, r), overrides: r.overrides, experts: ruleExperts(r) });
  if (event?.kind === "revised")
    return { kind: "rule_revised", ruleId: event.ruleId, ledgerEntryId: e.id, revision: event.after.revision, before: text(event.before), after: text(event.after), fields: event.fields };
  if (event?.kind === "confirmed") return { kind: "rule_added", ruleId: event.ruleId, ledgerEntryId: e.id, revision: 1, before: null, after: text(event.rule), fields: [] };
  return null;
}

function pairState(deps: DisagreementDeps, ids: readonly [string, string], familyId: string): PairState {
  const ctx = load(deps, ids, familyId);
  const team = deps.team();
  const held = new Set(team.held.map((h) => h.ruleId));
  const witnesses = [...ctx.records.values()].map((record): DisagreementView => {
    const [a, b] = record.answers;
    const status =
      record.closed !== undefined
        ? "resolved"
        : a !== undefined && b !== undefined
          ? a.action === b.action
            ? "agreed"
            : "still_disagree"
          : a !== undefined || b !== undefined
            ? "answered_one"
            : "asked";
    return {
      witness: record.witness,
      status,
      caseLines: caseLines(ctx, record.witness),
      decisions: [bookDecision(ctx.books[0], ctx.family, record.witness), bookDecision(ctx.books[1], ctx.family, record.witness)],
      foundActions: [actionLabel(record.witness.actions[0]), actionLabel(record.witness.actions[1])],
      questions: record.questions.map((q) => ({
        expertId: ctx.pair[q.expert].id,
        questionId: q.question.id,
        text: q.question.text,
        textEnglish: q.question.textEnglish ?? null,
        status: q.status,
        sessionId: q.sessionId,
      })),
      answers: [answerView(ctx, a), answerView(ctx, b)],
      resolution: resolutionView(ctx, record),
      foundEntryIds: record.found.flatMap((f) => (f === undefined ? [] : [f.id])),
    };
  });
  return {
    experts: [expertView(ctx.pair[0]), expertView(ctx.pair[1])],
    decisionFamily: ctx.family.id,
    familyLabel: ctx.family.label,
    rulebooks: [cards(ctx.books[0].rules, ctx, ctx.pair[0].id, held), cards(ctx.books[1].rules, ctx, ctx.pair[1].id, held)],
    witnesses,
    // Every rule in the base model, held-back ones marked: the team rulebook is the unmarked ones.
    team: cards(rulebookWithinModel(DOMAIN, ctx.all).rules, ctx, undefined, held),
    open: witnesses.filter((v) => v.status !== "resolved").length,
  };
}

export function disagreementsState(deps: DisagreementDeps, req: PairRequest | undefined): DisagreementsState {
  return {
    experts: deps.experts().map(expertView),
    families: DOMAIN.decisionFamilies.map((f) => ({ id: f.id, label: f.label })),
    pair: req === undefined ? null : pairState(deps, req.experts, req.decisionFamily),
  };
}
