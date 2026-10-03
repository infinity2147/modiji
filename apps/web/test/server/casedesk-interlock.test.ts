import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kycCases } from "@vashistha/core/domains/kyc";
import { CommitDecisionResponseSchema, InterlockCheckResponseSchema } from "../../lib/contracts/casedesk";
import {
  EXPERT_QUOTE,
  T0,
  createCaseDeskHarness,
  fixtureRulebook,
  heldoutCase,
  trainingCase,
  type CaseDeskHarness,
} from "../support/casedesk-harness";

let h: CaseDeskHarness;
let sessionId: string;
beforeEach(async () => {
  h = createCaseDeskHarness();
  h.setRules(fixtureRulebook());
  sessionId = await h.session("training");
});
afterEach(() => h.opened.close());

const caseId = () => trainingCase().id;
const rootId = () => h.ledger.list(sessionId, { kinds: ["session.started"] })[0]?.id;
const offRecord = (on: boolean) => h.ledger.setOffRecord(sessionId, on, { occurredAt: T0, traceId: "privacy-trace" });

async function check(over: Record<string, unknown> = {}) {
  const reply = await h.check({ sessionId, caseId: caseId(), edits: {}, proposedAction: "approve", ...over });
  return { ...reply, parsed: reply.status === 200 ? InterlockCheckResponseSchema.parse(reply.body) : undefined };
}

async function checkId(over: Record<string, unknown> = {}): Promise<string> {
  const { parsed, body } = await check(over);
  if (!parsed) throw new Error(`check failed: ${JSON.stringify(body)}`);
  return parsed.checkId;
}

describe("POST /api/interlock/check", () => {
  it("allows when no confirmed rule applies, and records the check under the session root", async () => {
    h.setRules([]);
    const { status, parsed } = await check();
    expect(status).toBe(200);
    expect(parsed?.result).toEqual({ decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] });
    const entry = h.ledger.get(parsed?.checkId ?? "");
    expect(entry).toMatchObject({
      sessionId,
      source: "engine",
      kind: "interlock.check",
      parentIds: [rootId()],
      payload: { caseId: caseId(), action: "approve", edits: {}, result: parsed?.result },
    });
  });

  it("evaluates the server's case with the reviewer's edits applied: forbid, with the expert's quote", async () => {
    const { parsed } = await check({ edits: { riskRating: "high" } });
    expect(parsed?.result).toMatchObject({ decision: "forbid", matchedRules: ["rule.high.no-approve"] });
    expect(parsed?.result.evidence.map((e) => e.exactQuote)).toEqual([EXPERT_QUOTE]);
    expect((await check({ edits: { riskRating: "low" } })).parsed?.result.decision).toBe("allow");
    // The forbid targets approve only.
    expect((await check({ edits: { riskRating: "high" }, proposedAction: "reject" })).parsed?.result.decision).toBe("allow");
  });

  it("needs approval for any review outcome when an approval rule fires", async () => {
    const { parsed } = await check({ edits: { riskRating: "medium" }, proposedAction: "reject" });
    expect(parsed?.result).toMatchObject({ decision: "needs_approval", matchedRules: ["rule.medium.approval"] });
  });

  it.each([
    ["a non-terminal action", { proposedAction: "rateHigh" }, 400, "invalid_action"],
    ["an undeclared action", { proposedAction: "wireMoney" }, 400, "invalid_action"],
    ["a malformed action id", { proposedAction: "approve now" }, 400, "invalid_request"],
    ["an invalid edit", { edits: { riskRating: "extreme" } }, 400, "invalid_request"],
    ["a non-editable edit", { edits: { pep: false } }, 400, "invalid_request"],
    ["an unknown case", { caseId: "NS-9999-9999" }, 400, "unknown_case"],
    ["a case from another set", { caseId: heldoutCase().id }, 400, "unknown_case"],
    ["a client-supplied case", { case: { riskRating: "low" } }, 400, "invalid_request"],
    ["an unknown session", { sessionId: "nope" }, 404, "session_not_found"],
  ])("refuses %s", async (_name, over, status, error) => {
    const reply = await check(over);
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ error });
    expect(h.ledger.list(sessionId, { kinds: ["interlock.check"] })).toEqual([]);
  });

  it("409 off_record while off the record", async () => {
    offRecord(true);
    expect(await check()).toMatchObject({ status: 409, body: { error: "off_record" } });
  });
});

