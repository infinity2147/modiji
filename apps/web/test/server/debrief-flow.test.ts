/**
 * P5 end to end on the server: a fixture expert session (3 decisions, 2 confirmed rules) → solver
 * witnesses → ≥3 debrief questions → explicit expert answers with typed quotes → a teach-back (fake
 * Opus behind the real `createClaude` wrapper) → a deliberate correction (revision++, diff, solver
 * rerun) → coverage closed on all four criteria → teach-back confirmed → Work Map + Procedure export
 * round-trips → `/mcp` check_action blocks with the expert's quote. Real ledger (in-memory SQLite),
 * real Z3, real ledger-backed rulebook; only the model is fake.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportWorkMapJson, importWorkMapJson, parseProcedure, procedureRule } from "@vashistha/mcp-guardrails";
import { DebriefStateSchema, LineageResponseSchema, WorkMapResponseSchema } from "../../lib/contracts/debrief";
import { handleExpertAction, handleExport, handleGenerateTeachBack, handleGetWorkMap, handleLineage } from "../../lib/server/debrief/handlers";
import { createMcpEndpoint } from "../../lib/server/debrief/mcp";
import { TEACHBACK_SYSTEM } from "../../lib/server/debrief/teachback";
import { jsonRequest } from "../support/casedesk-harness";
import { DOCS_QUOTE, OPUS_TEACHBACK, PEP_QUOTE, act, getState, openGaps, path, rebuild, reply, world, type World } from "../support/debrief-harness";

describe("debrief flow (P5 acceptance)", () => {
  let w: World;
  let mcp: Server;
  let mcpUrl: string;

  beforeAll(async () => {
    w = await world();
    mcp = createServer((req, res) => {
      void createMcpEndpoint({ env: { NODE_ENV: "test" }, rulebook: () => w.deps.rulebook().rules, rulebookRevision: () => w.deps.rulebook().revision })(req, res);
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mcp.close(() => resolve()));
    w.opened.close();
    await rm(w.dataDir, { recursive: true, force: true });
  });

  it("starts with 3 observed decisions, 2 confirmed rules and an open coverage", async () => {
    const s = await getState(w);
    expect(s.decisions.map((d) => [d.caseId, d.action, d.explained])).toEqual([
      ["NS-2026-0101", "requestDocuments", true],
      ["NS-2026-0102", "approve", false],
      ["NS-2026-0103", "enhancedReview", false],
    ]);
    expect(s.rules.map((r) => r.rule.id)).toEqual(["rule-docs", "rule-pep"]);
    expect(s.rulebookRevision).toBe(2);
    expect(s.coverage.closed).toBe(false);
    expect(s.gaps.filter((g) => g.source === "unexplained_decision")).toHaveLength(2);
  }, 60_000);

  it("finds witnesses within the domain constraints and queues ≥3 plain debrief questions", async () => {
    const s = await rebuild(w);
    const kinds = s.witnesses.map((v) => v.witness.kind);
    expect(kinds.filter((k) => k === "unresolved").length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain("boundary");
    expect(s.debriefQuestions).toBeGreaterThanOrEqual(3);
    for (const v of s.witnesses) {
      expect(v.status).toBe("queued");
      expect(v.foundEntryId).not.toBeNull();
      expect(v.question?.text.split(/\s+/).length).toBeLessThanOrEqual(25);
    }
    const boundary = s.witnesses.find((v) => v.witness.kind === "boundary");
    expect(boundary?.question?.text).toMatch(/^Largest beneficial owner share exactly 25%/);
    // Witness questions use the interview queue: the same `question.queued` mechanism as live questions.
    const queued = w.ledger.list(w.sessionId, { kinds: ["question.queued"] }).map((e) => (e.payload as { kind: string }).kind);
    expect(queued.filter((k) => k === "witness").length).toBe(s.debriefQuestions);
    // Rebuilding again changes nothing (witness ids are deterministic, questions deduplicated).
    const before = w.ledger.list(w.sessionId).length;
    await rebuild(w);
    expect(w.ledger.list(w.sessionId).length).toBe(before);
  }, 120_000);

  it("closes gaps from the expert's typed answers: rules for decision cells, an acknowledged escalation", async () => {
    let s = await getState(w);
    // The case the expert approved (0102: owner 20%, verified) is an unresolved cell: the expert confirms "approve".
    const approveCell = s.witnesses.find((v) => v.current && v.witness.kind === "unresolved" && v.conditions.some((c) => c.includes("at most 25%")) && v.conditions.includes("largest owner identity verified: yes"));
    expect(approveCell?.cellRule?.text).toBe("largest beneficial owner share at most 25% and largest owner identity verified is yes");
    s = await act(w, { action: "add_rule_for_witness", witnessId: approveCell?.witness.id, decision: "approve", quote: "Small owner, verified — that's a straight approval." });
    expect(s.witnesses.find((v) => v.witness.id === approveCell?.witness.id)?.status).toBe("resolved");
    expect(s.decisions.find((d) => d.caseId === "NS-2026-0102")?.explained).toBe(true);
    expect(s.rulebookRevision).toBe(3);

    // The PEP case (0103: owner 100%, verified) → enhanced review.
    const pepCell = s.witnesses.find((v) => v.current && v.witness.kind === "unresolved" && v.conditions.includes("largest owner identity verified: yes"));
    s = await act(w, { action: "add_rule_for_witness", witnessId: pepCell?.witness.id, decision: "enhancedReview", quote: "A big verified owner still gets enhanced review." });
    expect(s.decisions.every((d) => d.explained)).toBe(true);

    // Small unverified owner: not the reviewer's call.
    const escalate = openGaps(s)[0];
    expect(escalate).toBeDefined();
    s = await act(w, { action: "acknowledge_witness", witnessId: escalate?.witness.id, resolution: "escalate_to_controller", quote: "That one isn't mine to decide — escalate to the controller." });
    expect(s.witnesses.find((v) => v.witness.id === escalate?.witness.id)?.status).toBe("acknowledged");
    expect(openGaps(s)).toEqual([]);
    expect(s.coverage).toMatchObject({ unresolvedWitnesses: 0, undefinedConcepts: 0, teachBackConfirmed: false, closed: false });
    expect(s.coverage.acknowledgedWitnesses).toBe(1);
    expect(s.gapsClosed.closed).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("teach-back: Opus prose from confirmed rules only; a correction revises the rule, reruns the solver and writes a new teach-back", async () => {
    let s = DebriefStateSchema.parse((await reply(await handleGenerateTeachBack(w.sessionId, w.deps))).body);
    expect(s.teachBack).toMatchObject({ text: OPUS_TEACHBACK, origin: "llm", current: true, confirmedEntryId: null });
    const [call] = w.calls;
    expect(call?.model).toBe("claude-opus-5-5");
    // Only confirmed rules reach the prompt: no candidate ids, no hypotheses, no oracle.
    const engineCandidates = s.proposals.map((p) => p.candidateId);
    expect(engineCandidates.length).toBeGreaterThan(0);
    for (const id of engineCandidates) expect(`${call?.system}${call?.user}`).not.toContain(id);
    expect(call?.user).not.toMatch(/oracle:/);
    expect(call?.user).not.toMatch(/\bcand_[0-9a-f]{14}\b/);
    expect(call?.user).toContain(DOCS_QUOTE);
    expect(call?.user.split("\n").filter((l) => /^\d+\. When /.test(l))).toHaveLength(s.rules.length);
    // The teach-back is queued for the agent to speak, through the gate.
    const tbQuestion = w.ledger.list(w.sessionId, { kinds: ["question.queued"] }).find((e) => (e.payload as { kind: string }).kind === "teach_back");
    expect((tbQuestion?.payload as { text: string }).text).toBe(OPUS_TEACHBACK);

    // The deliberate correction: "a quarter or more", not "more than a quarter".
    const docs = s.rules.find((r) => r.rule.id === "rule-docs");
    const revision = s.rulebookRevision;
    s = await act(w, {
      action: "revise_rule",
      ruleId: "rule-docs",
      predicate: { and: [{ ">=": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] },
      teachBackId: s.teachBack?.entryId,
      quote: "No — at exactly a quarter we already ask for documents. Twenty-five percent or more.",
    });
    expect(s.rulebookRevision).toBe(revision + 1);
    expect(s.lastChange).toMatchObject({ kind: "revised", ruleId: "rule-docs" });
    expect(s.lastChange?.fields).toEqual(expect.arrayContaining(["predicate", "revision", "evidence", "confirmedBy"]));
    expect(s.lastChange?.before?.when).toContain("above 25%");
    expect(s.lastChange?.after?.when).toContain("at least 25%");
    const revised = s.rules.find((r) => r.rule.id === "rule-docs")?.rule;
    expect(revised?.revision).toBe((docs?.rule.revision ?? 0) + 1);
    expect(revised?.evidence[0]).toMatchObject({ provenance: "human_text", exactQuote: expect.stringContaining("Twenty-five percent or more") });
    expect(revised?.confirmedBy[0]?.method).toBe("teach_back");
    // A new teach-back of the revised rulebook was written; the old one is stale.
    expect(s.teachBack?.rulebookRevision).toBe(s.rulebookRevision);
    expect(w.calls.filter((c) => c.system === TEACHBACK_SYSTEM)).toHaveLength(2);
  }, 120_000);

  it("closes coverage on all four criteria once remaining gaps are answered and the teach-back is confirmed", async () => {
    let s = await rebuild(w);
    // The solver reran on the revised rule; answer whatever new gaps it found.
    for (let i = 0; i < 8 && openGaps(s).length > 0; i++) {
      const gap = openGaps(s)[0];
      s =
        gap?.witness.kind === "unresolved" && gap.cellRule !== null
          ? await act(w, { action: "add_rule_for_witness", witnessId: gap.witness.id, decision: "approve", quote: "Those are fine to approve." })
          : await act(w, { action: "acknowledge_witness", witnessId: gap?.witness.id, resolution: "escalate_to_controller", quote: "Escalate those to the controller." });
    }
    expect(openGaps(s)).toEqual([]);
    if (s.teachBack?.current !== true) s = DebriefStateSchema.parse((await reply(await handleGenerateTeachBack(w.sessionId, w.deps))).body);
    expect(s.coverage.closed).toBe(false);
    s = await act(w, { action: "confirm_teachback", teachBackId: s.teachBack?.entryId, quote: "Yes, that's right." });
    expect(s.coverage).toMatchObject({
      decisionsExplained: { explained: 3, total: 3 },
      unresolvedWitnesses: 0,
      undefinedConcepts: 0,
      teachBackConfirmed: true,
      closed: true,
    });
    expect(s.teachBack?.confirmedEntryId).not.toBeNull();
    // Teach-back confirmations come from the expert's own statement.
    const confirmed = w.ledger.list(w.sessionId, { kinds: ["teachback.confirmed"] }).at(-1);
    const statement = w.ledger.get((confirmed?.payload as { utteranceId: string }).utteranceId);
    expect(statement).toMatchObject({ source: "expert", kind: "expert.statement" });
  }, 180_000);

  it("refuses an action without the expert's own words, and a stale teach-back", async () => {
    const s = await getState(w);
    const r = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), { action: "confirm_teachback", teachBackId: s.teachBack?.entryId, quote: "" }), w.sessionId, w.deps));
    expect(r.status).toBe(400);
    const again = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), { action: "confirm_teachback", teachBackId: s.teachBack?.entryId, quote: "Yes." }), w.sessionId, w.deps));
    expect(again.status).toBe(409);
  });

  it("builds the Work Map by code, saves its JSON export, and both exports round-trip", async () => {
    const r = await reply(await handleGetWorkMap(w.sessionId, w.deps));
    expect(r.status).toBe(200);
    const view = WorkMapResponseSchema.parse(r.body);
    const { workMap } = view;
    expect(view.proseOrigin).toBe("llm");
    expect(workMap.steps.map((s) => s.title)).toEqual(["Review 1", "Review 2", "Review 3"]);
    expect(workMap.coverage.closed).toBe(true);
    expect(workMap.steps.every((s) => s.ruleIds.length > 0 && s.reasonQuotes.length > 0)).toBe(true);
    const pepStep = workMap.steps.find((s) => s.caseId === "NS-2026-0103");
    expect(pepStep?.guardrailIds).toEqual(["rule-pep"]);
    // Screen moment of the step: the redacted frame first, then the DOM events of the same window.
    const moments = view.moments[pepStep?.id ?? ""] ?? [];
    expect(moments[0]).toMatchObject({ kind: "frame" });
    expect(moments.find((m) => m.kind === "dom_event")).toMatchObject({ summary: "opened case NS-2026-0103" });
    // Saved export equals the canonical export and round-trips.
    const saved = await readFile(join(w.dataDir, "media", view.exportPath), "utf8");
    expect(saved).toBe(exportWorkMapJson(workMap));
    expect(importWorkMapJson(saved)).toEqual(workMap);
    expect(w.ledger.list(w.sessionId, { kinds: ["workmap.generated"] })).toHaveLength(1);
    // A second request serves the same Work Map without regenerating it.
    const again = WorkMapResponseSchema.parse((await reply(await handleGetWorkMap(w.sessionId, w.deps))).body);
    expect(again.workMap).toEqual(workMap);
    expect(w.ledger.list(w.sessionId, { kinds: ["workmap.generated"] })).toHaveLength(1);
    // Procedure export round-trips against the source rules.
    const res = await handleExport(new Request(`http://localhost${path(w.sessionId, "workmap/export")}?format=procedure`), w.sessionId, w.deps);
    expect(res.headers.get("content-disposition")).toContain("procedure-r");
    const parsed = parseProcedure(await res.text());
    expect(parsed.rulebookRevision).toBe(workMap.rulebookRevision);
    expect([...parsed.rules].sort((a, b) => a.id.localeCompare(b.id))).toEqual(workMap.rules.map(procedureRule).sort((a, b) => a.id.localeCompare(b.id)));
  }, 120_000);

  it("traces a confirmed rule back to the decisions, the witness and the expert's words", async () => {
    const s = await getState(w);
    const docs = s.rules.find((r) => r.rule.id === "rule-docs");
    const r = await reply(await handleLineage(new Request(`http://localhost${path(w.sessionId, "lineage")}?entryId=${docs?.entryId ?? ""}`), w.sessionId, w.deps));
    expect(r.status).toBe(200);
    const trace = LineageResponseSchema.parse(r.body);
    const stages = trace.nodes.map((n) => n.stage);
    expect(stages).toContain("answer");
    expect(stages).toContain("confirmed_rule");
    expect(trace.nodes.some((n) => n.kind === "expert.statement" && n.summary.includes("Twenty-five percent or more"))).toBe(true);
    expect(trace.nodes.every((n) => n.source !== "system_control")).toBe(true);
    const witness = s.witnesses.find((v) => v.status === "acknowledged");
    const wt = LineageResponseSchema.parse((await reply(await handleLineage(new Request(`http://localhost/x?entryId=${witness?.foundEntryId ?? ""}`), w.sessionId, w.deps))).body);
    expect(wt.nodes.map((n) => n.kind)).toEqual(expect.arrayContaining(["witness.found", "question.queued", "expert.statement", "witness.resolved"]));
  });

  it("/mcp check_action blocks approving a PEP with the expert's quote (in-process HTTP)", async () => {
    const pepCase = { entityType: "individual", customerStatus: "new", accountAgeMonths: 0, jurisdictionRisk: "low", uboOwnershipPct: 100, uboVerified: true, pep: true, sanctionsHit: false, adverseMedia: false, sourceOfFunds: "verified", expectedMonthlyVolume: 9_500, riskRating: "unrated" };
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_action", arguments: { context: { case: pepCase }, proposedAction: "approve" } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { structuredContent: { decision: string; matchedRules: string[]; rulebookRevision: number; explanation: string } } };
    expect(body.result.structuredContent).toMatchObject({ decision: "forbid", matchedRules: ["rule-pep"], rulebookRevision: w.deps.rulebook().revision });
    expect(body.result.structuredContent.explanation).toContain(PEP_QUOTE);
  });

  it("refuses /mcp in production when MCP_BEARER_TOKEN is unset", async () => {
    const handler = createMcpEndpoint({ env: { NODE_ENV: "production" }, rulebook: () => [], rulebookRevision: () => 0 });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
