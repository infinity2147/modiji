/**
 * Per-session hypothesis-engine state (plan §7.3), derived from the ledger and from nothing else.
 *
 * `engineState()` folds the session's entries in sequence order: committed expert decisions become
 * observations (surprise judged before the update), `answer.parsed` entries are applied with the
 * engine's `applyAnswer`, the question queue follows `question.queued` / `question.dropped` /
 * `gate.authorized` / `question.requeued`, the rulebook is `rulebookFromLedger` over the rule events. The result is cached
 * per session together with the last sequence folded, so each request only folds what is new and a
 * restarted process rebuilds exactly the same state from the ledger. Nothing here writes.
 *
 * The fold never throws: an entry it cannot apply is listed in `skipped` with the reason.
 */
import "server-only";
import {
  EMPTY_KNOWLEDGE,
  applyAnswer,
  buildHypothesisSet,
  canonicalJson,
  contentId,
  describePredicate,
  familyModel,
  findFeature,
  observeDecision,
  parseLedgerPayload,
  REMODEL_LEDGER_KINDS,
  conceptValues,
  rulebookFromLedger,
  type AnswerApplication,
  type AnsweredUtterance,
  type EngineConfig,
  type ExpertLanguage,
  type FamilyKnowledge,
  type FamilyModel,
  type FeatureId,
  type FeatureValue,
  type HypothesisSet,
  type LedgerEntry,
  type MasteryLevel,
  type ProposedConcept,
  type Question,
  type RecentDecision,
  type Rulebook,
  type SessionSchema,
  type TranscriptLine,
  type TranslationSegment,
} from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import { ReviewEditsSchema, type SessionMode } from "../../contracts/casedesk";
import type { EngineStateResponseSchema } from "../../contracts/interview";
import { sessionExpert, type SessionExpert } from "../casedesk/session";
import { sessionSchema } from "../schema/session-schema";

/** Candidates shown per family on the HUD and in `hypotheses.updated`. */
export const TOP_CANDIDATES = 5;

export type DecisionRecord = {
  entryId: string;
  caseId: string;
  /** Case features plus the session's confirmed concepts (backfilled, or Unknown while not read). */
  features: Record<FeatureId, FeatureValue>;
  /** The decision judged against the hypotheses held before it arrived. */
  recent: RecentDecision;
};

export type FamilyState = {
  model: FamilyModel;
  knowledge: FamilyKnowledge;
  set: HypothesisSet;
  /** Committed expert decisions of this family, in ledger order. */
  decisions: DecisionRecord[];
};

export type QuestionRecord = {
  question: Question;
  queuedEntryId: string;
  /**
   * An authorised question is never dropped. It returns to `queued` only when its authorization expired
   * unspoken (`question.requeued`): it was never asked, and the live budget does not count it.
   */
  status: "queued" | "dropped" | "asked";
  asked?: { entryId: string; at: number };
  /** The `answer.parsed` entry of its answer, once parsed (an answer is parsed once). */
  answeredBy?: string;
};

export type UtteranceRecord = {
  entryId: string;
  /** The expert's original words (the evidence), in `language`. */
  text: string;
  t0Ms: number;
  t1Ms: number;
  frameIds: string[];
  /** Detected when recorded (plan §7.11); "en" for utterances recorded without one. */
  language: ExpertLanguage;
  /**
   * The verified English machine translation (`utterance.translated`), for non-English utterances.
   * Undefined while pending: no model, or the translation failed or was rejected (see `translationPending`).
   */
  translation: { entryId: string; text: string; segments: TranslationSegment[] } | undefined;
  /** The asked question this utterance answers (its parent `gate.authorized` entry). */
  questionId: string | undefined;
  /** An `answer.parsed` entry exists for it. */
  parsed: boolean;
};

export type AnswerOutcome = Pick<AnswerApplication, "status" | "statedRules" | "ignored" | "unexplained"> & { decisionFamily: string };

export type EngineState = {
  sessionId: string;
  mode: SessionMode | undefined;
  /** The session's expert (expert sessions; read from `session.started`, plan §7.10). */
  expert: SessionExpert | undefined;
  /** Sequence of the last entry folded (-1 before any). */
  lastSequence: number;
  families: Map<string, FamilyState>;
  /** Family of the latest committed decision: where an answer to a family-less question applies. */
  lastFamily: string | undefined;
  undefinedConcepts: ProposedConcept[];
  /**
   * The session's feature model (base domain + expert-confirmed concepts, plan §6.6) and concept state,
   * as of the last rebuild: every family model, hypothesis set and observation uses `schema.model`.
   */
  schema: SessionSchema;
  questions: Map<string, QuestionRecord>;
  /** `question.queued` and `gate.authorized` entry id → question id. */
  questionByEntry: Map<string, string>;
  utterances: Map<string, UtteranceRecord>;
  /** Expert and agent turns in order (never `system_control`), for the concept proposer. */
  transcript: TranscriptLine[];
  /** `answer.parsed` entry id → how the engine applied it. */
  answers: Map<string, AnswerOutcome>;
  ruleEvents: LedgerEntry[];
  rulebook: Rulebook;
  mastery: Map<string, MasteryLevel>;
  skipped: { ledgerEntryId: string; reason: string }[];
};

