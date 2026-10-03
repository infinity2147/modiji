import { describe, expect, it } from "vitest";
import { createPrivacyController, privacyFromLedger, privacyServer, type PrivacyBase } from "../../lib/client/voice/privacy";
import { createDomEventEmitter } from "../../lib/client/dom-events";
import { controlledFetch, jsonResponse, scriptedFetch, tick } from "./fake-fetch";
import { entry } from "./interview-support";

function sequenced() {
  const log: string[] = [];
  let resolveTransition: (state: PrivacyBase) => void = () => {};
  let rejectTransition: (error: unknown) => void = () => {};
  let server: PrivacyBase = { offRecord: false, epoch: 3 };
  const controller = createPrivacyController({
    initial: { offRecord: false, epoch: 3 },
    setMicMuted: (muted) => log.push(muted ? "mute" : "unmute"),
    transition: (offRecord) => {
      log.push(`fetch:${offRecord ? "off" : "on"}`);
      return new Promise<PrivacyBase>((resolve, reject) => {
        resolveTransition = resolve;
        rejectTransition = reject;
      });
    },
    readServerState: async () => {
      log.push("read-ledger");
      return server;
    },
  });
  controller.subscribe((s) => log.push(`state:${s.offRecord ? "off" : "on"}${s.pending ? ":pending" : ""}:${s.epoch}`));
  return {
    controller,
    log,
    resolve: (s: PrivacyBase) => resolveTransition(s),
    reject: (e: unknown) => rejectTransition(e),
    setServer: (s: PrivacyBase) => (server = s),
  };
}

describe("off-record sequencing", () => {
  it("mutes the microphone and stops capture before any network call; resumes server-first, then unmutes", async () => {
    const { controller, log, resolve } = sequenced();
    const off = controller.goOffRecord();
    // Synchronously, inside the click: mute, then every subscriber, then the request.
    expect(log).toEqual(["mute", "state:off:pending:3", "fetch:off"]);
    resolve({ offRecord: true, epoch: 4 });
    await off;
    expect(controller.state()).toEqual({ offRecord: true, epoch: 4, pending: false, error: undefined });

    log.length = 0;
    const on = controller.resume();
    expect(log).toEqual(["state:off:pending:4", "fetch:on"]);
    resolve({ offRecord: false, epoch: 5 });
    await on;
    expect(log).toEqual(["state:off:pending:4", "fetch:on", "state:on:5", "unmute"]);
  });

  it("fails closed: if the server cannot be reached the client stays off the record, muted", async () => {
    const { controller, log, reject } = sequenced();
    const off = controller.goOffRecord();
    reject(new Error("offline"));
    await off;
    expect(controller.state()).toMatchObject({ offRecord: true, pending: false, error: "offline" });
    expect(log).not.toContain("unmute");
  });

  it("adopts the server's state when the request failed but the transition was applied", async () => {
    const { controller, reject, setServer } = sequenced();
    setServer({ offRecord: true, epoch: 4 });
    const off = controller.goOffRecord();
    reject(new Error("response lost"));
    await off;
    expect(controller.state()).toEqual({ offRecord: true, epoch: 4, pending: false, error: undefined });
  });

  it("does not unmute when resuming fails", async () => {
    const { controller, log, resolve, reject, setServer } = sequenced();
    const off = controller.goOffRecord();
    resolve({ offRecord: true, epoch: 4 });
    await off;
    setServer({ offRecord: true, epoch: 4 });
    const setServerOff = controller.resume();
    reject(new Error("offline"));
    await setServerOff;
    expect(controller.state().offRecord).toBe(true);
    expect(log).not.toContain("unmute");
  });

  it("talks to the contract's off-record route and reads the ledger back on failure", async () => {
    const net = scriptedFetch((url, body) => {
      if (url.endsWith("/off-record"))
        return jsonResponse({ offRecord: (body as { offRecord: boolean }).offRecord, privacyEpoch: 6, contextVersion: 9 });
      return jsonResponse({ entries: [] });
    });
    const server = privacyServer(net.fetch, "s-1");
    await expect(server.transition(true)).resolves.toEqual({ offRecord: true, epoch: 6 });
    expect(net.requests[0]).toMatchObject({ url: "/api/sessions/s-1/off-record", method: "POST", body: { offRecord: true } });
    await expect(server.readServerState()).resolves.toEqual({ offRecord: false, epoch: 0 });
  });
});

