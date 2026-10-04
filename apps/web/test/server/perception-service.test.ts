import { afterEach, describe, expect, it } from "vitest";
import { ScreenEventSchema, parseLedgerPayload } from "@vashistha/core";
import { EnvError, createLedger, openDatabase } from "@vashistha/core/server";
import { PostFrameResponseSchema, VisionStateSchema } from "../../lib/contracts/frames";
import { createPerception } from "../../lib/server/perception/init";
import { prepareFrame, type FrameToRead } from "../../lib/server/perception/prepare";
import { toConceptPayload } from "../../lib/server/perception/service";
import { T0, domEvent } from "../support/casedesk-harness";
import {
  DOCUMENT_EXPIRY,
  caseReading,
  controlledExtractor,
  createPerceptionHarness,
  metadata,
  png,
  trainingCaseId,
  type PerceptionHarness,
} from "../support/perception-harness";

let h: PerceptionHarness | undefined;
afterEach(() => h?.cleanup());

async function setup() {
  const extractor = controlledExtractor();
  h = createPerceptionHarness({ run: extractor.run });
  const sessionId = await h.session("training");
  const harness = h;
  /** Posts a solid frame; a different `shade` from the previous frame is a whole-screen change (a full read). */
  const post = async (frameSeq: number, over: Parameters<typeof metadata>[0] = {}, shade = 200) => {
    const reply = await harness.postFrame(sessionId, { metadata: metadata({ frameSeq, captureTime: T0 + frameSeq * 500, ...over }), frame: png(undefined, undefined, shade) });
    if (reply.status !== 202) throw new Error(`frame ${frameSeq}: ${reply.status} ${JSON.stringify(reply.body)}`);
    return PostFrameResponseSchema.parse(reply.body);
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const vision = () => harness.ledger.list(sessionId, { sources: ["vision"] });
  const state = () => VisionStateSchema.parse(harness.perceptionDeps.perception.state(harness.ledger.getSession(sessionId) ?? { id: sessionId, privacyEpoch: 0, offRecord: false }));
  return { h: harness, sessionId, extractor, post, flush, vision, state };
}

describe("vision extraction → ledger", () => {
  it("appends validated vision screen events and proposed concepts with the frame entry as parent", async () => {
    const { h, sessionId, extractor, post, flush, vision, state } = await setup();
    const caseId = trainingCaseId();
    const frame = await post(1);
    expect(frame.vision).toMatchObject({ extraction: "available", inFlight: true });
    h.clock.now = T0 + 500 + 1200;
    // The first reading opens the case (its values are a baseline, never edits).
    extractor.calls[0]?.resolve(caseReading(caseId, "low"));
    await h.perceptionDeps.perception.idle(sessionId);
    await flush();
    const second = await post(2);
    h.clock.now = T0 + 1000 + 900;
    // The next whole-screen read of the opened case also proposes undefined concepts (once per case).
    extractor.calls[1]?.resolve(caseReading(caseId, "high", { concepts: [DOCUMENT_EXPIRY] }));
    await h.perceptionDeps.perception.idle(sessionId);

    const [opened, changed] = vision();
    expect(opened).toMatchObject({ kind: "screen.event", source: "vision", parentIds: [frame.ledgerId], occurredAt: T0 + 500, privacyEpoch: 0 });
    expect(ScreenEventSchema.parse(opened?.payload)).toMatchObject({ source: "vision", kind: "open_case", caseId, critical: false, frameSeq: 1 });
    expect(changed).toMatchObject({ parentIds: [second.ledgerId], occurredAt: T0 + 1000 });
    expect(ScreenEventSchema.parse(changed?.payload)).toMatchObject({ kind: "field_change", caseId, field: "riskRating", from: "low", to: "high", critical: true, frameSeq: 2 });

    const [concept] = h.ledger.list(sessionId, { kinds: ["concept.proposed"] });
    expect(concept).toMatchObject({ source: "engine", parentIds: [second.ledgerId] });
    expect(parseLedgerPayload(concept ?? { kind: "", source: "engine", payload: null }, "concept.proposed")).toEqual({
      name: "documentExpiry",
      label: "Document expiry",
      definition: "Whether an identity document has expired",
      type: "enum",
      values: ["expired"],
    });

    const s = state();
    expect(s).toMatchObject({ inFlight: false, lastAppliedFrameSeq: 2, lastError: null });
    expect(s.counts).toMatchObject({ received: 2, applied: 2, events: 2, concepts: 1, coalesced: 0, staleDropped: 0, failed: 0 });
    expect(s.latencyMs.captureToEvents).toEqual({ n: 2, p50: 900, p95: 1200 });
  });

  it("never overwrites DOM events: both channels are ledgered side by side with their source", async () => {
    const { h, sessionId, extractor, post, vision } = await setup();
    const caseId = trainingCaseId();
    await h.postEvents(sessionId, { events: [domEvent({ frameSeq: 1, kind: "open_case", caseId })] });
    await post(1);
    extractor.calls[0]?.resolve(caseReading(caseId, "low"));
    await h.perceptionDeps.perception.idle(sessionId);
    const events = h.ledger.list(sessionId, { kinds: ["screen.event"] });
    expect(events.map((e) => e.source)).toEqual(["dom", "vision"]);
    expect(vision()).toHaveLength(1);
  });

  it("passes the previous applied reading with the next frame; the decoded frame decides the read mode", async () => {
    const { h, sessionId, extractor, post } = await setup();
    const caseId = trainingCaseId();
    await post(1);
    expect(extractor.calls[0]).toMatchObject({ previous: null, mode: "refresh", images: 1 });
    extractor.calls[0]?.resolve(caseReading(caseId, "high"));
    await h.perceptionDeps.perception.idle(sessionId);
    const rect = { x: 10, y: 10, width: 40, height: 20 };
    // An identical frame: nothing measurably changed since the last reading, so the screen is re-read (refresh);
    // the frame is native-size, so the client's crop adds no resolution and is not sent to the model.
    await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 2, bbox: rect, crop: rect }), frame: png(), crop: png(40, 20) });
    // (and as the case's first whole-screen read after the one that opened it, it also asks for concepts: mode "full").
    expect(extractor.calls[1]).toMatchObject({ frameSeq: 2, mode: "full", images: 1, previous: { caseId, fields: { riskRating: "high" }, committed: null } });
    extractor.calls[1]?.resolve(caseReading(caseId, "high"));
    await h.perceptionDeps.perception.idle(sessionId);
    // A whole-screen change (which may show a newly opened case): a whole-screen read, concepts already asked.
    await post(3, {}, 90);
    expect(extractor.calls[2]).toMatchObject({ frameSeq: 3, mode: "refresh" });
  });

  it("records a failed extraction honestly and keeps processing later frames", async () => {
    const { h, sessionId, extractor, post, vision, state } = await setup();
    await post(1);
    extractor.calls[0]?.reject(new Error("upstream 529 overloaded"));
    await h.perceptionDeps.perception.idle(sessionId);
    expect(state()).toMatchObject({ lastError: "Error: upstream 529 overloaded", lastAppliedFrameSeq: null });
    expect(state().counts.failed).toBe(1);
    await post(2);
    extractor.calls[1]?.resolve(caseReading(trainingCaseId(), "low"));
    await h.perceptionDeps.perception.idle(sessionId);
    expect(vision()).toHaveLength(1);
    expect(state().lastAppliedFrameSeq).toBe(2);
  });
});

