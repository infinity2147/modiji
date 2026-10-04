/**
 * HTTP handlers of the tutor (contract: lib/contracts/tutor.ts) and its CaseDesk hooks. Route files
 * only adapt Next's signature and pass `tutorDeps()`. Off-record semantics apply to novices too:
 * every tutor write is refused while the session is off the record.
 */
import "server-only";
import { parseLedgerPayload, type LedgerEntry } from "@vashistha/core";
import { ReviewEditsSchema as ReviewEditsContract } from "../../contracts/casedesk";
import {
  BriefingRequestSchema,
  type BriefingResponseSchema,
  CoachChatRequestSchema,
  type CoachChatResponseSchema,
  JudgeCaseRequestSchema,
  MASTERY_LABEL,
  PredictionRequestSchema,
  TutorIntentRequestSchema,
  type CaseTutorView,
  type JudgeCaseResponseSchema,
  type PracticeResponseSchema,
  type PredictionResponseSchema,
  type PredictionView,
  type TutorIntentResponseSchema,
  type TutorState,
} from "../../contracts/tutor";
import type { z } from "zod";
import { sessionCases } from "../casedesk/cases";
import { ApiFailure, json, readJson, respond } from "../casedesk/http";
import { checkEdits, requireReviewOutcome } from "../casedesk/interlock";
import { requireOnRecord, type LoadedSession, type TutorHooks } from "../casedesk/session";
import { entry } from "../interview/ledger";
import type { TutorDeps } from "./deps";
import { commitOutcomes, predictionOutcomes, recordOutcomes } from "./mastery";
import { queueBriefing, spokenName } from "./briefing";
import { chatWithCoach, coachTurnViews } from "./conversation";
import { dropStaleInterventions, interventionView, monitorSelection } from "./monitor";
import { coachCaseOpened, coachCommitted, coachPrediction, coachSafely, coachSelection, withdrawStaleNudges } from "./nudges";
import { addJudgeCase, generatePractice } from "./practice";
import { casePrompt, expectedOutcome } from "./predict";
import { isStopRule, quoteView, taughtRules, thenText, whenText } from "./rules";
import { editsRecord, entryContext, loadNoviceSession, requireSessionCase, ruleEntryIds } from "./session";
import { isBoundaryCase, tutorRecord, type Recorded, type TutorRecord } from "./state";

function predictionView(p: Recorded<"tutor.prediction">): PredictionView {
  const { caseId: _caseId, ...rest } = p.payload;
  return { entryId: p.entry.id, ...rest };
}

/** Everything the novice UI shows: the taught rules on the ladder, and per case the prompt, prediction and interventions. */
export function tutorState(deps: TutorDeps, loaded: LoadedSession): TutorState {
  const { session, info } = loaded;
  const book = deps.rulebook();
  const record = tutorRecord(deps.ledger, session.id);
  const cases = sessionCases(deps.ledger, session.id, info).map((kycCase): CaseTutorView => {
    const prediction = record.predictions.get(kycCase.id);
    const origin = record.generated.get(kycCase.id)?.payload.origin.kind;
    return {
      caseId: kycCase.id,
      origin: origin ?? "case_set",
      prompt: casePrompt(record, book.rules, kycCase),
      prediction: prediction === undefined ? null : predictionView(prediction),
      interventions: record.interventions.filter((i) => i.payload.caseId === kycCase.id).map((i) => interventionView(record, i)),
    };
  });
  return {
    sessionId: session.id,
    rulebookRevision: book.revision,
    masteryLabel: MASTERY_LABEL,
    rules: taughtRules(book.rules).map((rule) => ({
      ruleId: rule.id,
      kind: rule.kind,
      when: whenText(rule),
      then: thenText(rule),
      stopRule: isStopRule(rule),
      quote: quoteView(deps.ledger, rule),
      level: record.mastery.get(rule.id) ?? "untested",
    })),
    cases,
    coach: coachTurnViews(deps.ledger, session.id),
  };
}

/** GET /api/sessions/:sessionId/tutor */
export function handleTutorState(sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, () => json(tutorState(deps, loadNoviceSession(deps, sessionId))));
}

