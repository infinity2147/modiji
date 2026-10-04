import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { evaluate, FixtureSchema } from "../src/evaluation";
import { screenProfile } from "../src/extraction";
import { contentRect, createRgba } from "../src/image";
import { createVirtualClock, replaySession } from "../src/replay";
import { createFakeExtractor, type FakeNoise } from "../scripts/fake-extractor";
import { decodePng, encodePng } from "../src/png";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures/synthetic-kyc");
const fixture = FixtureSchema.parse(JSON.parse(readFileSync(join(FIXTURE_DIR, "fixture.json"), "utf8")));
const profile = screenProfile(KYC_DOMAIN, ["riskRating"]);
const frames = fixture.frames.map((f) => ({ captureTime: f.captureTime, load: () => decodePng(readFileSync(join(FIXTURE_DIR, f.file))) }));

async function run(seed: number, noise?: FakeNoise) {
  const start = fixture.frames[0]?.captureTime ?? 0;
  const clock = createVirtualClock(start);
  const extract = createFakeExtractor({ domain: KYC_DOMAIN, profile, domEvents: fixture.domEvents, clock, seed, ...(noise && { noise }) });
  const result = await clock.run(() => replaySession({ domain: KYC_DOMAIN, profile, sessionEpoch: fixture.sessionEpoch, frames, extract, clock }));
  const report = evaluate({ domain: KYC_DOMAIN, domEvents: fixture.domEvents, vision: result.observations, frameToEventMs: result.queue.frameToApplyMs });
  return { result, report };
}

describe("virtual clock", () => {
  it("runs sleepers in time order and advances now()", async () => {
    const clock = createVirtualClock(100);
    const log: string[] = [];
    const value = await clock.run(async () => {
      await Promise.all([
        clock.sleepUntil(300).then(() => log.push(`b@${clock.now()}`)),
        clock.sleepUntil(200).then(() => log.push(`a@${clock.now()}`)),
        clock.sleepUntil(50).then(() => log.push(`past@${clock.now()}`)),
      ]);
      return "done";
    });
    expect(value).toBe("done");
    expect(log).toEqual(["past@100", "a@200", "b@300"]);
  });

  it("reports a deadlock instead of hanging", async () => {
    const clock = createVirtualClock(0);
    await expect(clock.run(() => new Promise<never>(() => undefined))).rejects.toThrow("deadlock");
  });
});

describe("fixture replay through the real pipeline (fake extractor)", () => {
  it("with no noise and constant latency, scores perfectly and measures the queue's latency exactly", async () => {
    const { result, report } = await run(1, {
      missRate: 0,
      spuriousRate: 0,
      latency: { baseMs: 600, jitterMs: 0, slowRate: 0, slowMs: 0 },
    });
    // One changed frame per DOM event; the ±1 noise between them is ignored by the detector.
    expect(result.frames).toEqual({ total: 48, changed: fixture.domEvents.length });
    expect(result.errors).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.criticalFieldChangeRecall.value).toBe(1);
    expect(report.criticalActionRecall.value).toBe(1);
    expect(report.falseCriticalRate.value).toBe(0);
    expect(report.nonCritical.f1).toBe(1);
    // Every frame takes exactly 600 ms, except the 7 s burst: the action frame (6.75 s) holds the slot until 7.35 s,
    // so the navigate frame (7.25 s) waits 100 ms and the open_case frame (7.75 s) waits for it until 7.95 s.
    const n = fixture.domEvents.length;
    expect([...result.queue.frameToApplyMs].sort((a, b) => a - b)).toEqual([...Array<number>(n - 2).fill(600), 700, 800]);
    expect(result.queue).toMatchObject({ inFlight: 0, staleDropped: 0, failed: 0 });
  });

  it("is deterministic for a seed, and injected noise shows up in the metrics", async () => {
    const heavy: FakeNoise = { missRate: 0.4, spuriousRate: 0.4, latency: { baseMs: 700, jitterMs: 800, slowRate: 0.2, slowMs: 1500 } };
    const a = await run(2, heavy);
    const b = await run(2, heavy);
    expect(b.report).toEqual(a.report);
    expect(b.result.queue).toEqual(a.result.queue);
    expect((a.report.criticalFieldChangeRecall.value ?? 1) * (a.report.criticalActionRecall.value ?? 1)).toBeLessThan(1);
    expect(a.report.falseCriticalRate.value).toBeGreaterThan(0);
    expect(a.report.pass).toBe(false);
  });

  it("coalesces when changes arrive faster than requests complete", async () => {
    const { result } = await run(3, { missRate: 0, spuriousRate: 0, latency: { baseMs: 1400, jitterMs: 0, slowRate: 0, slowMs: 0 } });
    expect(result.queue.coalesced).toBeGreaterThan(0);
    expect(result.queue.sent + result.queue.coalesced).toBe(result.queue.submitted);
  });
});

describe("png codec", () => {
  it("round-trips RGBA", () => {
    const img = createRgba(7, 5);
    for (let i = 0; i < img.data.length; i += 1) img.data[i] = (i * 31) % 256;
    expect(decodePng(encodePng(img))).toEqual(img);
  });
});

describe("contentRect", () => {
  it("trims uniform margins on each edge to that edge's own colour, never to nothing", () => {
    const img = createRgba(40, 30);
    for (let i = 0; i < img.data.length; i += 4) img.data.set([240, 240, 240, 255], i);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 40; x += 1) img.data.set([20, 20, 20, 255], (y * 40 + x) * 4); // dark header band
    img.data.set([0, 0, 0, 255], (12 * 40 + 30) * 4); // one dark pixel of content
    img.data.set([0, 0, 0, 255], (8 * 40 + 2) * 4); // and another
    // Rows 0–4 are the header (its colour is the top-left pixel): trimmed. Below row 12 and around the content: blank.
    expect(contentRect(img)).toEqual({ x: 2, y: 5, width: 29, height: 8 });
    const blank = createRgba(4, 3);
    expect(contentRect(blank)).toMatchObject({ width: 1, height: 1 });
  });
});
