import { describe, expect, it } from "vitest";
import { GuardrailResultSchema, type LedgerEntry } from "@vashistha/core";
import { ApiError, commitDecision, createSession, describeError, listCases } from "../../lib/client/api";
import { REVIEW_OUTCOMES, actionLabel, featureLabel, interlockPrompt } from "../../lib/client/domain";
import { formatRelationshipAge, formatTimestamp } from "../../lib/client/format";
import { save, type SaveRequest } from "../../lib/client/save-flow";
import { readLedger, summariseLedger } from "../../lib/client/session-state";
import { parseSessionParams, sessionHref } from "../../lib/client/session-url";
import { jsonResponse, scriptedFetch } from "./fake-fetch";

const allow = GuardrailResultSchema.parse({ decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] });
const quote = {
  kind: "expert_quote",
  utteranceId: "u-1",
  exactQuote: "Never approve an unverified owner.",
  t0Ms: 1000,
  t1Ms: 2500,
  frameIds: ["f-1"],
  eventIds: [],
  relation: "supports",
  provenance: "human_voice",
} as const;
const forbid = GuardrailResultSchema.parse({ decision: "forbid", matchedRules: ["r-1"], missingFeatures: [], evidence: [quote] });
const needsApproval = GuardrailResultSchema.parse({ ...forbid, decision: "needs_approval" });

describe("response validation", () => {
  it("returns schema-valid bodies (201 counts as success)", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse({ sessionId: "s-1", mode: "expert", caseSet: "training", privacyEpoch: 0, schemaVersion: 1 }, 201),
    );
    await expect(createSession(fetch, { mode: "expert", caseSet: "training" })).resolves.toMatchObject({ sessionId: "s-1" });
    expect(requests[0]).toMatchObject({ url: "/api/sessions", method: "POST", body: { mode: "expert", caseSet: "training" } });
  });

  it("rejects bodies that break the contract", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ cases: [{ id: "not-a-case" }] }));
    await expect(listCases(fetch, "training")).rejects.toMatchObject({ kind: "invalid_response", code: "schema_mismatch" });
    const notJson = scriptedFetch(() => new Response("<html>", { status: 200 }));
    await expect(listCases(notJson.fetch, "training")).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("reads refusals as ApiError with the server's code and detail", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({ error: "invalid_case_set", detail: "bench is reserved" }, 400));
    const error = await listCases(fetch, "training").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "http", status: 400, code: "invalid_case_set", detail: "bench is reserved" });
    expect(describeError(error)).toBe("Request refused (400 invalid_case_set) — bench is reserved");
  });

  it("reports network failures as such", async () => {
    const { fetch } = scriptedFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(listCases(fetch, "training")).rejects.toMatchObject({ kind: "network", status: 0 });
  });

  it("commit: a 409 blocked body is a result; a 409 ApiError body is an error", async () => {
    const body = { caseId: "NS-2026-0101", edits: { riskRating: "low" as const }, action: "approve", checkId: "c-1" };
    const blocked = scriptedFetch(() => jsonResponse({ status: "blocked", result: forbid }, 409));
    await expect(commitDecision(blocked.fetch, "s-1", body)).resolves.toEqual({ status: "blocked", result: forbid });
    const mismatch = scriptedFetch(() => jsonResponse({ error: "already_decided" }, 409));
    await expect(commitDecision(mismatch.fetch, "s-1", body)).rejects.toMatchObject({ status: 409, code: "already_decided" });
  });
});

describe("Save interlock flow", () => {
  const request: SaveRequest = { sessionId: "s-1", caseId: "NS-2026-0101", action: REVIEW_OUTCOMES[0]!.id, riskRating: "medium" };

  function server(check: unknown, commit: () => Response = () => jsonResponse({ status: "committed", decisionId: "d-1", result: allow })) {
    return scriptedFetch((url) => (url === "/api/interlock/check" ? jsonResponse({ result: check, checkId: "c-1" }) : commit()));
  }

  it("flushes events, checks, then commits on allow citing the check", async () => {
    const order: string[] = [];
    const net = server(allow);
    const outcome = await save(
      { fetch: (u, i) => (order.push(u), net.fetch(u, i)), flushEvents: async () => void order.push("flush") },
      request,
    );
    expect(order).toEqual(["flush", "/api/interlock/check", "/api/sessions/s-1/decisions"]);
    expect(net.requests[0]?.body).toEqual({ sessionId: "s-1", caseId: "NS-2026-0101", edits: { riskRating: "medium" }, proposedAction: "approve" });
    expect(net.requests[1]?.body).toEqual({ caseId: "NS-2026-0101", edits: { riskRating: "medium" }, action: "approve", checkId: "c-1" });
    expect(outcome).toEqual({
      kind: "committed",
      decision: { caseId: "NS-2026-0101", action: "approve", riskRating: "medium", decisionId: "d-1", override: undefined, result: allow },
    });
  });

  it("forbid never reaches the commit endpoint", async () => {
    const net = server(forbid);
    await expect(save({ fetch: net.fetch, flushEvents: async () => {} }, request)).resolves.toEqual({
      kind: "blocked",
      checkId: "c-1",
      result: forbid,
    });
    expect(net.requests).toHaveLength(1);
  });

  it("needs_approval and insufficient_information ask for an override instead of committing", async () => {
    for (const result of [needsApproval, { ...allow, decision: "insufficient_information", missingFeatures: ["sourceOfFunds"] }]) {
      const net = server(result);
      const outcome = await save({ fetch: net.fetch, flushEvents: async () => {} }, request);
      expect(outcome.kind).toBe("needs_override");
      expect(net.requests).toHaveLength(1);
    }
  });

  it("a commit blocked by the server's re-check is reported, not committed", async () => {
    const net = server(allow, () => jsonResponse({ status: "blocked", result: forbid }, 409));
    await expect(save({ fetch: net.fetch, flushEvents: async () => {} }, request)).resolves.toMatchObject({ kind: "blocked" });
  });

  it("does not check when event delivery fails", async () => {
    const net = server(allow);
    const failure = new ApiError("http", 409, "stale_epoch");
    await expect(save({ fetch: net.fetch, flushEvents: () => Promise.reject(failure) }, request)).rejects.toBe(failure);
    expect(net.requests).toHaveLength(0);
  });
});