describe("ordering, coalescing and staleness (code decides, never the model)", () => {
  it("keeps one extraction in flight and, meanwhile, only the newest waiting frame", async () => {
    const { h, sessionId, extractor, post, state } = await setup();
    await post(1);
    await post(2);
    await post(3);
    const last = await post(4);
    expect(last.vision).toMatchObject({ inFlight: true, pendingFrameSeq: 4 });
    expect(extractor.calls.map((c) => c.frameSeq)).toEqual([1]);

    extractor.calls[0]?.resolve(caseReading(trainingCaseId(), "low"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(extractor.calls.map((c) => c.frameSeq)).toEqual([1, 4]);
    extractor.calls[1]?.resolve(caseReading(trainingCaseId(), "low"));
    await h.perceptionDeps.perception.idle(sessionId);
    expect(state().counts).toMatchObject({ received: 4, applied: 2, coalesced: 2 });
    expect(state().lastAppliedFrameSeq).toBe(4);
  });

  it("never applies an older frame over a newer one when uploads are stored out of order", async () => {
    const { h, sessionId, extractor, vision, state } = await setup();
    const service = h.perceptionDeps.perception;
    const [root] = h.ledger.list(sessionId, { kinds: ["session.started"] });
    const job = (frameSeq: number) => {
      const entry = h.ledger.append({
        sessionId,
        source: "client",
        kind: "frame.received",
        occurredAt: T0 + frameSeq,
        traceId: `trace-${frameSeq}`,
        parentIds: [root?.id ?? ""],
        schemaVersion: 1,
        privacyEpoch: 0,
        payload: { frameId: `f${frameSeq}`, frameSeq, captureTime: T0 + frameSeq, width: 160, height: 100, mediaPath: "x", redactedRegions: 0, changeScore: 1 },
      });
      return {
        sessionId,
        ledgerId: entry.id,
        traceId: entry.traceId,
        frameSeq,
        captureTime: T0 + frameSeq,
        receivedAt: T0 + frameSeq,
        epoch: 0,
        frame: { base64Png: png().toString("base64"), width: 160, height: 100, sourceWidth: 160, sourceHeight: 100 },
        crop: null,
      };
    };
    // Frame 6 finished storing first and is being extracted; frame 5 (older) arrives afterwards.
    service.submit(job(6));
    service.submit(job(5));
    // While 6 is in flight, 8 waits; 7 (older than the waiting frame) must not replace it.
    service.submit(job(8));
    service.submit(job(7));
    expect(state().pendingFrameSeq).toBe(8);
    await new Promise((resolve) => setTimeout(resolve, 0));

    extractor.calls[0]?.resolve(caseReading(trainingCaseId(), "low"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    extractor.calls[1]?.resolve(caseReading(trainingCaseId(), "low"));
    await service.idle(sessionId);

    expect(extractor.calls.map((c) => c.frameSeq)).toEqual([6, 8]);
    expect(vision().map((e) => (e.payload as { frameSeq: number }).frameSeq)).toEqual([6]);
    expect(state()).toMatchObject({ lastAppliedFrameSeq: 8 });
    expect(state().counts).toMatchObject({ staleDropped: 2, applied: 2 });
  });

  it("drops a result that completes after the session went off the record, even without the hook", async () => {
    const { h, sessionId, extractor, post, vision, state } = await setup();
    await post(1);
    h.ledger.setOffRecord(sessionId, true, { occurredAt: T0, traceId: "t" });
    extractor.calls[0]?.resolve(caseReading(trainingCaseId(), "low"));
    await h.perceptionDeps.perception.idle(sessionId);
    expect(vision()).toEqual([]);
    expect(h.ledger.list(sessionId, { kinds: ["concept.proposed"] })).toEqual([]);
    expect(state().counts).toMatchObject({ staleDropped: 1, applied: 0 });
  });

  it("the off-record hook abandons in-flight work; after resuming, the new epoch's frame is applied", async () => {
    const { h, sessionId, extractor, post, vision, state } = await setup();
    await post(1);
    await post(2); // waiting behind frame 1
    h.ledger.setOffRecord(sessionId, true, { occurredAt: T0, traceId: "t" });
    h.perceptionDeps.perception.cancel(sessionId, 1);
    expect(state()).toMatchObject({ pendingFrameSeq: null, offRecord: true });
    h.ledger.setOffRecord(sessionId, false, { occurredAt: T0, traceId: "t" });
    await post(3, { privacyEpoch: 2 });

    // Frame 1's extraction completes late (and out of order with respect to the epochs): never applied.
    extractor.calls[0]?.resolve(caseReading(trainingCaseId(), "low"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(extractor.calls.map((c) => c.frameSeq)).toEqual([1, 3]);
    extractor.calls[1]?.resolve(caseReading(trainingCaseId(), "low"));
    await h.perceptionDeps.perception.idle(sessionId);

    expect(vision().map((e) => [(e.payload as { frameSeq: number }).frameSeq, e.privacyEpoch])).toEqual([[3, 2]]);
    expect(state().counts).toMatchObject({ staleDropped: 2, applied: 1 });
  });
});

describe("proposed concepts", () => {
  it("are asked for once per opened case and proposed once per name per session, including names already in the ledger", async () => {
    const { h, sessionId, extractor, post } = await setup();
    const caseId = trainingCaseId();
    /** Posts a frame and answers it with what the screen shows; returns the read mode that was asked for. */
    const show = async (calls: typeof extractor.calls, frameSeq: number, shade: number, screen: Parameters<(typeof calls)[number]["resolve"]>[0]) => {
      await post(frameSeq, {}, shade);
      const call = calls.at(-1);
      call?.resolve(screen);
      await h.perceptionDeps.perception.idle(sessionId);
      return call?.mode;
    };
    const names = () => h.ledger.list(sessionId, { kinds: ["concept.proposed"] }).map((e) => (e.payload as { name: string }).name);
    // The frame that opens a case never asks for concepts; the next whole-screen read of that case does, once.
    expect(await show(extractor.calls, 1, 200, caseReading(caseId, "low"))).toBe("refresh");
    expect(await show(extractor.calls, 2, 200, caseReading(caseId, "low", { concepts: [DOCUMENT_EXPIRY] }))).toBe("full");
    expect(await show(extractor.calls, 3, 200, caseReading(caseId, "low"))).toBe("refresh");
    // Another case opens: its concepts count, except a name already proposed (any casing).
    expect(await show(extractor.calls, 4, 90, caseReading("NS-2026-0102", "low"))).toBe("refresh");
    const other = [
      { name: "DocumentExpiry", description: "same concept, other casing", observedValue: null },
      { name: "pepRelative", description: "A relative of a politically exposed person", observedValue: "yes" },
    ];
    expect(await show(extractor.calls, 5, 90, caseReading("NS-2026-0102", "low", { concepts: other }))).toBe("full");
    expect(names()).toEqual(["documentExpiry", "pepRelative"]);

    // After a restart the dedupe set is rebuilt from the ledger.
    const restarted = controlledExtractor();
    h.restartPerception({ run: restarted.run });
    await show(restarted.calls, 6, 200, caseReading(caseId, "low"));
    expect(await show(restarted.calls, 7, 200, caseReading(caseId, "low", { concepts: [DOCUMENT_EXPIRY] }))).toBe("full");
    expect(names()).toEqual(["documentExpiry", "pepRelative"]);
  });

  it("maps the observed value to a proposal type and refuses empty definitions", () => {
    expect(toConceptPayload({ name: "pepRelative", description: "d", observedValue: "Yes" })?.type).toBe("boolean");
    expect(toConceptPayload({ name: "openAlerts", description: "d", observedValue: "1,204" })?.type).toBe("number");
    expect(toConceptPayload({ name: "docState", description: "d", observedValue: null })).toEqual({
      name: "docState",
      label: "Doc state",
      definition: "d",
      type: "enum",
    });
    expect(toConceptPayload({ name: "x", description: "  ", observedValue: null })).toBeNull();
  });
});

describe("composition: when is extraction available?", () => {
  const ledger = () => createLedger(openDatabase({ memory: true }).db);
  const prepare = async (input: FrameToRead) => prepareFrame(input);

  it("is unavailable without a model (no_api_key) or when switched off (disabled)", () => {
    const session = { id: "s", privacyEpoch: 0, offRecord: false };
    expect(createPerception({ source: {}, ledger: ledger(), claude: null, prepare }).state(session)).toMatchObject({
      extraction: "unavailable",
      unavailableReason: "no_api_key",
    });
    const claude = { structured: () => Promise.reject(new Error("unused")), text: () => Promise.reject(new Error("unused")) };
    expect(createPerception({ source: { VISION_EXTRACTION: "off" }, ledger: ledger(), claude, prepare }).state(session)).toMatchObject({
      extraction: "unavailable",
      unavailableReason: "disabled",
    });
    expect(createPerception({ source: {}, ledger: ledger(), claude, prepare }).state(session)).toMatchObject({
      extraction: "available",
      unavailableReason: null,
    });
    expect(() => createPerception({ source: { VISION_EXTRACTION: "maybe" }, ledger: ledger(), claude, prepare })).toThrow(EnvError);
  });
});
