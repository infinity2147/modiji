import { describe, expect, it } from "vitest";
import type { ScreenEvent } from "@vashistha/core";
import { ApiError } from "../../lib/client/api";
import { MAX_BATCH, createDomEventEmitter, type DomChannelStatus } from "../../lib/client/dom-events";
import { controlledFetch, jsonResponse, tick } from "./fake-fetch";

/** Manual timers: the idle timer fires only when the test says so. */
function manualTimers() {
  const scheduled = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    timers: {
      set: (fn: () => void) => {
        const handle = nextHandle++;
        scheduled.set(handle, fn);
        return handle;
      },
      clear: (handle: unknown) => scheduled.delete(handle as number),
    },
    pending: () => scheduled.size,
    fire: () => {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) fn();
    },
  };
}

function setup(lastFrameSeq = 0) {
  const net = controlledFetch();
  const clock = manualTimers();
  let ids = 0;
  const emitter = createDomEventEmitter({
    sessionId: "s-1",
    sessionEpoch: 3,
    lastFrameSeq,
    fetch: net.fetch,
    now: () => 1_700_000_000_000,
    newId: () => `e-${++ids}`,
    timers: clock.timers,
  });
  const statuses: DomChannelStatus[] = [];
  emitter.subscribe((s) => statuses.push(s));
  const sent = (i: number) => (net.requests[i]?.body as { events: ScreenEvent[] }).events;
  return { net, clock, emitter, statuses, sent };
}

const ok = (n: number) => jsonResponse({ ledgerIds: Array.from({ length: n }, (_, i) => `l-${i}`) });

