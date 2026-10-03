import { describe, expect, it } from "vitest";
import { createPerceptionQueue, createStateApplier, type PerceptionFrame } from "../src/queue";

/** A request the test resolves or rejects by hand. */
type Pending = { frame: PerceptionFrame<string>; signal: AbortSignal; resolve: (r: string) => void; reject: (e: unknown) => void };

function harness(options: { epoch?: number; lastFrameSeq?: number } = {}) {
  let time = 1000;
  const requests: Pending[] = [];
  const applied: Array<{ result: string; frameSeq: number }> = [];
  const errors: unknown[] = [];
  let maxConcurrent = 0;
  let concurrent = 0;
  const queue = createPerceptionQueue<string, string>({
    epoch: options.epoch ?? 0,
    ...(options.lastFrameSeq !== undefined && { lastFrameSeq: options.lastFrameSeq }),
    now: () => time,
    send: (frame, signal) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise<string>((resolve, reject) => {
        requests.push({
          frame,
          signal,
          resolve: (r) => {
            concurrent -= 1;
            resolve(r);
          },
          reject: (e) => {
            concurrent -= 1;
            reject(e);
          },
        });
      });
    },
    apply: (result, frame) => applied.push({ result, frameSeq: frame.frameSeq }),
    onError: (error) => errors.push(error),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    queue,
    requests,
    applied,
    errors,
    flush,
    maxConcurrent: () => maxConcurrent,
    advance: (ms: number) => (time += ms),
    at: () => time,
  };
}

