import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenEventSchema } from "@vashistha/core";
import { PostEventsResponseSchema } from "../../lib/contracts/casedesk";
import {
  T0,
  createCaseDeskHarness,
  domEvent,
  heldoutCase,
  trainingCase,
  type CaseDeskHarness,
} from "../support/casedesk-harness";

let h: CaseDeskHarness;
let sessionId: string;
beforeEach(async () => {
  h = createCaseDeskHarness();
  sessionId = await h.session("training");
});
afterEach(() => h.opened.close());

const screenEvents = () => h.ledger.list(sessionId, { kinds: ["screen.event"] });
const started = () => h.ledger.list(sessionId, { kinds: ["session.started"] })[0];
const offRecord = (on: boolean) => h.ledger.setOffRecord(sessionId, on, { occurredAt: T0, traceId: "privacy-trace" });

describe("POST /api/sessions/:sessionId/events — happy path", () => {
  it("appends normalised dom screen events under the session root, re-deriving critical and confidence", async () => {
    const c = trainingCase();
    const open = domEvent({ frameSeq: 1, captureTime: T0 + 10, caseId: c.id, critical: true, confidence: 0.2 });
    const change = domEvent({
      frameSeq: 2,
      captureTime: T0 + 20,
      kind: "field_change",
      caseId: c.id,
      field: "riskRating",
      from: c.review.riskRating,
      to: "high",
      critical: false,
      confidence: 0.5,
    });
    const { status, body } = await h.postEvents(sessionId, { events: [open, change] });
    expect(status).toBe(200);
    const { ledgerIds } = PostEventsResponseSchema.parse(body);

    const entries = screenEvents();
    expect(entries.map((e) => e.id)).toEqual(ledgerIds);
    for (const entry of entries) {
      expect(entry).toMatchObject({ source: "dom", kind: "screen.event", privacyEpoch: 0, parentIds: [started()?.id] });
      ScreenEventSchema.parse(entry.payload);
    }
    expect(entries.map((e) => e.occurredAt)).toEqual([T0 + 10, T0 + 20]);
    expect(entries[0]?.traceId).toBe(entries[1]?.traceId);
    expect(entries[0]?.payload).toEqual({ ...open, confidence: 1, critical: false });
    expect(entries[1]?.payload).toEqual({ ...change, confidence: 1, critical: true });
    expect(h.ledger.children(started()?.id ?? "").map((e) => e.id)).toEqual(ledgerIds);
  });

  it("accepts domain actions and navigation, and several events of one frame", async () => {
    const events = [
      domEvent({ frameSeq: 4, kind: "navigate", caseId: undefined }),
      domEvent({ frameSeq: 5, kind: "action", action: "rateHigh" }),
      domEvent({ frameSeq: 5, kind: "action", action: "approve" }),
    ];
    expect((await h.postEvents(sessionId, { events })).status).toBe(200);
    expect(screenEvents().map((e) => (e.payload as { kind: string }).kind)).toEqual(["navigate", "action", "action"]);
  });
});

describe("validation", () => {
  it.each([
    ["a vision event on the DOM channel", { source: "vision" }],
    ["an unknown case", { caseId: "NS-9999-9999" }],
    ["a case from another set", { caseId: heldoutCase().id }],
    ["a non-editable field", { kind: "field_change", field: "pep", to: true }],
    ["an undeclared field", { kind: "field_change", field: "shoeSize", to: 42 }],
    ["an invalid value", { kind: "field_change", field: "riskRating", to: "extreme" }],
    ["a mistyped value", { kind: "field_change", field: "riskRating", to: 3 }],
    ["an invalid from value", { kind: "field_change", field: "riskRating", from: "extreme", to: "high" }],
    ["an unknown action", { kind: "action", action: "wireMoney" }],
    ["a field on open_case", { field: "riskRating" }],
    ["an action on field_change", { kind: "field_change", field: "riskRating", to: "low", action: "approve" }],
    ["a field_change without a case", { kind: "field_change", field: "riskRating", to: "low", caseId: undefined }],
  ])("400 invalid_event for %s", async (_name, over) => {
    const { status, body } = await h.postEvents(sessionId, { events: [domEvent(over)] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_event", detail: expect.stringMatching(/^events\[0\]: /) });
    expect(screenEvents()).toEqual([]);
  });

  it.each([
    ["no events", { events: [] }],
    ["more than 50 events", { events: Array.from({ length: 51 }, (_, i) => domEvent({ frameSeq: i + 1 })) }],
    ["an event failing the ScreenEvent schema", { events: [domEvent({ kind: "open_case", caseId: undefined })] }],
    ["an unknown member", { events: [domEvent({ secret: 1 })] }],
    ["an extra top-level member", { events: [domEvent()], sessionId: "x" }],
  ])("400 invalid_request for %s", async (_name, body) => {
    const reply = await h.postEvents(sessionId, body);
    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: "invalid_request" });
  });

  it("is all-or-nothing: one bad event rejects the whole batch", async () => {
    const { status } = await h.postEvents(sessionId, {
      events: [domEvent({ frameSeq: 1 }), domEvent({ frameSeq: 2, kind: "field_change", field: "pep", to: true })],
    });
    expect(status).toBe(400);
    expect(screenEvents()).toEqual([]);
    expect((await h.postEvents(sessionId, { events: [domEvent({ frameSeq: 1 })] })).status).toBe(200);
  });

  it("refuses duplicate event ids within a batch", async () => {
    const event = domEvent({ frameSeq: 1 });
    const { status, body } = await h.postEvents(sessionId, { events: [event, { ...event, frameSeq: 2 }] });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_event", detail: expect.stringContaining("duplicate event id") });
  });

  it("404 for an unknown session", async () => {
    const { status, body } = await h.postEvents("nope", { events: [domEvent()] });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "session_not_found" });
  });
});