/** POST /api/sessions/:sessionId/tutor/intent — the DOM-channel signal of a selected, unsaved outcome. */
export function handleIntent(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, TutorIntentRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    requireReviewOutcome(body.proposedAction);
    checkEdits(body.edits);
    const kycCase = requireSessionCase(deps, loaded, body.caseId);
    if (tutorRecord(deps.ledger, loaded.session.id).decisions.has(kycCase.id))
      throw new ApiFailure(409, "already_decided", `case ${kycCase.id} already has a decision in this session`);
    // The ledger re-checks off-record and the privacy epoch atomically (409 on a race).
    const intent = deps.ledger.append(
      entry(entryContext(deps, loaded), "tutor.intent", "dom", [loaded.info.startedEntryId], {
        caseId: kycCase.id,
        proposedAction: body.proposedAction,
        edits: editsRecord(body.edits),
      }),
    );
    coachSafely(deps, `intent ${intent.id}`, () => withdrawStaleNudges(deps, loaded, { caseId: kycCase.id, action: body.proposedAction, intent }));
    const outcome = monitorSelection(deps, loaded, { kycCase, action: body.proposedAction, edits: body.edits, trigger: intent });
    // The coach's nudge never repeats a stop-rule warning: a selection with an intervention gets none.
    coachSafely(deps, `intent ${intent.id}`, () =>
      coachSelection(deps, loaded, { kycCase, action: body.proposedAction, edits: body.edits, intent, intervened: outcome.intervention !== null }),
    );
    const response: z.infer<typeof TutorIntentResponseSchema> = outcome;
    return json(response);
  });
}

/** POST /api/sessions/:sessionId/tutor/prediction — scored against the confirmed rulebook, then revealed. */
export function handlePrediction(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const body = await readJson(request, PredictionRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    requireReviewOutcome(body.predicted);
    checkEdits(body.edits);
    const kycCase = requireSessionCase(deps, loaded, body.caseId);
    const record = tutorRecord(deps.ledger, loaded.session.id);
    if (record.decisions.has(kycCase.id)) throw new ApiFailure(409, "already_decided", `case ${kycCase.id} is already decided`);
    if (record.predictions.has(kycCase.id)) throw new ApiFailure(409, "already_predicted", `a prediction for ${kycCase.id} is already recorded`);
    const book = deps.rulebook();
    const expected = expectedOutcome(book.rules, kycCase, body.edits);
    if (expected.kind === "none") throw new ApiFailure(409, "nothing_to_predict", expected.reason);

    const ctx = entryContext(deps, loaded);
    const ruleEntries = ruleEntryIds(book);
    const correct = body.predicted === expected.action;
    const written = deps.ledger.append(
      entry(ctx, "tutor.prediction", "client", [loaded.info.startedEntryId, ...expected.ruleIds.flatMap((id) => ruleEntries.get(id) ?? [])], {
        caseId: kycCase.id,
        ruleIds: expected.ruleIds,
        predicted: body.predicted,
        expected: expected.action,
        correct,
      }),
    );
    recordOutcomes(deps, ctx, {
      levels: new Map(record.mastery),
      outcomes: predictionOutcomes(expected.ruleIds, correct, isBoundaryCase(record, kycCase.id)),
      trigger: written.id,
      ruleEntries,
    });
    coachSafely(deps, `prediction ${written.id}`, () => coachPrediction(deps, loaded, written));
    const prediction = tutorRecord(deps.ledger, loaded.session.id).predictions.get(kycCase.id);
    if (prediction === undefined) throw new Error(`prediction ${written.id} did not fold`);
    const response: z.infer<typeof PredictionResponseSchema> = { prediction: predictionView(prediction), state: tutorState(deps, loaded) };
    return json(response);
  });
}

/** POST /api/sessions/:sessionId/tutor/practice */
export function handlePractice(sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    const { cases, note } = await generatePractice(deps, loaded);
    const response: z.infer<typeof PracticeResponseSchema> = { cases, note, state: tutorState(deps, loaded) };
    return json(response, cases.length > 0 ? 201 : 200);
  });
}

/** POST /api/sessions/:sessionId/tutor/cases — a judge's own case. */
export function handleJudgeCase(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { features } = await readJson(request, JudgeCaseRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    const kycCase = addJudgeCase(deps, loaded, features);
    const response: z.infer<typeof JudgeCaseResponseSchema> = { case: kycCase, state: tutorState(deps, loaded) };
    return json(response, 201);
  });
}

// ── CaseDesk hooks ──