describe("privacy state from the ledger", () => {
  it("is the last transition, with the highest epoch", () => {
    const started = entry("session.started", "engine", {}, { privacyEpoch: 0 });
    const off = entry("privacy.off_record", "system_control", { offRecord: true, privacyEpoch: 1 }, { privacyEpoch: 1 });
    const on = entry("privacy.on_record", "system_control", { offRecord: false, privacyEpoch: 2 }, { privacyEpoch: 2 });
    expect(privacyFromLedger([started])).toEqual({ offRecord: false, epoch: 0 });
    expect(privacyFromLedger([started, off])).toEqual({ offRecord: true, epoch: 1 });
    expect(privacyFromLedger([started, off, on])).toEqual({ offRecord: false, epoch: 2 });
  });
});

describe("DOM channel off the record", () => {
  const timers = { set: (fn: () => void) => setTimeout(fn, 0), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };

  it("drops queued events, ignores new ones, and stamps events after resume with the new epoch", async () => {
    const net = controlledFetch();
    let ids = 0;
    const emitter = createDomEventEmitter({
      sessionId: "s-1",
      sessionEpoch: 3,
      lastFrameSeq: 0,
      fetch: net.fetch,
      newId: () => `e-${++ids}`,
      timers,
    });
    emitter.emit({ kind: "navigate" });
    await tick();
    expect(net.requests).toHaveLength(1);
    emitter.emit({ kind: "open_case", caseId: "NS-2026-0101" });

    emitter.suspend();
    expect(emitter.status()).toEqual({ state: "paused" });
    expect(emitter.emit({ kind: "open_case", caseId: "NS-2026-0102" })).toBeUndefined();
    await expect(emitter.flush()).rejects.toMatchObject({ code: "off_record" });
    // The batch in flight was refused because the session went off the record: discarded, not fatal.
    net.next().resolve(jsonResponse({ error: "off_record" }, 409));
    await tick();
    expect(emitter.status()).toEqual({ state: "paused" });

    emitter.resume(4);
    const after = emitter.emit({ kind: "open_case", caseId: "NS-2026-0103" });
    // The refused emit did not consume a frame number; the dropped one did.
    expect(after).toMatchObject({ sessionEpoch: 4, frameSeq: 3 });
    await tick();
    expect(net.requests).toHaveLength(2);
    expect((net.requests[1]?.body as { events: { sessionEpoch: number; caseId?: string }[] }).events).toEqual([
      expect.objectContaining({ sessionEpoch: 4, caseId: "NS-2026-0103" }),
    ]);
    net.next().resolve(jsonResponse({ ledgerIds: ["l-1"] }));
    await tick();
    expect(emitter.status()).toEqual({ state: "idle" });
    await expect(emitter.flush()).resolves.toBeUndefined();
  });

  it("discards a stale-epoch refusal that lands after resuming, keeping the channel alive", async () => {
    const net = controlledFetch();
    const emitter = createDomEventEmitter({ sessionId: "s-1", sessionEpoch: 3, lastFrameSeq: 0, fetch: net.fetch, timers });
    emitter.emit({ kind: "navigate" });
    await tick();
    emitter.suspend();
    emitter.resume(5);
    net.next().resolve(jsonResponse({ error: "stale_epoch" }, 409));
    await tick();
    expect(emitter.status()).toEqual({ state: "idle" });
    expect(emitter.emit({ kind: "navigate" })).toMatchObject({ sessionEpoch: 5 });
  });
});