describe("privacy epoch", () => {
  it("409 off_record while off the record, and stale_epoch for the old epoch after resuming", async () => {
    offRecord(true);
    const off = await h.postEvents(sessionId, { events: [domEvent({ sessionEpoch: 1 })] });
    expect(off).toMatchObject({ status: 409, body: { error: "off_record" } });

    offRecord(false); // epoch 2
    const stale = await h.postEvents(sessionId, { events: [domEvent({ sessionEpoch: 0 })] });
    expect(stale).toMatchObject({ status: 409, body: { error: "stale_epoch" } });
    expect(screenEvents()).toEqual([]);

    const fresh = await h.postEvents(sessionId, { events: [domEvent({ sessionEpoch: 2 })] });
    expect(fresh.status).toBe(200);
    expect(screenEvents()[0]?.privacyEpoch).toBe(2);
  });

  it("409 stale_epoch for an epoch from the future", async () => {
    expect(await h.postEvents(sessionId, { events: [domEvent({ sessionEpoch: 3 })] })).toMatchObject({
      status: 409,
      body: { error: "stale_epoch" },
    });
  });

  it("keeps system_control privacy entries out of evidence", async () => {
    await h.postEvents(sessionId, { events: [domEvent({ frameSeq: 1 })] });
    offRecord(true);
    offRecord(false);
    expect(h.ledger.list(sessionId).map((e) => e.source)).toContain("system_control");
    const evidence = h.ledger.evidence(sessionId);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((e) => e.source === "system_control")).toBe(false);
  });
});

describe("frame order", () => {
  const batch = (...frameSeqs: number[]) => ({ events: frameSeqs.map((frameSeq) => domEvent({ frameSeq })) });

  it("accepts strictly newer frames only (409 stale_frame for a replayed or older batch)", async () => {
    expect((await h.postEvents(sessionId, batch(1, 2))).status).toBe(200);
    expect(await h.postEvents(sessionId, batch(2))).toMatchObject({ status: 409, body: { error: "stale_frame" } });
    expect(await h.postEvents(sessionId, batch(0, 3))).toMatchObject({ status: 409, body: { error: "stale_frame" } });
    expect((await h.postEvents(sessionId, batch(3, 3, 7))).status).toBe(200);
    expect(screenEvents()).toHaveLength(5);
  });

  it("400 when frameSeq decreases within a batch", async () => {
    expect(await h.postEvents(sessionId, batch(5, 4))).toMatchObject({ status: 400, body: { error: "invalid_event" } });
  });

  it("recovers the last frame from the ledger after a restart", async () => {
    expect((await h.postEvents(sessionId, batch(9))).status).toBe(200);
    h.restart();
    expect(await h.postEvents(sessionId, batch(9))).toMatchObject({ status: 409, body: { error: "stale_frame" } });
    expect((await h.postEvents(sessionId, batch(10))).status).toBe(200);
  });

  it("tracks frames per session", async () => {
    const other = await h.session("training");
    expect((await h.postEvents(sessionId, batch(5))).status).toBe(200);
    expect((await h.postEvents(other, batch(1))).status).toBe(200);
  });
});