describe("POST /api/sessions/:sessionId/decisions", () => {
  async function decide(over: Record<string, unknown>) {
    const reply = await h.decide(sessionId, { caseId: caseId(), edits: {}, action: "approve", ...over });
    return { ...reply, parsed: CommitDecisionResponseSchema.safeParse(reply.body).data };
  }
  const decisions = () => h.ledger.list(sessionId, { kinds: ["case.decision"] });
  const blocks = () => h.ledger.list(sessionId, { kinds: ["interlock.blocked"] });

  it("commits an allowed decision as a dom case.decision citing the check", async () => {
    const id = await checkId({ edits: { riskRating: "low" } });
    const { status, parsed } = await decide({ edits: { riskRating: "low" }, checkId: id });
    expect(status).toBe(200);
    if (parsed?.status !== "committed") throw new Error("expected a commit");
    expect(parsed.result.decision).toBe("allow");
    const entry = h.ledger.get(parsed.decisionId);
    expect(entry).toMatchObject({
      source: "dom",
      kind: "case.decision",
      parentIds: [id],
      traceId: h.ledger.get(id)?.traceId,
      payload: { caseId: caseId(), action: "approve", edits: { riskRating: "low" }, result: parsed.result },
    });
    // Lineage: session.started → interlock.check → case.decision.
    expect(h.ledger.ancestors(parsed.decisionId).map((e) => e.kind)).toEqual(["session.started", "interlock.check"]);
    expect(h.ledger.evidence(sessionId).map((e) => e.kind)).toContain("case.decision");
  });

  it("drops an override that overrode nothing", async () => {
    const id = await checkId();
    const { parsed } = await decide({ checkId: id, override: { kind: "acknowledged", note: "fine" } });
    if (parsed?.status !== "committed") throw new Error("expected a commit");
    expect(h.ledger.get(parsed.decisionId)?.payload).not.toHaveProperty("override");
  });

  it("blocks a forbidden decision even with an override, recording interlock.blocked", async () => {
    const edits = { riskRating: "high" };
    const id = await checkId({ edits });
    for (const override of [undefined, { kind: "escalated", note: "Senior said ok" }]) {
      const { status, parsed } = await decide({ edits, checkId: id, ...(override && { override }) });
      expect(status).toBe(409);
      expect(parsed).toMatchObject({ status: "blocked", result: { decision: "forbid" } });
    }
    expect(decisions()).toEqual([]);
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toMatchObject({ source: "engine", parentIds: [id], payload: { caseId: caseId(), action: "approve" } });
    expect(blocks()[1]?.payload).toMatchObject({ override: { kind: "escalated" } });
  });

  it("needs_approval commits only with an acknowledgement or escalation", async () => {
    const edits = { riskRating: "medium" };
    const id = await checkId({ edits, proposedAction: "enhancedReview" });
    const blocked = await decide({ edits, action: "enhancedReview", checkId: id });
    expect(blocked).toMatchObject({ status: 409, parsed: { status: "blocked", result: { decision: "needs_approval" } } });
    expect(blocks()).toHaveLength(1);

    const override = { kind: "acknowledged", note: "Discussed with the senior reviewer." };
    const { status, parsed } = await decide({ edits, action: "enhancedReview", checkId: id, override });
    expect(status).toBe(200);
    if (parsed?.status !== "committed") throw new Error("expected a commit");
    expect(h.ledger.get(parsed.decisionId)?.payload).toMatchObject({ override, result: { decision: "needs_approval" } });
  });

  it("re-runs the interlock at commit time: a rule confirmed after the check still blocks", async () => {
    h.setRules([]);
    const edits = { riskRating: "high" };
    const id = await checkId({ edits });
    h.setRules(fixtureRulebook());
    expect(await decide({ edits, checkId: id })).toMatchObject({ status: 409, parsed: { status: "blocked" } });
  });

  describe("check_mismatch", () => {
    it.each<[string, Record<string, unknown>]>([
      ["another action", { action: "reject" }],
      ["other edits", { edits: { riskRating: "medium" } }],
      ["dropped edits", { edits: {} }],
      ["another case", { caseId: "OTHER" }],
    ])("409 when the request differs from the check: %s", async (_name, over) => {
      const id = await checkId({ edits: { riskRating: "low" } });
      const other = over.caseId === "OTHER" ? { caseId: kycCases("training").find((c) => c.id !== caseId())?.id } : over;
      const reply = await decide({ edits: { riskRating: "low" }, checkId: id, ...other });
      expect(reply).toMatchObject({ status: 409, body: { error: "check_mismatch" } });
      expect(decisions()).toEqual([]);
    });

    it("409 when the checkId is not an interlock check of this session", async () => {
      const foreignSession = await h.session("training");
      const foreign = await h.check({ sessionId: foreignSession, caseId: caseId(), edits: {}, proposedAction: "approve" });
      const foreignId = InterlockCheckResponseSchema.parse(foreign.body).checkId;
      for (const id of [foreignId, rootId(), "no-such-entry"])
        expect(await decide({ checkId: id })).toMatchObject({ status: 409, body: { error: "check_mismatch" } });
    });
  });

  it("409 already_decided for a second decision on the same case", async () => {
    const first = await decide({ checkId: await checkId() });
    expect(first.status).toBe(200);
    const again = await decide({ action: "reject", checkId: await checkId({ proposedAction: "reject" }) });
    expect(again).toMatchObject({ status: 409, body: { error: "already_decided" } });
    expect(decisions()).toHaveLength(1);
  });

  it("409 off_record, appending nothing", async () => {
    const id = await checkId();
    offRecord(true);
    const before = h.ledger.list(sessionId).length;
    expect(await decide({ checkId: id })).toMatchObject({ status: 409, body: { error: "off_record" } });
    expect(h.ledger.list(sessionId)).toHaveLength(before);
  });

  it.each([
    ["a non-terminal action", { action: "rateLow" }, 400, "invalid_action"],
    ["an empty override note", { override: { kind: "acknowledged", note: " " } }, 400, "invalid_request"],
    ["an unknown override kind", { override: { kind: "ignored", note: "x" } }, 400, "invalid_request"],
  ])("refuses %s", async (_name, over, status, error) => {
    const reply = await decide({ checkId: await checkId(), ...over });
    expect(reply).toMatchObject({ status, body: { error } });
  });

  it("404 for an unknown session", async () => {
    const reply = await h.decide("nope", { caseId: caseId(), edits: {}, action: "approve", checkId: "x" });
    expect(reply).toMatchObject({ status: 404, body: { error: "session_not_found" } });
  });
});
