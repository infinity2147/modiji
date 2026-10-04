/**
 * P4 acceptance support (plan §11: "≥1 unresolved concept surfaced") and plan §6.6 end to end at the
 * server, offline: the expert works the three KYC training cases through the CaseDesk handlers while
 * sharing their screen (frames between opening each case and deciding); a why-probe answer makes the
 * concept proposer (fake Sonnet) surface "documentsComplete"; the expert confirms it; the schema version
 * bumps; past cases are backfilled by a vision re-read of their stored frames (fake Haiku) and a case
 * decided afterwards gets the same re-read; one case cannot be read → Unknown{backfill_failed}; the
 * hypotheses are re-enumerated over the new feature, the solver reruns on the new domain and coverage
 * reports the new version with no undefined concept left.
 */
import { describe, expect, it } from "vitest";
import {
  FeatureIdSchema,
  RULE_EVENT_KINDS,
  engineConfig,
  featuresReferenced,
  parseLedgerPayload,
  rulebookFromLedger,
  type LlmAnswer,
} from "@vashistha/core";
import { CLAUDE_MODELS } from "@vashistha/core/server";
import { compileProcedure, exportWorkMapJson } from "@vashistha/mcp-guardrails";
import { ConceptsStateSchema } from "../../lib/contracts/concepts";
import { EngineStateResponseSchema, GateAuthorizeResponseSchema, QuestionQueueResponseSchema } from "../../lib/contracts/interview";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { createDebriefStore, type DebriefDeps } from "../../lib/server/debrief/deps";
import { searchWitnesses } from "@vashistha/solver";
import { coverageOf, snapshot } from "../../lib/server/debrief/state";
import { engineState } from "../../lib/server/interview/engine-state";
import { interviewHooks } from "../../lib/server/interview/orchestrator";
import { handleConceptAction, handleGetConcepts } from "../../lib/server/schema/handlers";
import { schemaIdle, withSchemaBackfill } from "../../lib/server/schema/service";
import { domEvent, jsonRequest } from "../support/casedesk-harness";
import { createInterviewHarness, gateRequest, trainingCases, utterance, type InterviewHarness } from "../support/interview-harness";
import { readTurn } from "../support/llm-harness";
import { fakeClaude, quiet, rereadClient, schemaDeps, type RereadCall } from "../support/schema-harness";

const DOCS = FeatureIdSchema.parse("documentsComplete");
const QUOTE = "the proof of address is missing, so the file isn't complete";
const [ONE, TWO, THREE] = trainingCases();

function answer(): LlmAnswer {
  return { survivingCandidateIds: [], eliminatedCandidateIds: [], statedRules: [], newConcepts: [], answeredAction: null, confidence: 0.9 };
}

/** Opens the case, shares one redacted frame of it, sets the risk rating, checks and commits — then waits for the engine and the backfill. */
async function work(h: InterviewHarness, s: string, caseId: string, action: string, riskRating: "low" | "medium" | "high"): Promise<void> {
  const sessionEpoch = h.epoch(s);
  const post = async (events: Record<string, unknown>[]) =>
    expect((await handlePostEvents(jsonRequest(`/api/sessions/${s}/events`, { events }), s, h.casedesk)).status).toBe(200);
  const seq = h.ledger.list(s, { kinds: ["screen.event"] }).length + 1;
  await post([domEvent({ frameSeq: seq, kind: "open_case", caseId, sessionEpoch })]);
  h.frame(s);
  await post([domEvent({ frameSeq: seq + 1, kind: "field_change", caseId, field: "riskRating", from: "unrated", to: riskRating, sessionEpoch })]);
  const edits = { riskRating };
  const check = await handleInterlockCheck(jsonRequest("/api/interlock/check", { sessionId: s, caseId, edits, proposedAction: action }), h.casedesk);
  const { checkId } = (await check.json()) as { checkId: string };
  const decided = await handleCommitDecision(jsonRequest(`/api/sessions/${s}/decisions`, { caseId, edits, action, checkId }), s, h.casedesk);
  expect(decided.status).toBe(200);
  await h.idle(s);
}

