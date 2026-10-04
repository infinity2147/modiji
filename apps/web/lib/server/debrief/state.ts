/**
 * The debrief of one expert session, derived from the ledger, the confirmed rulebook and the solver
 * (plan §7.5). `snapshot()` reads (it never writes); `debriefState()` turns a snapshot into the view
 * the debrief page shows. Coverage, witness statuses and gap counts are computed by code here — no
 * model is involved anywhere in this module.
 */
import "server-only";
import {
  ACKNOWLEDGING_RESOLUTIONS,
  SCREEN_FRAME_KIND,
  GAP_WITNESS_KINDS,
  acknowledgementFor,
  atomicConditions,
  canonicalJson,
  cellPredicate,
  computeCoverage,
  conceptValues,
  decisionCell,
  describePredicate,
  evaluatePredicate,
  expertRulebook,
  explainObserved,
  featurePhrase,
  featuresReferenced,
  findFeature,
  legacyExpertId,
  formatValue,
  observedDecisions,
  parseLedgerPayload,
  pendingBackfills,
  predictive,
  recordLookup,
  type AcknowledgedWitness,
  type ActionId,
  type CandidateRule,
  type CellLiteral,
  type ConfirmedRule,
  type Coverage,
  type DecisionFamily,
  type DomainConfig,
  type LedgerEntry,
  type ObservedDecision,
  type Rulebook,
  type Witness,
  type WitnessResolution,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import { ReviewEditsSchema } from "../../contracts/casedesk";
import type { DebriefState, RuleChange, WitnessStatus, WitnessView } from "../../contracts/debrief";
import type { DecisionViewSchema, GapSchema, ProposalSchema, RuleViewSchema } from "../../contracts/debrief";
import { ApiFailure } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, loadSession, type LoadedSession } from "../casedesk/session";
import { engineState, type EngineState, type FamilyState, type QuestionRecord } from "../interview/engine-state";
import { rulebookWithinModel } from "../schema/rulebook";
import type { DebriefDeps } from "./deps";
import { caseDescription, cellPhrases, ruleText } from "./text";

export const DOMAIN = KYC_DOMAIN;
export const SCHEMA_VERSION = CASEDESK_SCHEMA_VERSION;

/** Proposals shown per family besides the expert's own statements (heaviest first). */
const PROPOSALS_PER_FAMILY = 5;
/** A suggestion is offered in a witness question only when the hypotheses give it at least this probability. */
const SUGGESTION_MIN_PROBABILITY = 0.5;

