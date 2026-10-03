import { describe, expect, it } from "vitest";
import { AUTHORIZATION_LATENCY_BOUND_MS, GateInputSchema } from "../src/gate/index";
import { GATE_RUNS } from "../src/gate/scripts/gate-runs";
import { runScript } from "../src/gate/simulate";

/** Typical main-thread `setTimeout` lateness in a busy page. */
const TIMER_JITTER_MS = 20;

describe("P3 acceptance runs (simulation): 0 interruptions, authorization ≤ 250 ms after conditions valid", () => {
  it.each(GATE_RUNS.map((run) => [run.name, run] as const))("%s", (_name, run) => {
    for (const input of run.inputs) GateInputSchema.parse(input);
    const result = runScript(run.inputs, {}, { untilMs: run.untilMs, timerJitterMs: TIMER_JITTER_MS });
    console.info(
      `[gate] ${run.name}: ${result.authorizations.length} asked, ${result.interruptions} interruptions, ` +
        `latency p50/p95/max ${result.latency?.p50}/${result.latency?.p95}/${result.latency?.max} ms ` +
        `(at ${result.authorizations.map((a) => `${a.questionId}@${(a.at / 1000).toFixed(1)}s`).join(", ")})`,
    );
    expect(result.interruptions).toBe(0);
    expect(result.authorizations).toHaveLength(run.expectedAuthorizations);
    expect(result.latency?.max).toBeLessThanOrEqual(AUTHORIZATION_LATENCY_BOUND_MS);
  });

  it("are deterministic", () => {
    const run = GATE_RUNS[3]!;
    const opts = { untilMs: run.untilMs, timerJitterMs: TIMER_JITTER_MS };
    expect(runScript(run.inputs, {}, opts)).toEqual(runScript(run.inputs, {}, opts));
  });
});
