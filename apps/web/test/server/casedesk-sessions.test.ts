import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateSessionResponseSchema, ListCasesResponseSchema } from "../../lib/contracts/casedesk";
import { createCaseDeskStore, loadSession, sessionInfo } from "../../lib/server/casedesk/session";
import { T0, createCaseDeskHarness, jsonRequest, type CaseDeskHarness } from "../support/casedesk-harness";
import { handleCreateSession } from "../../lib/server/casedesk/sessions";

let h: CaseDeskHarness;
beforeEach(() => {
  h = createCaseDeskHarness();
});
afterEach(() => h.opened.close());

describe("POST /api/sessions", () => {
  it("creates a ledger session rooted in an engine session.started entry", async () => {
    const { status, body } = await h.createSession({ mode: "expert", caseSet: "heldout" });
    expect(status).toBe(201);
    const created = CreateSessionResponseSchema.parse(body);
    expect(created).toMatchObject({ mode: "expert", caseSet: "heldout", privacyEpoch: 0, schemaVersion: 1 });

    const entries = h.ledger.list(created.sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "engine",
      kind: "session.started",
      sequence: 0,
      occurredAt: T0,
      parentIds: [],
      privacyEpoch: 0,
      schemaVersion: 1,
      payload: { mode: "expert", caseSet: "heldout", domainId: "kycNorthstar", schemaVersion: 1 },
    });
  });

  it("reads mode and case set back from the ledger when the cache is cold", async () => {
    const sessionId = await h.session("practice");
    const started = h.ledger.list(sessionId)[0];
    expect(sessionInfo(h.ledger, createCaseDeskStore(), sessionId)).toEqual({
      mode: "novice",
      caseSet: "practice",
      startedEntryId: started?.id,
    });
  });

  it("does not treat a non-CaseDesk ledger session as a CaseDesk session", () => {
    h.ledger.createSession({ id: "gate-only" });
    expect(sessionInfo(h.ledger, h.deps.store, "gate-only")).toBeUndefined();
    expect(() => loadSession(h.deps, "gate-only")).toThrow(/session_not_found/);
    expect(() => loadSession(h.deps, "")).toThrow(/session_not_found/);
  });

  it.each([
    ["bench set (benchmark only)", { mode: "novice", caseSet: "bench" }, "invalid_case_set"],
    ["unknown set", { mode: "novice", caseSet: "everything" }, "invalid_request"],
    ["unknown mode", { mode: "judge", caseSet: "training" }, "invalid_request"],
    ["missing caseSet", { mode: "novice" }, "invalid_request"],
    ["extra member", { mode: "novice", caseSet: "training", privacyEpoch: 7 }, "invalid_request"],
    ["array body", [], "invalid_request"],
    ["non-JSON body", "{mode:", "invalid_json"],
  ])("400 for %s, creating nothing", async (_name, body, error) => {
    const { status, body: reply } = await h.createSession(body);
    expect(status).toBe(400);
    expect(reply).toMatchObject({ error });
    expect(h.opened.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("413 for an oversized body", async () => {
    const response = await handleCreateSession(
      jsonRequest("/api/sessions", { mode: "novice", caseSet: "training", pad: "x".repeat(70_000) }),
      h.deps,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large", detail: expect.any(String) });
  });
});

describe("GET /api/cases", () => {
  it.each(["training", "heldout"] as const)("serves the %s set as public case data", async (set) => {
    const { status, body } = await h.listCases(`?set=${set}`);
    expect(status).toBe(200);
    const { cases } = ListCasesResponseSchema.parse(body);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.set === set)).toBe(true);
  });

  it.each([
    ["bench", "?set=bench"],
    ["missing set", ""],
    ["empty set", "?set="],
    ["unknown set", "?set=secret"],
  ])("400 for %s", async (_name, query) => {
    const { status, body } = await h.listCases(query);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_case_set", detail: expect.any(String) });
  });
});
