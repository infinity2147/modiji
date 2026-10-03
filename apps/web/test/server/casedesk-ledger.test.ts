import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerError, OffRecordError, StaleEpochError } from "@vashistha/core/server";
import { LedgerPageResponseSchema } from "../../lib/contracts/ledger";
import { ApiFailure, toErrorResponse } from "../../lib/server/casedesk/http";
import { T0, createCaseDeskHarness, domEvent, type CaseDeskHarness } from "../support/casedesk-harness";

let h: CaseDeskHarness;
let sessionId: string;
beforeEach(async () => {
  h = createCaseDeskHarness();
  sessionId = await h.session("training");
});
afterEach(() => h.opened.close());

async function page(query: string) {
  const { status, body } = await h.readLedger(sessionId, query);
  expect(status).toBe(200);
  return LedgerPageResponseSchema.parse(body).entries;
}

describe("GET /api/sessions/:sessionId/ledger", () => {
  beforeEach(async () => {
    const events = Array.from({ length: 5 }, (_, i) => domEvent({ frameSeq: i + 1 }));
    expect((await h.postEvents(sessionId, { events })).status).toBe(200);
    h.ledger.setOffRecord(sessionId, true, { occurredAt: T0, traceId: "privacy-trace" });
  });

  it("returns every entry of the session in sequence order, each labelled with its source", async () => {
    const entries = await page("");
    expect(entries.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(entries.map((e) => e.source)).toEqual(["engine", "dom", "dom", "dom", "dom", "dom", "system_control"]);
    expect(entries).toEqual(h.ledger.list(sessionId));
  });

  it("pages with after (exclusive) and limit", async () => {
    expect((await page("?limit=2")).map((e) => e.sequence)).toEqual([0, 1]);
    expect((await page("?after=1&limit=2")).map((e) => e.sequence)).toEqual([2, 3]);
    expect((await page("?after=5")).map((e) => e.sequence)).toEqual([6]);
    expect(await page("?after=6")).toEqual([]);
    expect(await page("?after=0&limit=500")).toHaveLength(6);
  });

  it("does not mix sessions", async () => {
    const other = await h.session("training");
    expect((await h.readLedger(other)).body).toEqual({ entries: [h.ledger.list(other)[0]] });
  });

  it.each(["?limit=0", "?limit=501", "?limit=", "?after=-1", "?after=1.5", "?after=abc", "?after=1e3", "?offset=2"])(
    "400 invalid_query for %s",
    async (query) => {
      const { status, body } = await h.readLedger(sessionId, query);
      expect(status).toBe(400);
      expect(body).toMatchObject({ error: "invalid_query" });
    },
  );

  it("404 for an unknown session", async () => {
    expect(await h.readLedger("nope")).toMatchObject({ status: 404, body: { error: "session_not_found" } });
  });
});

describe("error mapping", () => {
  const map = async (error: unknown) => {
    const logs: string[] = [];
    const response = toErrorResponse(error, { error: (line: string) => logs.push(line) });
    return { status: response.status, body: await response.json(), logs };
  };

  it("maps ledger error codes to HTTP statuses with ApiError bodies", async () => {
    expect(await map(new LedgerError("session_not_found", "session s not found"))).toMatchObject({
      status: 404,
      body: { error: "session_not_found", detail: "session s not found" },
    });
    expect(await map(new StaleEpochError("s", 0, 1))).toMatchObject({ status: 409, body: { error: "stale_epoch" } });
    expect(await map(new OffRecordError("s"))).toMatchObject({ status: 409, body: { error: "off_record" } });
    expect(await map(new LedgerError("invalid_entry", "bad"))).toMatchObject({ status: 400, body: { error: "invalid_entry" } });
  });

  it("passes ApiFailure through", async () => {
    expect(await map(new ApiFailure(409, "stale_frame", "old"))).toEqual({
      status: 409,
      body: { error: "stale_frame", detail: "old" },
      logs: [],
    });
  });

  it.each([
    ["an unexpected ledger code", new LedgerError("parent_not_found", "parent entries not found: x")],
    ["a plain error", new Error("SQLITE_CORRUPT at /data/secret/path")],
    ["a non-Error", "boom"],
  ])("500 internal_error for %s, never echoing the message or a stack", async (_name, error) => {
    const { status, body, logs } = await map(error);
    expect(status).toBe(500);
    expect(body).toEqual({ error: "internal_error" });
    expect(logs).toHaveLength(1);
  });
});
