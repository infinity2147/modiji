/**
 * Schema versioning at the server (plan §6.6): confirm / dismiss with the expert's words and ledger
 * parents, version bump, backfill by vision re-read from the cases' stored frames (fake Haiku), the
 * engine and the solver recomputing under the new feature model, three-valued handling of
 * `Unknown{backfill_failed}`, and the base-model rulebook view used by the interlock/tutor/MCP.
 */
import { describe, expect, it } from "vitest";
import {
  ConfirmedRuleSchema,
  FeatureIdSchema,
  PredicateSchema,
  RuleConfirmedPayloadSchema,
  checkAction,
  evaluatePredicate,
  featuresReferenced,
  parseLedgerPayload,
  recordLookup,
  rulebookFromLedger,
  type ActionId,
  type LedgerEntry,
} from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, kycCases } from "@vashistha/core/domains/kyc";
import { ConceptActionResponseSchema, ConceptsStateSchema } from "../../lib/contracts/concepts";
import { engineState } from "../../lib/server/interview/engine-state";
import { coverageOf, snapshot } from "../../lib/server/debrief/state";
import { sessionWorkMap } from "../../lib/server/debrief/workmap";
import { handleConceptAction, handleGetConcepts } from "../../lib/server/schema/handlers";
import { rulebookWithinModel } from "../../lib/server/schema/rulebook";
import { schemaIdle } from "../../lib/server/schema/service";
import type { SchemaDeps } from "../../lib/server/schema/deps";
import { jsonRequest } from "../support/casedesk-harness";
import { T0, getState, reply, world, type World } from "../support/debrief-harness";
import { fakeClaude, rereadClient, schemaDeps, type RereadCall, type RereadScript } from "../support/schema-harness";

const DOCS = FeatureIdSchema.parse("documentsComplete");
const QUOTE = "the proof of address is missing, so the file is not complete";
const [C1, C2, C3] = kycCases("training").map((c) => c.id);

/** The debrief world plus one interview-proposed concept (`documentsComplete`) quoting the expert. */
async function proposedWorld(script: RereadScript | null): Promise<{ w: World; deps: SchemaDeps; calls: RereadCall[]; proposal: LedgerEntry }> {
  const w = await world();
  const utterance = w.ledger.append({
    sessionId: w.sessionId,
    source: "voice",
    kind: "utterance.transcript",
    occurredAt: T0,
    traceId: "t",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload: { conversationId: "conv-1", text: `Well, ${QUOTE}.`, t0Ms: 5_000, t1Ms: 8_000, frameIds: [] },
  });
  const proposal = w.ledger.append({
    sessionId: w.sessionId,
    source: "engine",
    kind: "concept.proposed",
    occurredAt: T0,
    traceId: "t",
    parentIds: [utterance.id],
    schemaVersion: 1,
    privacyEpoch: 0,
    payload: { name: "documentsComplete", label: "documents complete", definition: "Every required document is on file.", type: "boolean", exactQuote: QUOTE },
  });
  const calls: RereadCall[] = [];
  const deps = schemaDeps({
    ledger: w.ledger,
    casedesk: w.deps.casedesk,
    interview: w.deps.interview,
    claude: script === null ? null : fakeClaude(rereadClient(script, calls)),
    now: () => T0,
  });
  return { w, deps, calls, proposal };
}

async function concepts(deps: SchemaDeps, sessionId: string) {
  const r = await reply(await handleGetConcepts(sessionId, deps));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ConceptsStateSchema.parse(r.body);
}

async function post(deps: SchemaDeps, sessionId: string, body: unknown) {
  return reply(await handleConceptAction(jsonRequest(`/api/sessions/${sessionId}/concepts`, body), sessionId, deps));
}

const CONFIRM = {
  action: "confirm",
  name: "documentsComplete",
  definition: { type: "boolean", label: "Documents complete" },
  statement: { text: "Yes — documents complete means every required document is on file." },
};