describe("perception queue", () => {
  it("assigns monotonic frameSeq starting after lastFrameSeq", () => {
    const h = harness({ lastFrameSeq: 41 });
    expect([h.queue.submit("a", 1, 0)?.frameSeq, h.queue.submit("b", 2, 0)?.frameSeq, h.queue.submit("c", 3, 0)?.frameSeq]).toEqual([
      42, 43, 44,
    ]);
  });

  it("keeps at most one request in flight", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) h.queue.submit(`f${i}`, i, 0);
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.queue.stats().inFlight).toBe(1);
    h.requests[0]?.resolve("r0");
    await h.flush();
    expect(h.requests).toHaveLength(2);
    h.requests[1]?.resolve("r1");
    await h.flush();
    expect(h.maxConcurrent()).toBe(1);
    expect(h.queue.stats().inFlight).toBe(0);
  });

  it("coalesces waiting frames to the newest and counts the drops", async () => {
    const h = harness();
    h.queue.submit("first", 1, 0);
    await h.flush();
    h.queue.submit("old-1", 2, 0);
    h.queue.submit("old-2", 3, 0);
    h.queue.submit("newest", 4, 0);
    expect(h.queue.stats()).toMatchObject({ coalesced: 2, pendingFrameSeq: 4 });
    h.requests[0]?.resolve("r1");
    await h.flush();
    expect(h.requests.map((r) => r.frame.payload)).toEqual(["first", "newest"]);
    h.requests[1]?.resolve("r4");
    await h.queue.idle();
    expect(h.applied).toEqual([
      { result: "r1", frameSeq: 1 },
      { result: "r4", frameSeq: 4 },
    ]);
  });

  it("stale responses are never applied: a late answer for an older frameSeq is ignored", async () => {
    const h = harness();
    h.queue.submit("slow", 1, 0);
    await h.flush();
    // The slow request is cancelled (e.g. a reconnect) but its transport ignores the abort and answers later.
    h.queue.cancelAll();
    expect(h.requests[0]?.signal.aborted).toBe(true);
    h.queue.submit("fresh", 2, 0);
    await h.flush();
    expect(h.requests).toHaveLength(1); // still one in flight: the slot frees only when the old request settles
    h.requests[0]?.resolve("late answer for frame 1");
    await h.flush();
    h.requests[1]?.resolve("answer for frame 2");
    await h.queue.idle();
    expect(h.applied).toEqual([{ result: "answer for frame 2", frameSeq: 2 }]);
    expect(h.queue.stats()).toMatchObject({ applied: 1, staleDropped: 1, cancelled: 0 });
  });

  it("state applier ignores out-of-order and stale-epoch results", () => {
    let epoch = 3;
    const applied: number[] = [];
    const applier = createStateApplier<string>({ currentEpoch: () => epoch, apply: (_r, f) => applied.push(f.frameSeq) });
    expect(applier.offer({ frameSeq: 5, epoch: 3 }, "five")).toBe(true);
    expect(applier.offer({ frameSeq: 4, epoch: 3 }, "four, resolved late")).toBe(false);
    expect(applier.offer({ frameSeq: 5, epoch: 3 }, "five again")).toBe(false);
    expect(applier.offer({ frameSeq: 7, epoch: 2 }, "old epoch")).toBe(false);
    epoch = 4;
    expect(applier.offer({ frameSeq: 6, epoch: 3 }, "captured before off-record")).toBe(false);
    expect(applier.offer({ frameSeq: 8, epoch: 4 }, "eight")).toBe(true);
    expect(applied).toEqual([5, 8]);
    expect(applier.lastApplied()).toBe(8);
  });

  it("epoch advance drops the pending frame, aborts the in-flight one and never applies it", async () => {
    const h = harness({ epoch: 0 });
    h.queue.submit("in flight", 1, 0);
    await h.flush();
    h.queue.submit("pending", 2, 0);
    h.queue.setEpoch(1);
    expect(h.requests[0]?.signal.aborted).toBe(true);
    expect(h.queue.stats()).toMatchObject({ cancelled: 1, pendingFrameSeq: null });
    h.requests[0]?.resolve("answer from epoch 0");
    await h.queue.idle();
    expect(h.applied).toEqual([]);
    expect(h.requests).toHaveLength(1); // the pending frame was never sent
    // Frames captured under the old epoch (e.g. still in the OCR pass) are refused at submit.
    expect(h.queue.submit("captured before", 3, 0)).toBeNull();
    expect(h.queue.stats().epochRejected).toBe(1);
    const resumed = h.queue.submit("after resume", 4, 1);
    expect(resumed?.frameSeq).toBe(3);
    await h.flush();
    h.requests[1]?.resolve("ok");
    await h.queue.idle();
    expect(h.applied).toEqual([{ result: "ok", frameSeq: 3 }]);
  });

  it("refuses an epoch that does not increase", () => {
    const h = harness({ epoch: 2 });
    expect(() => h.queue.setEpoch(2)).toThrow(RangeError);
    expect(() => h.queue.setEpoch(1)).toThrow(RangeError);
  });

  it("a cancelled request that rejects counts as stale, not failed; other rejections are reported", async () => {
    const h = harness();
    h.queue.submit("a", 1, 0);
    await h.flush();
    h.queue.cancelAll();
    h.requests[0]?.reject(new Error("aborted"));
    await h.queue.idle();
    h.queue.submit("b", 2, 0);
    await h.flush();
    h.requests[1]?.reject(new Error("HTTP 529"));
    await h.queue.idle();
    expect(h.queue.stats()).toMatchObject({ staleDropped: 1, failed: 1 });
    expect(h.errors).toHaveLength(1);
  });

  it("records frame→apply and request latency samples", async () => {
    const h = harness();
    const captured = h.at();
    h.advance(150); // detection + redaction before submit
    h.queue.submit("a", captured, 0);
    await h.flush();
    h.advance(900);
    h.requests[0]?.resolve("r");
    await h.queue.idle();
    expect(h.queue.stats()).toMatchObject({ frameToApplyMs: [1050], requestMs: [900], sent: 1, applied: 1 });
  });

  it("idle() resolves once nothing is pending or in flight", async () => {
    const h = harness();
    await h.queue.idle();
    h.queue.submit("a", 1, 0);
    let idle = false;
    void h.queue.idle().then(() => (idle = true));
    await h.flush();
    expect(idle).toBe(false);
    h.requests[0]?.resolve("r");
    await h.flush();
    expect(idle).toBe(true);
  });
});