describe("P4 acceptance: an unresolved concept is surfaced, confirmed, and absorbed (plan §6.6)", () => {
  it("three training cases → concept proposed → expert confirms → v2 → backfill (2 read, 1 failed) → hypotheses + solver rerun → coverage", async () => {
    const h = createInterviewHarness();
    h.setModel({
      answer: () => answer(),
      concepts: () => ({
        concepts: [
          { name: "documentsComplete", label: "documents complete", definition: "Every required document is on file.", type: "boolean", values: [], evidenceQuote: QUOTE },
        ],
      }),
    });
    const rereads: RereadCall[] = [];
    const sdeps = schemaDeps({
      ledger: h.ledger,
      casedesk: h.deps.casedesk,
      interview: h.deps.store,
      claude: fakeClaude(
        rereadClient(
          {
            [ONE.id]: { visible: true, value: false, evidence: "Documents: proof of address — missing" },
            [TWO.id]: { visible: true, value: true, evidence: "Documents: all received" },
            [THREE.id]: "error",
          },
          rereads,
        ),
      ),
    });
    h.casedesk.interview = withSchemaBackfill(interviewHooks(h.deps), sdeps);
    const s = await h.session("expert");

    // Case 1, then the why-probe is asked through the gate and answered in the expert's words.
    await work(h, s, ONE.id, "enhancedReview", "medium");
    const { queue, contextVersion } = QuestionQueueResponseSchema.parse((await h.questions(s)).body);
    const why = queue.find((q) => q.kind === "why_probe");
    if (why === undefined) throw new Error("no why-probe queued after case 1");
    const granted = GateAuthorizeResponseSchema.parse((await h.authorize(s, gateRequest(why.id, contextVersion))).body);
    expect(await readTurn(await h.llmTurn(s, granted.controlMessage))).toMatchObject({ kind: "speech", text: why.text });
    expect((await h.answerWith(s, utterance(h, s, `Mostly because ${QUOTE}.`, { questionId: why.id }))).status).toBe(200);
    await work(h, s, TWO.id, "approve", "high");

    // ≥1 unresolved concept surfaced, with the expert's quote, on the engine state and the concepts list.
    const engineBefore = EngineStateResponseSchema.parse((await h.engine(s)).body);
    expect(engineBefore.undefinedConcepts).toEqual([{ name: "documentsComplete", label: "documents complete" }]);
    const listed = ConceptsStateSchema.parse(await (await handleGetConcepts(s, sdeps)).json());
    expect(listed.undefinedConcepts.map((c) => [c.name, c.quote, c.origin])).toEqual([["documentsComplete", QUOTE, "interview"]]);
    expect(listed.schemaVersion).toBe(1);

    // The expert confirms it with their own definition and words.
    const confirm = await handleConceptAction(
      jsonRequest(`/api/sessions/${s}/concepts`, {
        action: "confirm",
        name: "documentsComplete",
        definition: { type: "boolean", label: "Documents complete", description: "Every document the checklist requires is received and in date." },
        statement: { text: "Yes. Documents complete means nothing on the checklist is missing or expired." },
      }),
      s,
      sdeps,
    );
    expect(confirm.status).toBe(200);
    await schemaIdle(sdeps.store, s);

    // Case 3 is decided after the confirmation: its value is re-read too (and fails here).
    await work(h, s, THREE.id, "requestDocuments", "medium");
    await schemaIdle(sdeps.store, s);

    const backfills = h.ledger.list(s, { kinds: ["feature.backfilled"] }).map((e) => parseLedgerPayload(e, "feature.backfilled"));
    expect(backfills.map((b) => [b.caseId, b.value, b.failure ?? null, b.timing, b.frameIds.length])).toEqual([
      [ONE.id, false, null, "after_confirmation", 1],
      [TWO.id, true, null, "after_confirmation", 1],
      [THREE.id, { unknown: true, reason: "backfill_failed" }, "model_error", "new_case", 1],
    ]);
    expect(rereads.map((r) => r.caseId)).toEqual([ONE.id, TWO.id, THREE.id]);

    // Hypotheses rerun under v2: observations carry the concept (three-valued), the enumerator uses it.
    const state = engineState(h.deps, s);
    const family = state.families.get("reviewOutcome");
    expect(state.schema.model.schemaVersion).toBe(2);
    expect(family?.set.schemaVersion).toBe(2);
    expect(family?.decisions.map((d) => d.features[DOCS])).toEqual([false, true, { unknown: true, reason: "backfill_failed" }]);
    expect(family?.set.candidates.some((c) => featuresReferenced(c.predicate).includes(DOCS))).toBe(true);
    expect(EngineStateResponseSchema.parse((await h.engine(s)).body).undefinedConcepts).toEqual([]);

    // Solver reruns on the v2 domain; coverage reflects the bump and no undefined concept is left.
    const debrief: DebriefDeps = {
      ledger: h.ledger,
      casedesk: h.deps.casedesk,
      interview: h.deps.store,
      engineConfig: engineConfig(),
      authorizations: h.authorizations,
      rulebook: () => rulebookFromLedger(h.ledger.list(s, { kinds: Object.values(RULE_EVENT_KINDS) })),
      solver: searchWitnesses,
      claude: null,
      models: { prose: CLAUDE_MODELS.prose },
      exports: { workMapJson: exportWorkMapJson, procedure: compileProcedure },
      store: createDebriefStore(),
      dataDir: "/nonexistent",
      mcpBearerRequired: false,
      now: Date.now,
      log: quiet,
    };
    const snap = await snapshot(debrief, s);
    expect(snap.current.length).toBeGreaterThan(0);
    expect(snap.current.every((w) => w.schemaVersion === 2 && typeof w.assignment[DOCS] === "boolean")).toBe(true);
    expect(coverageOf(snap)).toMatchObject({ schemaVersion: 2, undefinedConcepts: 0, decisionsExplained: { total: 3 } });

    // Provenance: proposal ← why-answer utterance; confirmation ← proposal; bump ← confirmation; backfill ← bump, decision, frame.
    const [proposed] = h.ledger.list(s, { kinds: ["concept.proposed"] });
    const [confirmed] = h.ledger.list(s, { kinds: ["concept.confirmed"] });
    const [bump] = h.ledger.list(s, { kinds: ["schema.version_bumped"] });
    expect(confirmed?.parentIds).toEqual([proposed?.id]);
    expect(bump?.parentIds).toEqual([confirmed?.id]);
    for (const e of h.ledger.list(s, { kinds: ["feature.backfilled"] })) {
      expect(e.parentIds[0]).toBe(bump?.id);
      expect(h.ledger.get(e.parentIds[1] ?? "")?.kind).toBe("case.decision");
      expect(h.ledger.get(e.parentIds[2] ?? "")?.kind).toBe("frame.received");
    }

    // A restarted process derives exactly the same model and hypotheses from the ledger.
    const weights = family?.set.candidates.map((c) => [c.id, c.weight]);
    h.restart();
    const rebuilt = engineState(h.deps, s);
    expect(rebuilt.schema.model.schemaVersion).toBe(2);
    expect(rebuilt.families.get("reviewOutcome")?.set.candidates.map((c) => [c.id, c.weight])).toEqual(weights);
  });
});