const SCRIPT: RereadScript = {
  [C1 ?? ""]: { visible: true, value: false, evidence: "Documents panel: proof of address missing" },
  [C2 ?? ""]: { visible: true, value: true, evidence: "Documents panel: all received" },
  // C3: the panel is scrolled away on every stored frame → not visible.
};

function kinds(w: World, ...ks: string[]): LedgerEntry[] {
  return w.ledger.list(w.sessionId, { kinds: ks });
}

describe("POST /concepts confirm", () => {
  it("writes concept.confirmed (expert, parents: the proposal) and schema.version_bumped; backfills every decision from its frames", async () => {
    const { w, deps, calls, proposal } = await proposedWorld(SCRIPT);
    const before = await concepts(deps, w.sessionId);
    expect(before.schemaVersion).toBe(1);
    expect(before.undefinedConcepts.map((c) => [c.name, c.quote, c.origin])).toEqual([["documentsComplete", QUOTE, "interview"]]);

    const r = await post(deps, w.sessionId, CONFIRM);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = ConceptActionResponseSchema.parse(r.body);
    expect(res).toMatchObject({ schemaVersion: 2, backfillQueued: 3 });

    const [confirmed] = kinds(w, "concept.confirmed");
    const [bump] = kinds(w, "schema.version_bumped");
    if (confirmed === undefined || bump === undefined) throw new Error("missing entries");
    expect(confirmed.source).toBe("expert");
    expect(confirmed.parentIds).toEqual([proposal.id]);
    expect(parseLedgerPayload(confirmed, "concept.confirmed")).toEqual({
      feature: "documentsComplete",
      schemaVersion: 2,
      definition: { name: "documentsComplete", type: "boolean", label: "Documents complete" },
      statement: { text: CONFIRM.statement.text, provenance: "human_text" },
    });
    expect(bump.source).toBe("engine");
    expect(bump.parentIds).toEqual([confirmed.id]);
    expect(parseLedgerPayload(bump, "schema.version_bumped")).toEqual({ from: 1, to: 2, feature: "documentsComplete", label: "Documents complete" });

    await schemaIdle(deps.store, w.sessionId);
    const decisions = kinds(w, "case.decision");
    const backfills = kinds(w, "feature.backfilled");
    expect(backfills).toHaveLength(3);
    expect(calls.map((c) => c.caseId)).toEqual([C1, C2, C3]);
    for (const c of calls) {
      expect(c.images).toBe(1);
      expect(c.text).toContain("`documentsComplete` — \"Documents complete\"");
    }
    const byCase = new Map(backfills.map((e) => [parseLedgerPayload(e, "feature.backfilled").caseId, e]));
    for (const [i, d] of decisions.entries()) {
      const e = byCase.get(parseLedgerPayload(d, "case.decision").caseId);
      if (e === undefined) throw new Error("no backfill");
      const p = parseLedgerPayload(e, "feature.backfilled");
      const frame = w.ledger.list(w.sessionId, { kinds: ["frame.received"] })[i];
      // Provenance: the bump, the decision and exactly the frames re-read.
      expect(e.parentIds).toEqual([bump.id, d.id, frame?.id]);
      expect(p.frameIds).toEqual([frame?.id]);
      expect(p.timing).toBe("after_confirmation");
    }
    expect(parseLedgerPayload(byCase.get(C1 ?? "") as LedgerEntry, "feature.backfilled")).toMatchObject({ value: false, evidence: "Documents panel: proof of address missing" });
    expect(parseLedgerPayload(byCase.get(C2 ?? "") as LedgerEntry, "feature.backfilled")).toMatchObject({ value: true });
    expect(parseLedgerPayload(byCase.get(C3 ?? "") as LedgerEntry, "feature.backfilled")).toMatchObject({
      value: { unknown: true, reason: "backfill_failed" },
      failure: "not_visible",
    });

    // The rerun is recorded: hypotheses.updated per decided family, citing the backfills.
    const rerun = kinds(w, "hypotheses.updated");
    expect(rerun.length).toBeGreaterThan(0);
    for (const e of rerun) expect(e.parentIds).toEqual(backfills.map((b) => b.id));

    const after = await concepts(deps, w.sessionId);
    expect(after).toMatchObject({ schemaVersion: 2, recomputing: false, latest: { name: "documentsComplete", label: "Documents complete", schemaVersion: 2 }, undefinedConcepts: [] });
    expect(after.confirmed[0]?.backfill.map((b) => [b.caseId, b.value, b.failure])).toEqual([
      [C1, false, null],
      [C2, true, null],
      [C3, null, "not_visible"],
    ]);
  });

  it("recomputes: engine re-enumerates over the new feature; solver reruns on the new domain; coverage reports v2; v1 rules stay", async () => {
    const { w, deps } = await proposedWorld(SCRIPT);
    const coverageBefore = coverageOf(await snapshot(w.deps, w.sessionId));
    expect(coverageBefore).toMatchObject({ schemaVersion: 1, undefinedConcepts: 1, closed: false });

    expect((await post(deps, w.sessionId, CONFIRM)).status).toBe(200);
    // Before the backfill lands: the model is v2 and coverage is not claimable (recomputing).
    const recomputing = await snapshot(w.deps, w.sessionId);
    expect(recomputing.schemaVersion).toBe(2);
    expect(coverageOf(recomputing).closed).toBe(false);
    await schemaIdle(deps.store, w.sessionId);

    const snap = await snapshot(w.deps, w.sessionId);
    expect(snap.domain.features.at(-1)).toEqual({ id: "documentsComplete", label: "Documents complete", source: "derived", type: "boolean" });
    // Engine: observations carry the backfilled values (C3 unknown), and the enumerator reads the new feature.
    const family = engineState({ ledger: w.ledger, store: w.deps.interview, config: w.deps.engineConfig }, w.sessionId).families.get("reviewOutcome");
    expect(family?.set.schemaVersion).toBe(2);
    expect(family?.decisions.map((d) => d.features[DOCS])).toEqual([false, true, { unknown: true, reason: "backfill_failed" }]);
    expect(family?.set.candidates.some((c) => featuresReferenced(c.predicate).includes(DOCS))).toBe(true);
    // Debrief decisions carry the concept too.
    expect(snap.decisions.map((d) => d.features[DOCS])).toEqual([false, true, { unknown: true, reason: "backfill_failed" }]);
    // Solver: reran on the v2 domain — every witness is v2 and assigns the new feature.
    expect(snap.current.length).toBeGreaterThan(0);
    for (const wit of snap.current) {
      expect(wit.schemaVersion).toBe(2);
      expect(typeof wit.assignment[DOCS]).toBe("boolean");
    }
    // Rules confirmed under v1 stay in force and keep their version.
    expect(snap.book.rules.map((r) => [r.id, r.schemaVersion])).toEqual([
      ["rule-docs", 1],
      ["rule-pep", 1],
    ]);
    const coverage = coverageOf(snap);
    expect(coverage).toMatchObject({ schemaVersion: 2, undefinedConcepts: 0 });
    const state = await getState(w);
    expect(state.coverage.schemaVersion).toBe(2);
    expect(state.gaps.some((g) => g.source === "undefined_concept")).toBe(false);
    // The Work Map is built under the session's model too.
    expect((await sessionWorkMap(w.deps, w.sessionId)).workMap.schemaVersion).toBe(2);
  });

  it("without a model every value is Unknown{backfill_failed} (no_model) and nothing is read", async () => {
    const { w, deps } = await proposedWorld(null);
    expect((await post(deps, w.sessionId, CONFIRM)).status).toBe(200);
    await schemaIdle(deps.store, w.sessionId);
    const backfills = kinds(w, "feature.backfilled").map((e) => parseLedgerPayload(e, "feature.backfilled"));
    expect(backfills.map((b) => [b.value, b.failure, b.frameIds])).toEqual(Array.from({ length: 3 }, () => [{ unknown: true, reason: "backfill_failed" }, "no_model", []]));
    expect((await concepts(deps, w.sessionId)).rereadAvailable).toBe(false);
  });

  it("a model outage or an out-of-type reading is Unknown{backfill_failed}, never coerced", async () => {
    const { w, deps } = await proposedWorld({
      [C1 ?? ""]: "error",
      [C2 ?? ""]: { visible: true, value: "maybe", evidence: "?" } as unknown as RereadScript[string],
    });
    expect((await post(deps, w.sessionId, CONFIRM)).status).toBe(200);
    await schemaIdle(deps.store, w.sessionId);
    const failures = kinds(w, "feature.backfilled").map((e) => parseLedgerPayload(e, "feature.backfilled").failure);
    // C2's structured output does not match the boolean schema: the wrapper rejects it (model_error).
    expect(failures).toEqual(["model_error", "model_error", "not_visible"]);
  });

  it("refuses: unknown concept (409), invalid definitions (400), a non-verbatim spoken quote (400); validates numeric bounds", async () => {
    const { w, deps } = await proposedWorld(SCRIPT);
    expect((await post(deps, w.sessionId, { ...CONFIRM, name: "neverProposed" })).status).toBe(409);
    expect((await post(deps, w.sessionId, { ...CONFIRM, definition: { type: "enum", label: "x", values: ["one"] } })).status).toBe(400);
    expect((await post(deps, w.sessionId, { ...CONFIRM, definition: { type: "number", label: "x", min: 5, max: 1, integer: true } })).status).toBe(422);
    const [utterance] = kinds(w, "utterance.transcript").filter((u) => parseLedgerPayload(u, "utterance.transcript").text.includes(QUOTE));
    const spoken = await post(deps, w.sessionId, { ...CONFIRM, statement: { text: "something the expert never said", utteranceId: utterance?.id } });
    expect(spoken.status).toBe(400);
    expect(kinds(w, "concept.confirmed")).toHaveLength(0);
  });

  it("a spoken confirmation is a voice entry citing the utterance; a second confirm of the same concept is 409", async () => {
    const { w, deps, proposal } = await proposedWorld(SCRIPT);
    const [utterance] = kinds(w, "utterance.transcript").filter((u) => parseLedgerPayload(u, "utterance.transcript").text.includes(QUOTE));
    const r = await post(deps, w.sessionId, { ...CONFIRM, statement: { text: QUOTE, utteranceId: utterance?.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [confirmed] = kinds(w, "concept.confirmed");
    expect(confirmed?.source).toBe("voice");
    expect(confirmed?.parentIds).toEqual([proposal.id, utterance?.id]);
    expect(parseLedgerPayload(confirmed as LedgerEntry, "concept.confirmed").statement).toEqual({ text: QUOTE, provenance: "human_voice", utteranceId: utterance?.id });
    expect((await post(deps, w.sessionId, CONFIRM)).status).toBe(409);
    await schemaIdle(deps.store, w.sessionId);
  });
});

describe("POST /concepts dismiss", () => {
  it("'already covered by <feature>' settles the concept without a version bump", async () => {
    const { w, deps, proposal } = await proposedWorld(SCRIPT);
    const r = await post(deps, w.sessionId, {
      action: "dismiss",
      name: "documentsComplete",
      reason: "already_covered",
      coveredBy: "sourceOfFunds",
      statement: { text: "That's just the source-of-funds check." },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [dismissed] = kinds(w, "concept.dismissed");
    expect(dismissed?.parentIds).toEqual([proposal.id]);
    expect(kinds(w, "schema.version_bumped")).toHaveLength(0);
    const state = await concepts(deps, w.sessionId);
    expect(state).toMatchObject({ schemaVersion: 1, undefinedConcepts: [], dismissed: [{ name: "documentsComplete", reason: "already_covered", coveredBy: "sourceOfFunds" }] });
    expect(coverageOf(await snapshot(w.deps, w.sessionId)).undefinedConcepts).toBe(0);
  });

  it("refuses coveredBy without already_covered, and an unknown covering feature", async () => {
    const { w, deps } = await proposedWorld(SCRIPT);
    const base = { action: "dismiss", name: "documentsComplete", statement: { text: "no" } };
    expect((await post(deps, w.sessionId, { ...base, reason: "not_a_concept", coveredBy: "pep" })).status).toBe(400);
    expect((await post(deps, w.sessionId, { ...base, reason: "already_covered", coveredBy: "nope" })).status).toBe(400);
    expect((await post(deps, w.sessionId, { ...base, reason: "not_a_concept" })).status).toBe(200);
  });
});

describe("three-valued handling of a backfilled concept", () => {
  const RULE_PREDICATE = PredicateSchema.parse({ "==": [{ var: "documentsComplete" }, false] });

  it("a guardrail over the concept is insufficient_information where the backfill failed, decides where it was read", async () => {
    const { w, deps } = await proposedWorld(SCRIPT);
    expect((await post(deps, w.sessionId, CONFIRM)).status).toBe(200);
    await schemaIdle(deps.store, w.sessionId);
    const snap = await snapshot(w.deps, w.sessionId);
    const rule = ConfirmedRuleSchema.parse({
      id: "rule-docs-incomplete",
      decisionFamily: "reviewOutcome",
      kind: "guardrail",
      predicate: RULE_PREDICATE,
      effect: { type: "forbid", action: "approve" },
      priority: 40,
      overrides: [],
      evidence: [{ kind: "expert_quote", utteranceId: "u", exactQuote: QUOTE, t0Ms: 0, t1Ms: 1, frameIds: ["f"], eventIds: [], relation: "supports", provenance: "human_voice" }],
      confirmedBy: [{ expertId: "e", at: T0, method: "debrief", ledgerEntryId: "u" }],
      revision: 1,
      schemaVersion: 2,
      expertId: "e",
    });
    const decide = (i: number) => checkAction({ rules: [rule], features: recordLookup(snap.decisions[i]?.features ?? {}), action: "approve" as ActionId, domain: snap.domain }).decision;
    expect(decide(0)).toBe("forbid");
    expect(decide(1)).toBe("allow");
    expect(decide(2)).toBe("insufficient_information");
    expect(evaluatePredicate(RULE_PREDICATE, recordLookup(snap.decisions[2]?.features ?? {})).unknownFeatures).toEqual(["documentsComplete"]);
  });

  it("the base-model rulebook view (interlock, tutor, MCP) leaves out rules over session concepts instead of failing", () => {
    const docs = ConfirmedRuleSchema.parse({
      id: "rule-concept",
      decisionFamily: "reviewOutcome",
      kind: "decision",
      predicate: RULE_PREDICATE,
      effect: { type: "recommend", action: "requestDocuments" },
      priority: 10,
      overrides: [],
      evidence: [{ kind: "expert_quote", utteranceId: "u", exactQuote: QUOTE, t0Ms: 0, t1Ms: 1, frameIds: ["f"], eventIds: [], relation: "supports", provenance: "human_voice" }],
      confirmedBy: [{ expertId: "e", at: T0, method: "debrief", ledgerEntryId: "u" }],
      revision: 1,
      schemaVersion: 2,
      expertId: "e",
    });
    const book = rulebookFromLedger([{ id: "r1", source: "engine", kind: "rule.confirmed", payload: RuleConfirmedPayloadSchema.parse({ rule: docs }) }]);
    const view = rulebookWithinModel(KYC_DOMAIN, book);
    expect(view.rules).toEqual([]);
    const c1 = kycCases("training")[0];
    if (c1 === undefined) throw new Error("no case");
    expect(() => checkAction({ rules: view.rules, features: recordLookup(caseFeatures(c1)), action: "approve" as ActionId, domain: KYC_DOMAIN })).not.toThrow();
  });
});