describe("DOM event emitter", () => {
  it("stamps events: dom source, confidence 1, session epoch, frameSeq from 1, kind-specific members only", () => {
    const { emitter } = setup();
    const nav = emitter.emit({ kind: "navigate" });
    const open = emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" });
    const change = emitter.emit({ kind: "field_change", caseId: "NS-2026-0101", field: "riskRating", from: "unrated", to: "high" });
    const action = emitter.emit({ kind: "action", caseId: "NS-2026-0101", action: "approve" });
    expect(nav).toEqual({
      id: "e-1",
      frameSeq: 1,
      captureTime: 1_700_000_000_000,
      sessionEpoch: 3,
      kind: "navigate",
      confidence: 1,
      source: "dom",
      critical: false,
    });
    expect(open).toMatchObject({ frameSeq: 2, caseId: "NS-2026-0101", critical: false });
    expect(open).not.toHaveProperty("field");
    expect(change).toMatchObject({ frameSeq: 3, field: "riskRating", from: "unrated", to: "high", critical: true });
    expect(action).toMatchObject({ frameSeq: 4, action: "approve", critical: false });
    expect(action).not.toHaveProperty("field");
  });

  it("continues the frame sequence of a resumed session", () => {
    const { emitter } = setup(41);
    expect(emitter.emit({ kind: "navigate" })?.frameSeq).toBe(42);
  });

  it("batches events until the idle timer fires, then posts them in order", async () => {
    const { emitter, clock, net, sent } = setup();
    emitter.emit({ kind: "navigate" });
    emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" });
    expect(net.requests).toHaveLength(0);
    expect(clock.pending()).toBe(1);
    clock.fire();
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]?.url).toBe("/api/sessions/s-1/events");
    expect(sent(0).map((e) => e.frameSeq)).toEqual([1, 2]);
    net.next().resolve(ok(2));
    await tick();
    expect(emitter.status()).toEqual({ state: "idle" });
  });

  it("keeps a single request in flight and sends what queued meanwhile right after, in order", async () => {
    const { emitter, clock, net, sent } = setup();
    emitter.emit({ kind: "navigate" });
    clock.fire();
    emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" });
    emitter.emit({ kind: "open_case", caseId: "NS-2026-0102" });
    clock.fire();
    expect(net.requests).toHaveLength(1);
    net.next().resolve(ok(1));
    await tick();
    expect(net.requests).toHaveLength(2);
    expect(sent(1).map((e) => e.frameSeq)).toEqual([2, 3]);
  });

  it("splits large queues into contract-sized batches", async () => {
    const { emitter, net, sent } = setup();
    for (let i = 0; i < MAX_BATCH + 5; i += 1) emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" });
    const flushed = emitter.flush();
    expect(sent(0)).toHaveLength(MAX_BATCH);
    net.next().resolve(ok(MAX_BATCH));
    await tick();
    expect(sent(1).map((e) => e.frameSeq)).toEqual([51, 52, 53, 54, 55]);
    net.next().resolve(ok(5));
    await expect(flushed).resolves.toBeUndefined();
  });

  it("flush sends immediately and resolves only once earlier events are delivered", async () => {
    const { emitter, clock, net } = setup();
    emitter.emit({ kind: "navigate" });
    let done = false;
    const flushed = emitter.flush().then(() => (done = true));
    expect(clock.pending()).toBe(0);
    expect(net.requests).toHaveLength(1);
    await tick();
    expect(done).toBe(false);
    net.next().resolve(ok(1));
    await flushed;
    expect(done).toBe(true);
    await expect(emitter.flush()).resolves.toBeUndefined();
    expect(net.requests).toHaveLength(1);
  });

  it.each(["stale_epoch", "stale_frame", "off_record"])("stops for good on 409 %s: no retry, visible error", async (code) => {
    const { emitter, net, statuses } = setup();
    emitter.emit({ kind: "navigate" });
    const flushed = emitter.flush();
    net.next().resolve(jsonResponse({ error: code, detail: "refused" }, 409));
    await expect(flushed).rejects.toMatchObject({ status: 409, code });
    const status = emitter.status();
    expect(status.state).toBe("stopped");
    expect(statuses.at(-1)).toEqual(status);
    expect(emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" })).toBeUndefined();
    await expect(emitter.flush()).rejects.toBeInstanceOf(ApiError);
    expect(net.requests).toHaveLength(1);
  });

  it("keeps events after a network failure and resends the same frames on the next flush", async () => {
    const { emitter, net, sent } = setup();
    emitter.emit({ kind: "navigate" });
    const first = emitter.flush();
    net.next().reject(new TypeError("Failed to fetch"));
    await expect(first).rejects.toMatchObject({ kind: "network" });
    expect(emitter.status()).toMatchObject({ state: "retryable_error", pending: 1 });
    const second = emitter.flush();
    expect(sent(1)).toEqual(sent(0));
    net.next().resolve(ok(1));
    await expect(second).resolves.toBeUndefined();
    expect(emitter.status()).toEqual({ state: "idle" });
  });

  it("treats a 5xx as retryable and a malformed success body as final", async () => {
    const a = setup();
    a.emitter.emit({ kind: "navigate" });
    const failed = a.emitter.flush();
    a.net.next().resolve(jsonResponse({ error: "internal_error" }, 500));
    await expect(failed).rejects.toMatchObject({ status: 500 });
    expect(a.emitter.status().state).toBe("retryable_error");

    const b = setup();
    b.emitter.emit({ kind: "navigate" });
    const invalid = b.emitter.flush();
    b.net.next().resolve(jsonResponse({ ok: true }));
    await expect(invalid).rejects.toMatchObject({ kind: "invalid_response" });
    expect(b.emitter.status().state).toBe("stopped");
  });

  it("dispose cancels the idle timer and rejects pending flushes", async () => {
    const { emitter, clock } = setup();
    emitter.emit({ kind: "navigate" });
    emitter.emit({ kind: "navigate" });
    const flushed = emitter.flush();
    emitter.dispose();
    expect(clock.pending()).toBe(0);
    await expect(flushed).rejects.toMatchObject({ code: "channel_closed" });
  });
});