/**
 * An answer still being given: the transcript segments recorded for the asked question so far (each
 * its own `utterance.transcript` entry), parsed together once the answer window closes (orchestrator.ts).
 */
export type OpenAnswer = {
  questionId: string;
  segments: [AnsweredUtterance, ...AnsweredUtterance[]];
  traceId: string;
  /** Cancels the idle timer that would close it. */
  cancel: () => void;
};

/** Per-process interview state; one instance lives on the runtime. */
export type InterviewStore = {
  /** Derived engine state per session (a cache: the ledger is the source of truth). */
  states: Map<string, EngineState>;
  /** Tail of each session's serial engine work (see orchestrator.ts). */
  tails: Map<string, Promise<void>>;
  /** Each session's open answer (at most one). In memory: a restart leaves its segments recorded but unparsed (`unparsedAnswers`). */
  answers: Map<string, OpenAnswer>;
};

export function createInterviewStore(): InterviewStore {
  return { states: new Map(), tails: new Map(), answers: new Map() };
}

export type EngineStateDeps = { ledger: Pick<Ledger, "list">; store: InterviewStore; config: EngineConfig };

function hypothesisSetId(sessionId: string, family: string): string {
  return contentId("hs", canonicalJson({ sessionId, family }));
}

function initialState(sessionId: string, config: EngineConfig, schema: SessionSchema): EngineState {
  const { domain, schemaVersion } = schema.model;
  const families = new Map<string, FamilyState>();
  for (const f of domain.decisionFamilies) {
    const model = familyModel(domain, f.id, config);
    const set = buildHypothesisSet({
      setId: hypothesisSetId(sessionId, f.id),
      model,
      knowledge: EMPTY_KNOWLEDGE,
      schemaVersion,
      config,
    });
    families.set(f.id, { model, knowledge: EMPTY_KNOWLEDGE, set, decisions: [] });
  }
  return {
    sessionId,
    mode: undefined,
    expert: undefined,
    lastSequence: -1,
    families,
    lastFamily: undefined,
    undefinedConcepts: [],
    schema,
    questions: new Map(),
    questionByEntry: new Map(),
    utterances: new Map(),
    transcript: [],
    answers: new Map(),
    ruleEvents: [],
    rulebook: rulebookFromLedger([]),
    mastery: new Map(),
    skipped: [],
  };
}

/**
 * The session's engine state, folded up to the ledger's latest entry. When the feature model or a
 * concept's values change (a concept confirmed or dismissed, a version bump, a backfilled value), the
 * state is rebuilt from the whole ledger under the new model: hypotheses are re-enumerated over the new
 * feature set and every observation is re-observed with its backfilled (or Unknown) concept values.
 */
export function engineState(deps: EngineStateDeps, sessionId: string): EngineState {
  const cached = deps.store.states.get(sessionId);
  let entries = deps.ledger.list(sessionId, { afterSequence: cached?.lastSequence ?? -1 });
  let state = cached;
  if (state === undefined || entries.some((e) => REMODEL_LEDGER_KINDS.has(e.kind))) {
    if (state !== undefined) entries = deps.ledger.list(sessionId);
    state = initialState(sessionId, deps.config, sessionSchema(deps.ledger, sessionId));
  }
  for (const e of entries) {
    try {
      applyEntry(state, e, deps.config);
    } catch (error) {
      state.skipped.push({ ledgerEntryId: e.id, reason: error instanceof Error ? error.message : String(error) });
    }
    state.lastSequence = e.sequence;
  }
  deps.store.states.set(sessionId, state);
  return state;
}

/** The family a question's answer applies to: its own, else the latest decision's. */
export function questionFamily(state: EngineState, question: Question): FamilyState | undefined {
  const id = question.decisionFamily ?? state.lastFamily;
  return id === undefined ? undefined : state.families.get(id);
}

