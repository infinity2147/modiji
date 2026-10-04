/**
 * The expert deletes a confirmed rule from the debrief (`retire_rule`): an `expert.statement` with the
 * expert's reason, then `rule.retired` citing it; the rule leaves the rulebook (revision++), the
 * diff card shows the deletion, and rules that overrode it drop the dangling id in a `rule.revised`.
 * Real ledger (in-memory SQLite), real Z3, real ledger-backed rulebook; only the model is fake.
 */
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLedgerPayload } from "@vashistha/core";
import { handleExpertAction } from "../../lib/server/debrief/handlers";
import { entrySummary } from "../../lib/server/debrief/lineage";
import { jsonRequest } from "../support/casedesk-harness";
import { act, getState, path, rebuild, reply, world, type World } from "../support/debrief-harness";

const PEP_REASON = "Delete it: politically exposed persons are handled by the controller's team, not by this rule.";

describe("debrief: deleting a confirmed rule", () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    await rebuild(w);
  }, 60_000);

  afterAll(async () => {
    w.opened.close();
    await rm(w.dataDir, { recursive: true, force: true });
  });

  it("refuses an unknown rule with 404 and a missing reason with 400, writing nothing", async () => {
    const before = w.ledger.list(w.sessionId).length;
    const unknown = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), { action: "retire_rule", ruleId: "rule-nope", quote: "This rule is wrong." }), w.sessionId, w.deps));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: "rule_not_found" });
    const silent = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), { action: "retire_rule", ruleId: "rule-pep", quote: "" }), w.sessionId, w.deps));
    expect(silent.status).toBe(400);
    expect(w.ledger.list(w.sessionId).length).toBe(before);
  }, 60_000);

  it("deletes a rule confirmed in the debrief: gone from the rulebook, revision++, diff card, statement + rule.retired", async () => {
    let s = await getState(w);
    const approveCell = s.witnesses.find((v) => v.current && v.witness.kind === "unresolved" && v.cellRule !== null);
    expect(approveCell).toBeDefined();
    s = await act(w, { action: "add_rule_for_witness", witnessId: approveCell?.witness.id, decision: "approve", quote: "Those are fine to approve." });
    const added = s.rules.find((r) => r.rule.id !== "rule-docs" && r.rule.id !== "rule-pep");
    expect(added).toBeDefined();
    const ruleId = added?.rule.id ?? "";
    const revision = s.rulebookRevision;

    const reason = "On second thought, delete that one — those cases need documents first.";
    s = await act(w, { action: "retire_rule", ruleId, quote: reason });
    expect(s.rules.map((r) => r.rule.id)).not.toContain(ruleId);
    expect(s.rulebookRevision).toBe(revision + 1);
    expect(s.lastChange).toMatchObject({ kind: "retired", ruleId, after: null, fields: [], reason: `expert deleted: "${reason}"` });
    expect(s.lastChange?.before).toMatchObject({ when: added?.when, then: added?.then });
    expect(w.deps.rulebook().rules.map((r) => r.id)).not.toContain(ruleId);

    const statement = w.ledger.list(w.sessionId, { kinds: ["expert.statement"] }).at(-1);
    expect(statement?.source).toBe("expert");
    expect(statement === undefined ? undefined : parseLedgerPayload(statement, "expert.statement")).toEqual({ text: reason, intent: "retire_rule", target: { ruleId } });
    const retired = w.ledger.list(w.sessionId, { kinds: ["rule.retired"] }).at(-1);
    expect(retired).toMatchObject({ source: "engine", payload: { ruleId, reason: `expert deleted: "${reason}"` } });
    expect(retired?.parentIds).toEqual(expect.arrayContaining([statement?.id, added?.entryId]));
    expect(retired === undefined ? "" : entrySummary(retired)).toBe(`Deleted rule ${ruleId} (expert deleted: "${reason}")`);

    // Deleting it again: no longer live.
    const again = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), { action: "retire_rule", ruleId, quote: reason }), w.sessionId, w.deps));
    expect(again.status).toBe(404);
  }, 120_000);

  it("drops the deleted rule's id from the overrides of the rules that overrode it", async () => {
    let s = await act(w, { action: "revise_rule", ruleId: "rule-docs", overrides: ["rule-pep"], quote: "Asking for documents comes before the PEP check." });
    expect(s.rules.find((r) => r.rule.id === "rule-docs")?.rule.overrides).toEqual(["rule-pep"]);
    const docsRevision = s.rules.find((r) => r.rule.id === "rule-docs")?.rule.revision ?? 0;
    const revision = s.rulebookRevision;

    s = await act(w, { action: "retire_rule", ruleId: "rule-pep", quote: PEP_REASON });
    expect(s.rules.map((r) => r.rule.id)).not.toContain("rule-pep");
    // One revision of the overrider, then the deletion (the latest change).
    expect(s.rulebookRevision).toBe(revision + 2);
    expect(s.lastChange).toMatchObject({ kind: "retired", ruleId: "rule-pep", after: null });
    const docs = s.rules.find((r) => r.rule.id === "rule-docs")?.rule;
    expect(docs?.overrides).toEqual([]);
    expect(docs?.revision).toBe(docsRevision + 1);
    expect(docs?.evidence[0]).toMatchObject({ provenance: "human_text", exactQuote: PEP_REASON });

    const statement = w.ledger.list(w.sessionId, { kinds: ["expert.statement"] }).at(-1);
    const revisedEntry = w.ledger.list(w.sessionId, { kinds: ["rule.revised"] }).at(-1);
    expect(revisedEntry?.parentIds).toContain(statement?.id);
    expect(revisedEntry?.payload).toMatchObject({ reason: `override of deleted rule rule-pep dropped: "${PEP_REASON}"` });
    const retired = w.ledger.list(w.sessionId, { kinds: ["rule.retired"] }).at(-1);
    expect(retired?.parentIds).toEqual(expect.arrayContaining([statement?.id, revisedEntry?.id]));
    expect(w.deps.rulebook().rejected).toEqual([]);

    // The overrider can still be revised with its own overrides (none dangling).
    s = await act(w, { action: "revise_rule", ruleId: "rule-docs", priority: 12, quote: "Make the documents rule a bit stronger." });
    expect(s.rules.find((r) => r.rule.id === "rule-docs")?.rule.priority).toBe(12);
  }, 120_000);
});
