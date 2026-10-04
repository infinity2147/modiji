import { describe, expect, it } from "vitest";
import { LEVEL_POLL_MS, speechBandLevelDb, startLocalSpeechSensor } from "../../lib/client/voice/local-speech";
import { manualClock } from "./interview-support";

/** The SDK's 1024-bin voice-range spectrum with `low` in the speech band (lower half) and `high` above it. */
const spectrum = (low: number, high = low): Uint8Array => {
  const bins = new Uint8Array(1024);
  bins.fill(low, 0, 512);
  bins.fill(high, 512);
  return bins;
};

describe("local speech sensor (browser)", () => {
  it("measures the speech band only: hiss above ~4 kHz does not count", () => {
    expect(speechBandLevelDb(spectrum(40, 255))).toBeCloseTo(speechBandLevelDb(spectrum(40, 0)), 6);
    expect(speechBandLevelDb(spectrum(160))).toBeGreaterThan(speechBandLevelDb(spectrum(40)) + 30);
    expect(speechBandLevelDb(new Uint8Array(0))).toBe(-100);
  });

  it("polls the conversation's analyser every 20 ms, reports onset within ~3 reads and the end after the hangover", () => {
    const time = manualClock();
    let current = spectrum(40); // a quiet room
    const changes: [number, boolean][] = [];
    const start = time.now();
    const sensor = startLocalSpeechSensor({ readSpectrum: () => current, clock: time.clock, onChange: (speaking) => changes.push([time.now() - start, speaking]) });
    time.advance(2000);
    expect(changes).toEqual([]);
    current = spectrum(110); // ≈ +27 dB: the expert starts speaking at 2000 ms
    time.advance(1000);
    const onset = changes[0];
    expect(onset?.[1]).toBe(true);
    expect(onset![0] - 2000).toBeLessThanOrEqual(3 * LEVEL_POLL_MS);
    current = spectrum(40);
    time.advance(1000);
    expect(changes.map(([, speaking]) => speaking)).toEqual([true, false]);
    expect(changes[1]![0] - 3000).toBeGreaterThanOrEqual(300);
    sensor.stop();
    time.advance(1000);
    expect(changes).toHaveLength(2);
  });

  it("stopping while speech is heard reports its end", () => {
    const time = manualClock();
    let current = spectrum(40);
    const changes: boolean[] = [];
    const sensor = startLocalSpeechSensor({ readSpectrum: () => current, clock: time.clock, onChange: (speaking) => changes.push(speaking) });
    time.advance(500);
    current = spectrum(120);
    time.advance(200);
    sensor.stop();
    sensor.stop();
    expect(changes).toEqual([true, false]);
  });
});