function applyEntry(state: EngineState, e: LedgerEntry, config: EngineConfig): void {
  switch (e.kind) {
    case "session.started": {
      const started = parseLedgerPayload(e, "session.started");
      state.mode = started.mode;
      state.expert = sessionExpert(state.sessionId, started.mode, started.expert);
      return;
    }
    case "case.decision":
      return applyDecision(state, e, config);
    case "answer.parsed":
      return applyParsedAnswer(state, e, config);
    case "concept.proposed": {
      const concept = parseLedgerPayload(e, "concept.proposed");
      if (unsettledConcept(state, concept.name) && !state.undefinedConcepts.some((c) => c.name === concept.name))
        state.undefinedConcepts = [...state.undefinedConcepts, concept];
      return;
    }
    case "question.queued": {
      const question = parseLedgerPayload(e, "question.queued");
      if (state.questions.get(question.id)?.status === "asked") throw new Error(`question ${question.id} was already asked`);
      state.questions.set(question.id, { question, queuedEntryId: e.id, status: "queued" });
      state.questionByEntry.set(e.id, question.id);
      return;
    }
    case "question.dropped": {
      const record = state.questions.get(parseLedgerPayload(e, "question.dropped").questionId);
      if (record?.status === "queued") record.status = "dropped";
      return;
    }
    case "gate.authorized": {
      const { questionId } = parseLedgerPayload(e, "gate.authorized");
      const record = state.questions.get(questionId);
      if (record === undefined) throw new Error(`authorised unknown question ${questionId}`);
      record.status = "asked";
      record.asked = { entryId: e.id, at: e.occurredAt };
      state.questionByEntry.set(e.id, questionId);
      return;
    }
    case "question.requeued": {
      const { questionId } = parseLedgerPayload(e, "question.requeued");
      const record = state.questions.get(questionId);
      if (record?.status !== "asked") throw new Error(`re-queued question ${questionId} was not asked`);
      record.status = "queued";
      delete record.asked;
      return;
    }
    case "utterance.transcript": {
      const u = parseLedgerPayload(e, "utterance.transcript");
      const questionId = e.parentIds.map((id) => state.questionByEntry.get(id)).find((id) => id !== undefined);
      state.utterances.set(e.id, {
        entryId: e.id,
        text: u.text,
        t0Ms: u.t0Ms,
        t1Ms: u.t1Ms,
        frameIds: u.frameIds,
        language: u.language ?? "en",
        translation: undefined,
        questionId,
        parsed: false,
      });
      state.transcript.push({ speaker: "expert", text: u.text });
      return;
    }
    case "utterance.translated": {
      const t = parseLedgerPayload(e, "utterance.translated");
      const utterance = state.utterances.get(t.utteranceId);
      if (utterance === undefined) throw new Error(`translation of unknown utterance ${t.utteranceId}`);
      if (utterance.language !== t.language) throw new Error(`translation from ${t.language} of a ${utterance.language} utterance`);
      // The first verified translation stands; a later one (a retry) never rewrites what readers saw.
      utterance.translation ??= { entryId: e.id, text: t.translation, segments: t.segments };
      return;
    }
    case "agent.utterance":
      state.transcript.push({ speaker: "apprentice", text: parseLedgerPayload(e, "agent.utterance").text });
      return;
    case "rule.confirmed":
    case "rule.revised":
    case "rule.retired":
      state.ruleEvents.push(e);
      state.rulebook = rulebookFromLedger(state.ruleEvents);
      return;
    case "mastery.updated": {
      const { ruleId, to } = parseLedgerPayload(e, "mastery.updated");
      state.mastery.set(ruleId, to);
      return;
    }
  }
}

/** Not a feature of the session's model and not dismissed by the expert: still an undefined concept. */
function unsettledConcept(state: EngineState, name: string): boolean {
  return findFeature(state.schema.model.domain, name) === undefined && !state.schema.dismissed.some((d) => d.name.toLowerCase() === name.toLowerCase());
}

/** Expert sessions only: the observed decision is the case as the expert saw it, with their edits. */
function applyDecision(state: EngineState, e: LedgerEntry, config: EngineConfig): void {
  const { caseId, action, edits } = parseLedgerPayload(e, "case.decision");
  if (state.mode !== "expert") return;
  const kycCase = findKycCase(caseId);
  if (kycCase === undefined) throw new Error(`unknown case ${caseId}`);
  const { riskRating } = ReviewEditsSchema.parse(edits);
  const features: Record<FeatureId, FeatureValue> = {
    ...caseFeatures(kycCase, riskRating === undefined ? {} : { riskRating }),
    ...conceptValues(state.schema, e.id),
  };
  for (const family of state.families.values()) {
    if (!family.model.family.actions.includes(action)) continue;
    const step = observeDecision({
      model: family.model,
      set: family.set,
      knowledge: family.knowledge,
      observation: { id: e.id, caseId, features, action },
      config,
    });
    family.set = step.set;
    family.knowledge = step.knowledge;
    family.decisions.push({ entryId: e.id, caseId, features, recent: step.recent });
    state.lastFamily = family.model.family.id;
  }
}