/** Features of a CaseDesk case as the expert saw it (the case plus their own edits). */
export function kycCaseFeatures(caseId: string, edits: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> | undefined {
  const found = findKycCase(caseId);
  const parsed = ReviewEditsSchema.safeParse(edits);
  if (found === undefined || !parsed.success) return undefined;
  const { riskRating } = parsed.data;
  return caseFeatures(found, riskRating === undefined ? {} : { riskRating });
}

/** The expert of a capture session (named at session start, else the session's own legacy id); the interview engine uses the same. */
export function expertIdOf(loaded: LoadedSession): string {
  return loaded.info.expert?.id ?? legacyExpertId(loaded.session.id);
}

export type FoundWitness = { witness: Witness; entry: LedgerEntry };
export type TeachBackRecord = {
  entry: LedgerEntry;
  text: string;
  origin: "llm" | "template";
  ruleIds: string[];
  rulebookRevision: number;
  confirmedEntryId: string | undefined;
};

export type Snapshot = {
  loaded: LoadedSession;
  entries: LedgerEntry[];
  /** The session's feature model (base + expert-confirmed concepts, plan §6.6) and its version. */
  domain: DomainConfig;
  schemaVersion: number;
  /** The confirmed rules expressible in `domain`. */
  book: Rulebook;
  engine: EngineState;
  decisions: ObservedDecision[];
  /** Families with observed decisions in this session: the scope of the coverage claim. */
  families: string[];
  /** Witnesses the solver finds now under `book`. */
  current: Witness[];
  truncated: boolean;
  found: Map<string, FoundWitness>;
  resolutions: Map<string, { resolution: WitnessResolution; entry: LedgerEntry }>;
  acknowledged: AcknowledgedWitness[];
  /** Witness id → its debrief question (interview engine record). */
  questions: Map<string, QuestionRecord>;
  boundaryConfirmed: Map<string, LedgerEntry>;
  teachBack: TeachBackRecord | undefined;
  /** Teach-back question ids of this session. */
  teachBackQuestions: Map<string, QuestionRecord>;
};

function familyOf(id: string): DecisionFamily {
  const family = DOMAIN.decisionFamilies.find((f) => f.id === id);
  if (family === undefined) throw new RangeError(`unknown decision family ${id}`);
  return family;
}

async function currentWitnesses(
  deps: DebriefDeps,
  model: { domain: DomainConfig; schemaVersion: number },
  book: Rulebook,
  families: readonly string[],
): Promise<{ witnesses: Witness[]; truncated: boolean }> {
  if (families.length === 0) return { witnesses: [], truncated: false };
  const { domain, schemaVersion } = model;
  // Keyed by the feature list too: two sessions can be at the same version with different concepts.
  // Keyed by the rules themselves: per-expert books renumber their revisions, so two experts' books can share one.
  const key = canonicalJson({ rules: book.rules.map((r) => [r.id, r.revision]), families, schemaVersion, features: domain.features });
  let pending = deps.store.witnesses.get(key);
  if (pending === undefined) {
    pending = deps.solver({ domain, rules: book.rules, families, schemaVersion });
    deps.store.witnesses.set(key, pending);
    pending.catch(() => deps.store.witnesses.delete(key));
  }
  return pending;
}

/** 404 unless an expert CaseDesk session; returns it with its live privacy state. */
export function loadExpertSession(deps: DebriefDeps, sessionId: string): LoadedSession {
  const loaded = loadSession({ ledger: deps.ledger, store: deps.casedesk }, sessionId);
  if (loaded.info.mode !== "expert") throw new ApiFailure(409, "not_expert_session", "the debrief runs on an expert capture session");
  return loaded;
}

export async function snapshot(deps: DebriefDeps, sessionId: string): Promise<Snapshot> {
  const loaded = loadExpertSession(deps, sessionId);
  const entries = deps.ledger.evidence(loaded.session.id);
  const engine = engineState({ ledger: deps.ledger, store: deps.interview, config: deps.engineConfig }, loaded.session.id);
  const { domain, schemaVersion } = engine.schema.model;
  // The session expert's own rulebook (plan §7.10): rules they authored or confirmed, never another expert's.
  const book = rulebookWithinModel(domain, expertRulebook(deps.rulebook(), expertIdOf(loaded)));
  // Observed decisions carry the session's concept values (backfilled, or Unknown) next to the case features.
  const decisions = observedDecisions({ domain, entries, caseFeatures: kycCaseFeatures }).map((d) => ({
    ...d,
    features: { ...d.features, ...conceptValues(engine.schema, d.entry.id) },
  }));
  const families = domain.decisionFamilies.map((f) => f.id).filter((id) => decisions.some((d) => d.decisionFamily === id));
  const { witnesses: current, truncated } = await currentWitnesses(deps, { domain, schemaVersion }, book, families);

  const found = new Map<string, FoundWitness>();
  const resolutions = new Map<string, { resolution: WitnessResolution; entry: LedgerEntry }>();
  const boundaryConfirmed = new Map<string, LedgerEntry>();
  const teachBacks: LedgerEntry[] = [];
  const teachBackConfirmations = new Map<string, string>();
  // Disagreements between two experts (plan §7.10) are recorded in their sessions but belong to the
  // reconciliation flow (lib/server/disagreements), not to this expert's debrief.
  const disagreements = new Set<string>();
  for (const e of entries) {
    if (e.kind === "witness.found") {
      const witness = parseLedgerPayload(e, "witness.found");
      if (witness.kind === "disagreement") disagreements.add(witness.id);
      else if (!found.has(witness.id)) found.set(witness.id, { witness, entry: e });
    } else if (e.kind === "witness.resolved") {
      const resolution = parseLedgerPayload(e, "witness.resolved");
      if (!disagreements.has(resolution.witnessId)) resolutions.set(resolution.witnessId, { resolution, entry: e });
    } else if (e.kind === "expert.statement") {
      const s = parseLedgerPayload(e, "expert.statement");
      if (s.intent === "confirm_boundary" && s.target.witnessId !== undefined) boundaryConfirmed.set(s.target.witnessId, e);
    } else if (e.kind === "teachback.generated") teachBacks.push(e);
    else if (e.kind === "teachback.confirmed") for (const p of e.parentIds) teachBackConfirmations.set(p, e.id);
  }
  const acknowledged = [...resolutions.values()].flatMap(({ resolution }) => {
    const witness = found.get(resolution.witnessId)?.witness;
    return witness !== undefined && ACKNOWLEDGING_RESOLUTIONS.includes(resolution.resolution) ? [{ witness, resolution }] : [];
  });

  const questions = new Map<string, QuestionRecord>();
  const teachBackQuestions = new Map<string, QuestionRecord>();
  for (const record of engine.questions.values()) {
    const { kind, target } = record.question;
    if (kind === "witness" && target.witnessId !== undefined && !disagreements.has(target.witnessId)) questions.set(target.witnessId, record);
    if (kind === "teach_back") teachBackQuestions.set(record.question.id, record);
  }

  const latest = teachBacks.at(-1);
  const teachBack =
    latest === undefined
      ? undefined
      : (() => {
          const p = parseLedgerPayload(latest, "teachback.generated");
          return { entry: latest, ...p, confirmedEntryId: teachBackConfirmations.get(latest.id) };
        })();

  return {
    loaded,
    entries,
    domain,
    schemaVersion,
    book,
    engine,
    decisions,
    families,
    current,
    truncated,
    found,
    resolutions,
    acknowledged,
    questions,
    boundaryConfirmed,
    teachBack,
    teachBackQuestions,
  };
}

// ── Derived facts ──

export function isGap(w: Witness): boolean {
  return GAP_WITNESS_KINDS.includes(w.kind);
}

export function acknowledgement(snap: Snapshot, w: Witness): AcknowledgedWitness | undefined {
  return acknowledgementFor({ domain: snap.domain, rules: snap.book.rules, witness: w, acknowledged: snap.acknowledged });
}

/** A witness still asks something of the expert: current, not acknowledged, not a confirmed boundary. */
export function isOpen(snap: Snapshot, w: Witness): boolean {
  return snap.current.some((c) => c.id === w.id) && acknowledgement(snap, w) === undefined && !snap.boundaryConfirmed.has(w.id);
}

export function teachBackConfirmed(snap: Snapshot): boolean {
  return snap.teachBack !== undefined && snap.teachBack.rulebookRevision === snap.book.revision && snap.teachBack.confirmedEntryId !== undefined;
}

export function coverageOf(snap: Snapshot): Coverage {
  const coverage = computeCoverage({
    domain: snap.domain,
    rules: snap.book.rules,
    decisions: snap.decisions,
    witnesses: snap.current,
    resolutions: snap.acknowledged,
    undefinedConcepts: snap.engine.undefinedConcepts.length,
    teachBackConfirmed: teachBackConfirmed(snap),
    schemaVersion: snap.schemaVersion,
  });
  // A truncated unresolved list proves nothing about the cells it did not list; while a new concept is
  // still being backfilled (plan §6.6 "coverage recomputing"), the claim under the new model is not settled.
  const recomputing = pendingBackfills(snap.engine.schema, snap.decisions.map((d) => d.entry.id)).length > 0;
  return snap.truncated || recomputing ? { ...coverage, closed: false } : coverage;
}

/** The family's hypothesis state (interview engine). */
export function familyState(snap: Snapshot, family: string): FamilyState {
  const state = snap.engine.families.get(family);
  if (state === undefined) throw new RangeError(`no engine state for family ${family}`);
  return state;
}

/** The action the hypotheses predict for a witness case, when they predict one with ≥ 50%. */
export function suggestedAction(snap: Snapshot, w: Witness): ActionId | undefined {
  const fam = familyState(snap, w.decisionFamily);
  if (fam.set.candidates.length === 0) return undefined;
  const p = predictive(fam.model, fam.set.candidates, recordLookup(w.assignment));
  const best = p.reduce((bi, v, i) => (v > (p[bi] ?? 0) ? i : bi), 0);
  return (p[best] ?? 0) >= SUGGESTION_MIN_PROBABILITY ? fam.model.family.actions[best] : undefined;
}

export function cellOf(snap: Snapshot, w: Witness): ReturnType<typeof decisionCell> {
  return decisionCell(snap.book.rules, familyOf(w.decisionFamily), w.assignment);
}

/** The latest rule event entry of each live rule. */
export function ruleEntries(book: Rulebook): Map<string, string> {
  const out = new Map<string, string>();
  for (const h of book.history) if (h.kind !== "retired") out.set(h.ruleId, h.ledgerEntryId);
  return out;
}

/**
 * Proposal weight compared at 12 significant digits. Hypotheses that explain the observed cases equally well get the
 * same weight up to floating-point noise (1e-17 apart), and that noise must not decide which of them is proposed.
 */
function tieWeight(weight: number): number {
  return Number(weight.toPrecision(12));
}

/** Heaviest first; equally weighted proposals keep their order (sort is stable). */
export function byProposalWeight(a: { weight: number }, b: { weight: number }): number {
  return tieWeight(b.weight) - tieWeight(a.weight);
}

/**
 * Within each run of equally weighted candidates (heaviest first, then by id), alternate the predicted actions in order of
 * first appearance. A few observed cases leave many single-condition explanations tied for one decision (every feature
 * on which the lone PEP case differs predicts its outcome equally well); ordered by id alone, those could fill the whole
 * proposal budget, and no rule would be proposed for the other decisions. Only ties are reordered, so a caller that
 * re-sorts stably with `byProposalWeight` keeps this order.
 */
function interleaveTiedActions(candidates: readonly CandidateRule[]): CandidateRule[] {
  const sorted = [...candidates].sort((a, b) => byProposalWeight(a, b) || (a.id < b.id ? -1 : 1));
  const out: CandidateRule[] = [];
  for (let start = 0; start < sorted.length; ) {
    const weight = tieWeight(sorted[start]?.weight ?? 0);
    let end = start;
    while (end < sorted.length && tieWeight(sorted[end]?.weight ?? 0) === weight) end += 1;
    const queues = new Map<string, CandidateRule[]>();
    for (const c of sorted.slice(start, end)) queues.set(c.predictedAction, [...(queues.get(c.predictedAction) ?? []), c]);
    for (let round = 0; out.length < end; round += 1)
      for (const queue of queues.values()) {
        const next = queue[round];
        if (next !== undefined) out.push(next);
      }
    start = end;
  }
  return out;
}

/** Proposed (unconfirmed) rules: the heaviest candidates and every expert statement, minus what is confirmed already. */
export function proposals(snap: Snapshot): { candidate: CandidateRule; family: string }[] {
  const confirmed = new Set(
    snap.book.rules.flatMap((r) => (r.effect.type === "recommend" ? [canonicalJson([r.decisionFamily, r.predicate, r.effect.action])] : [])),
  );
  return snap.families.flatMap((family) => {
    const ranked = interleaveTiedActions(familyState(snap, family).set.candidates);
    const picked = ranked.filter((c, i) => i < PROPOSALS_PER_FAMILY || c.origin === "expert_statement");
    return picked.filter((c) => !confirmed.has(canonicalJson([family, c.predicate, c.predictedAction]))).map((candidate) => ({ candidate, family }));
  });
}

/** Conditions of `w`'s rule at the boundary case, with the threshold feature stated exactly. */
export function boundaryPhrases(snap: Snapshot, w: Extract<Witness, { kind: "boundary" }>): string[] {
  const rule = snap.book.rules.find((r) => r.id === w.ruleId);
  if (rule === undefined) return [];
  const lookup = recordLookup(w.assignment);
  const literals: CellLiteral[] = atomicConditions(rule.predicate).flatMap((condition) => {
    const { truth } = evaluatePredicate(condition, lookup);
    return truth === "unknown" ? [] : [{ condition, holds: truth }];
  });
  const f = findFeature(snap.domain, w.feature);
  const others = cellPhrases(snap.domain, literals.filter((l) => !featuresReferenced(l.condition).includes(w.feature)));
  return [`${f === undefined ? w.feature : featurePhrase(f)} exactly ${formatValue(f, w.threshold)}`, ...others];
}

// ── View ──

function witnessStatus(snap: Snapshot, w: Witness, isCurrent: boolean): WitnessStatus {
  if (acknowledgement(snap, w) !== undefined) return "acknowledged";
  if (snap.boundaryConfirmed.has(w.id)) return "confirmed";
  if (!isCurrent) return snap.resolutions.has(w.id) ? "resolved" : "superseded";
  const q = snap.questions.get(w.id);
  if (q?.status === "asked") return "asked";
  if (q?.status === "queued") return "queued";
  return "open";
}

export function witnessView(snap: Snapshot, w: Witness): WitnessView {
  const isCurrent = snap.current.some((c) => c.id === w.id);
  const q = snap.questions.get(w.id);
  const cell = isCurrent ? cellOf(snap, w) : [];
  const predicate = w.kind === "unresolved" && isCurrent ? cellPredicate(cell) : undefined;
  const resolution = snap.resolutions.get(w.id)?.resolution ?? acknowledgement(snap, w)?.resolution ?? null;
  return {
    witness: w,
    status: witnessStatus(snap, w, isCurrent),
    current: isCurrent,
    foundEntryId: snap.found.get(w.id)?.entry.id ?? null,
    question: q === undefined ? null : { id: q.question.id, text: q.question.text, entryId: q.queuedEntryId },
    resolution,
    conditions: !isCurrent ? [] : w.kind === "boundary" ? boundaryPhrases(snap, w) : cellPhrases(snap.domain, cell),
    cellRule: predicate === undefined ? null : { predicate, text: describePredicate(predicate, snap.domain) },
    suggestedAction: isCurrent && w.kind === "unresolved" ? (suggestedAction(snap, w) ?? null) : null,
  };
}

function ruleChange(snap: Snapshot): RuleChange | null {
  const last = snap.book.history.at(-1);
  if (last === undefined) return null;
  const view = (r: ConfirmedRule): NonNullable<RuleChange["before"]> => ({
    ...ruleText(snap.domain, r),
    priority: r.priority,
    overrides: r.overrides,
  });
  const live = snap.book.rules.find((r) => r.id === last.ruleId);
  return {
    rulebookRevision: last.rulebookRevision,
    kind: last.kind,
    ruleId: last.ruleId,
    ledgerEntryId: last.ledgerEntryId,
    fields: last.kind === "revised" ? last.fields : [],
    before: last.kind === "confirmed" ? null : view(last.before),
    after: last.kind === "revised" ? view(last.after) : live === undefined ? null : view(live),
    reason: last.kind === "confirmed" ? null : last.reason,
  };
}

/** Witness questions closed / asked, for the compliance strip ("Debrief gaps closed 3/3"). */
export function gapsClosed(snap: Snapshot): { closed: number; total: number } {
  const asked = [...snap.found.values()].filter(({ witness }) => snap.questions.has(witness.id));
  const closed = asked.filter(({ witness }) => ["resolved", "acknowledged", "confirmed"].includes(witnessStatus(snap, witness, snap.current.some((c) => c.id === witness.id))));
  return { closed: closed.length, total: asked.length };
}

/** Voice answers to debrief questions that no debrief entry has consumed yet. */
export function pendingVoiceAnswers(snap: Snapshot): LedgerEntry[] {
  const mine = new Set([...snap.questions.values(), ...snap.teachBackQuestions.values()].map((r) => r.question.id));
  const consumed = new Set(snap.entries.filter((e) => ["rule.confirmed", "rule.revised", "witness.resolved", "teachback.confirmed"].includes(e.kind)).flatMap((e) => e.parentIds));
  return snap.entries.filter((e) => {
    if (e.kind !== "utterance.transcript" || consumed.has(e.id)) return false;
    const u = snap.engine.utterances.get(e.id);
    return u?.questionId !== undefined && mine.has(u.questionId);
  });
}

export function debriefState(deps: DebriefDeps, snap: Snapshot): DebriefState {
  const { book } = snap;
  const coverage = coverageOf(snap);
  const entryOf = ruleEntries(book);
  const decisions: z.infer<typeof DecisionViewSchema>[] = snap.decisions.map((d) => {
    const ex = explainObserved(snap.domain, book.rules, d);
    return {
      entryId: d.entry.id,
      caseId: d.caseId,
      action: d.action,
      actionLabel: DOMAIN.actions.find((a) => a.id === d.action)?.label ?? d.action,
      explained: ex.explained,
      ruleIds: ex.ruleIds,
    };
  });
  const witnessIds = new Set<string>();
  const witnesses = [...snap.current, ...[...snap.found.values()].map((f) => f.witness)]
    .filter((w) => !witnessIds.has(w.id) && witnessIds.add(w.id))
    .map((w) => witnessView(snap, w));

  const gaps: z.infer<typeof GapSchema>[] = [
    ...[...snap.engine.questions.values()]
      .filter((r) => r.status === "queued" && r.question.kind !== "witness" && r.question.kind !== "teach_back")
      .map((r) => ({ source: "live_question" as const, id: r.question.id, text: r.question.text, ledgerEntryId: r.queuedEntryId })),
    ...decisions
      .filter((d) => !d.explained)
      .map((d) => ({ source: "unexplained_decision" as const, id: d.entryId, text: `${d.caseId}: "${d.actionLabel}" is not explained by a confirmed rule`, ledgerEntryId: d.entryId })),
    ...snap.engine.undefinedConcepts.map((c) => ({ source: "undefined_concept" as const, id: c.name, text: `Undefined concept: ${c.label}`, ledgerEntryId: null })),
    ...witnesses
      .filter((v) => v.current && isGap(v.witness) && (v.status === "open" || v.status === "queued" || v.status === "asked"))
      .map((v) => ({
        source: "witness" as const,
        id: v.witness.id,
        text: `${v.witness.kind === "conflict" ? "Conflicting rules" : "No rule decides"}: ${caseDescription(v.conditions) || "any case of this family"}`,
        ledgerEntryId: v.foundEntryId,
      })),
  ];

  const proposalViews: z.infer<typeof ProposalSchema>[] = proposals(snap).map(({ candidate, family }) => ({
    candidateId: candidate.id,
    decisionFamily: family,
    action: candidate.predictedAction,
    predicate: candidate.predicate,
    text: ruleText(snap.domain, { predicate: candidate.predicate, effect: { type: "recommend", action: candidate.predictedAction } }).when,
    origin: candidate.origin,
    weight: candidate.weight,
  }));

  const rules: z.infer<typeof RuleViewSchema>[] = book.rules.flatMap((rule) => {
    const entryId = entryOf.get(rule.id);
    return entryId === undefined ? [] : [{ rule, ...ruleText(snap.domain, rule), entryId, explains: decisions.filter((d) => d.ruleIds.includes(rule.id)).length }];
  });

  const tb = snap.teachBack;
  const tbQuestion = tb === undefined ? undefined : [...snap.teachBackQuestions.values()].find((r) => r.question.parentIds.includes(tb.entry.id));
  return {
    sessionId: snap.loaded.session.id,
    rulebookRevision: book.revision,
    coverage,
    decisions,
    gaps,
    witnesses,
    proposals: proposalViews,
    rules,
    lastChange: ruleChange(snap),
    teachBack:
      tb === undefined
        ? null
        : {
            entryId: tb.entry.id,
            text: tb.text,
            origin: tb.origin,
            rulebookRevision: tb.rulebookRevision,
            ruleIds: tb.ruleIds,
            current: tb.rulebookRevision === book.revision,
            confirmedEntryId: tb.confirmedEntryId ?? null,
            questionId: tbQuestion?.question.id ?? null,
          },
    debriefQuestions: snap.questions.size,
    gapsClosed: gapsClosed(snap),
    pendingVoiceAnswers: pendingVoiceAnswers(snap).length,
    screenFrames: snap.entries.filter((e) => e.kind === SCREEN_FRAME_KIND && e.source === "client").length,
    llmAvailable: deps.claude !== null,
  };
}