function entry(sequence: number, source: LedgerEntry["source"], kind: string, payload: unknown, privacyEpoch = 0): LedgerEntry {
  return {
    id: `l-${sequence}`,
    sequence,
    receivedAt: 1000 + sequence,
    sessionId: "s-1",
    source,
    kind,
    occurredAt: 1000 + sequence,
    traceId: "t",
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch,
    payload,
  };
}

describe("session resume from the ledger", () => {
  const started = entry(1, "engine", "session.started", { mode: "expert", caseSet: "training", domainId: "kycNorthstar", schemaVersion: 1 });

  it("recovers mode, set, epoch, last frame and committed decisions", () => {
    const state = summariseLedger([
      started,
      entry(2, "dom", "screen.event", { frameSeq: 1, kind: "navigate" }),
      entry(3, "dom", "screen.event", { frameSeq: 2, kind: "open_case" }),
      entry(4, "engine", "interlock.check", { caseId: "NS-2026-0101", result: allow }),
      entry(5, "dom", "case.decision", {
        caseId: "NS-2026-0101",
        action: "reject",
        edits: { riskRating: "high" },
        override: { kind: "escalated", note: "see file" },
        result: needsApproval,
      }),
      entry(6, "system_control", "privacy.epoch_advanced", {}, 1),
    ]);
    expect(state).toMatchObject({ mode: "expert", caseSet: "training", privacyEpoch: 1, lastFrameSeq: 2 });
    expect([...state.decisions.values()]).toEqual([
      {
        caseId: "NS-2026-0101",
        action: "reject",
        riskRating: "high",
        decisionId: "l-5",
        override: { kind: "escalated", note: "see file" },
        result: needsApproval,
      },
    ]);
  });

  it("refuses a session that is not a CaseDesk session", () => {
    expect(() => summariseLedger([entry(1, "engine", "other", {})])).toThrow(ApiError);
  });

  it("reads every ledger page", async () => {
    const all = Array.from({ length: 501 }, (_, i) => (i === 0 ? started : entry(i + 1, "dom", "screen.event", { frameSeq: i })));
    const { fetch, requests } = scriptedFetch((url) => {
      const after = Number(new URL(url, "http://x").searchParams.get("after") ?? 0);
      return jsonResponse({ entries: all.filter((e) => e.sequence > after).slice(0, 500) });
    });
    expect(await readLedger(fetch, "s-1")).toHaveLength(501);
    expect(requests.map((r) => r.url)).toEqual(["/api/sessions/s-1/ledger?limit=500", "/api/sessions/s-1/ledger?limit=500&after=500"]);
  });
});

describe("session URL", () => {
  it("round-trips and rejects malformed parameters", () => {
    const ref = { sessionId: "abc-123", caseSet: "heldout", mode: "novice" } as const;
    expect(parseSessionParams(new URL(sessionHref(ref), "http://x").searchParams)).toEqual(ref);
    expect(parseSessionParams(new URLSearchParams(""))).toBeUndefined();
    expect(parseSessionParams(new URLSearchParams("session=abc&set=nope&mode=expert"))).toBe("invalid");
  });
});

describe("domain vocabulary and formatting", () => {
  it("labels come from the domain config", () => {
    expect(REVIEW_OUTCOMES.map((o) => o.id)).toEqual(["approve", "enhancedReview", "requestDocuments", "escalateCompliance", "reject"]);
    expect(actionLabel("enhancedReview")).toBe("Send to enhanced review");
    expect(featureLabel("uboVerified")).toBe("Largest owner identity verified");
    expect(interlockPrompt(allow)).toBe("commit");
    expect(interlockPrompt(forbid)).toBe("blocked");
    expect(interlockPrompt(needsApproval)).toBe("needs_override");
  });

  it("formats quote timings and relationship ages", () => {
    expect(formatTimestamp(64_200)).toBe("1:04.2");
    expect(formatTimestamp(5_000)).toBe("0:05.0");
    expect(formatRelationshipAge(0)).toBe("New relationship");
    expect(formatRelationshipAge(7)).toBe("7 months");
    expect(formatRelationshipAge(27)).toBe("2 yr 3 mo");
  });
});