function applyParsedAnswer(state: EngineState, e: LedgerEntry, config: EngineConfig): void {
  const answer = parseLedgerPayload(e, "answer.parsed");
  for (const id of answer.segmentIds ?? [answer.utteranceId]) {
    const utterance = state.utterances.get(id);
    if (utterance !== undefined) utterance.parsed = true;
  }
  const record = state.questions.get(answer.questionId);
  if (record === undefined) throw new Error(`answer to unknown question ${answer.questionId}`);
  record.answeredBy ??= e.id;
  const family = questionFamily(state, record.question);
  if (family === undefined) throw new Error(`no decision family to apply the answer to question ${answer.questionId} to`);
  const result = applyAnswer({
    model: family.model,
    set: family.set,
    knowledge: family.knowledge,
    question: record.question,
    answer,
    undefinedConcepts: state.undefinedConcepts,
    config,
  });
  // A low-confidence answer still applies what the expert stated (`applyAnswer` withholds only inferences).
  family.set = result.set;
  family.knowledge = result.knowledge;
  state.undefinedConcepts = result.undefinedConcepts.filter((c) => unsettledConcept(state, c.name));
  state.answers.set(e.id, {
    status: result.status,
    statedRules: result.statedRules,
    ignored: result.ignored,
    unexplained: result.unexplained,
    decisionFamily: family.model.family.id,
  });
}

// ── Views ──

/** Pending questions, highest value first (ties by id). */
export function queuedQuestions(state: EngineState): QuestionRecord[] {
  return [...state.questions.values()]
    .filter((r) => r.status === "queued")
    .sort((a, b) => b.question.value - a.question.value || (a.question.id < b.question.id ? -1 : 1));
}

export function askedQuestions(state: EngineState): QuestionRecord[] {
  return [...state.questions.values()].filter((r) => r.status === "asked");
}

/** A non-English utterance with no verified translation on record yet (shown as "translation pending"). */
export function translationPending(u: Pick<UtteranceRecord, "language" | "translation">): boolean {
  return u.language !== "en" && u.translation === undefined;
}

/**
 * Answers recorded while no parser was available (or it failed): utterances to an asked question with no
 * `answer.parsed`. Replies to debrief conversation turns are not answers for the parser (the conversation
 * reads them), so they never count.
 */
export function unparsedAnswers(state: EngineState): UtteranceRecord[] {
  return [...state.utterances.values()].filter((u) => u.questionId !== undefined && !u.parsed && state.questions.get(u.questionId)?.question.kind !== "debrief_turn");
}

export function topCandidates(family: FamilyState): { candidateId: string; description: string; weight: number }[] {
  return [...family.set.candidates]
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
    .slice(0, TOP_CANDIDATES)
    .map((c) => ({
      candidateId: c.id,
      description: `if ${describePredicate(c.predicate, family.model.domain)} then ${c.predictedAction}`,
      weight: Math.min(1, Math.max(0, c.weight)),
    }));
}

/**
 * Decisions the hypotheses could not explain when they arrived — the engine's why-probe trigger
 * (candidates predicting them held less than `explainedMass`). Judged on arrival, not now: once a
 * decision is observed, the enumerator always produces candidates that fit it, which explains it
 * "by construction" without explaining anything about the expert's reasons.
 */
export function unexplainedDecisions(family: FamilyState, config: EngineConfig): DecisionRecord[] {
  return family.decisions.filter((d) => d.recent.explainedMass < config.explainedMass);
}

export function engineStateResponse(state: EngineState, parser: { available: boolean }): z.infer<typeof EngineStateResponseSchema> {
  return {
    families: [...state.families.values()].map((f) => {
      const bits = f.decisions.at(-1)?.recent.surprise.bits;
      return {
        decisionFamily: f.model.family.id,
        observations: f.knowledge.observations.length,
        top: topCandidates(f),
        lastSurpriseBits: bits !== undefined && Number.isFinite(bits) ? bits : null,
      };
    }),
    undefinedConcepts: state.undefinedConcepts.map((c) => ({ name: c.name, label: c.label })),
    confirmedRules: state.rulebook.rules.length,
    rulebookRevision: state.rulebook.revision,
    mastery: [...state.mastery].map(([ruleId, level]) => ({ ruleId, level })),
    answerParser: { available: parser.available, unparsedAnswers: unparsedAnswers(state).length },
  };
}