function afterCommit(deps: TutorDeps, loaded: LoadedSession, record: TutorRecord, decision: Recorded<"case.decision">): void {
  const kycCase = requireSessionCase(deps, loaded, decision.payload.caseId);
  const edits = ReviewEditsContract.parse(decision.payload.edits);
  const book = deps.rulebook();
  const ctx = entryContext(deps, loaded, decision.entry.traceId);
  dropStaleInterventions(deps, ctx, { record, caseId: kycCase.id, keepAction: undefined, trigger: decision.entry.id });
  const prediction = record.predictions.get(kycCase.id)?.payload;
  const intervened = new Set(record.interventions.filter((i) => i.payload.caseId === kycCase.id).flatMap((i) => i.payload.ruleIds));
  const expected = expectedOutcome(book.rules, kycCase, edits);
  const moved = recordOutcomes(deps, ctx, {
    levels: new Map(record.mastery),
    outcomes: commitOutcomes({
      action: decision.payload.action,
      expected,
      prediction,
      intervened,
      rules: book.rules,
      kycCase,
      edits,
      atBoundary: isBoundaryCase(record, kycCase.id),
    }),
    trigger: decision.entry.id,
    ruleEntries: ruleEntryIds(book),
  });
  coachSafely(deps, `decision ${decision.entry.id}`, () =>
    coachCommitted(deps, loaded, { decision: decision.entry, kycCase, action: decision.payload.action, expected, moved }),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The CaseDesk handlers call these after their own writes succeeded; novice sessions only. A failure
 * here never undoes the CaseDesk write: it is logged (the Save interlock does not depend on the tutor).
 */
export function tutorHooks(deps: TutorDeps): TutorHooks {
  return {
    decisionCommitted(decision, loaded) {
      if (loaded.info.mode !== "novice") return;
      try {
        afterCommit(deps, loaded, tutorRecord(deps.ledger, loaded.session.id), {
          entry: decision,
          payload: parseLedgerPayload(decision, "case.decision"),
        });
      } catch (error) {
        deps.log.error(`[tutor] mastery after decision ${decision.id} failed: ${describeError(error)}`);
      }
    },
    screenEvents(events, loaded) {
      if (loaded.info.mode !== "novice" || loaded.session.offRecord) return;
      for (const event of events) {
        try {
          monitorFieldChange(deps, loaded, event);
          coachSafely(deps, `screen event ${event.id}`, () => coachCaseOpened(deps, loaded, event));
        } catch (error) {
          deps.log.error(`[tutor] monitor after screen event ${event.id} failed: ${describeError(error)}`);
        }
      }
    },
  };
}

/** A field changed on a case with a selected outcome: the monitor re-checks that outcome with the new value. */
function monitorFieldChange(deps: TutorDeps, loaded: LoadedSession, event: LedgerEntry): void {
  if (event.kind !== "screen.event") return;
  const { kind, caseId, field, to } = parseLedgerPayload(event, "screen.event");
  if (kind !== "field_change" || caseId === undefined || field === undefined) return;
  const record = tutorRecord(deps.ledger, loaded.session.id);
  const intent = record.intents.get(caseId);
  if (intent === undefined || record.decisions.has(caseId)) return;
  const edits = ReviewEditsContract.safeParse({ ...intent.payload.edits, [field]: to });
  if (!edits.success) return;
  const kycCase = requireSessionCase(deps, loaded, caseId);
  monitorSelection(deps, loaded, { kycCase, action: intent.payload.proposedAction, edits: edits.data, trigger: event });
}

/** POST /api/sessions/:sessionId/tutor/briefing — queues the coach's spoken welcome, once per session. */
export function handleBriefing(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { caseId } = await readJson(request, BriefingRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    if (caseId !== undefined) requireSessionCase(deps, loaded, caseId);
    const owner = loaded.info.owner;
    const result = queueBriefing(deps, loaded, {
      name: spokenName(owner === undefined ? undefined : deps.displayName?.(owner.userId)),
      rules: tutorState(deps, loaded).rules,
      caseId,
    });
    const body: z.infer<typeof BriefingResponseSchema> = result;
    return json(body);
  });
}

/**
 * POST /api/sessions/:sessionId/tutor/chat — the trainee types to the coach. The reply (grounded in the confirmed
 * rulebook and the current case, queued for speech) is returned as text, so it shows without a voice session.
 */
export function handleCoachChat(request: Request, sessionId: string, deps: TutorDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const { text } = await readJson(request, CoachChatRequestSchema);
    const loaded = loadNoviceSession(deps, sessionId);
    requireOnRecord(loaded.session);
    const body: z.infer<typeof CoachChatResponseSchema> = await chatWithCoach(deps, loaded, text);
    return json(body);
  });
}
