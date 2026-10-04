import { describe, expect, it } from "vitest";
import { AUTHORIZATION_LATENCY_BOUND_MS, GateInputSchema } from "../src/gate/index";
import { GATE_RUNS, RUN_D_REPRODUCTION, type GateRun } from "../src/gate/scripts/gate-runs";
import { runScript, type SimOptions } from "../src/gate/simulate";

/** Typical main-thread `setTimeout` lateness in a busy page. */
const TIMER_JITTER_MS = 20;
/** Live `gate/authorize` round trips: p50 ≈ 270 ms, a few seconds under server stalls. */
const ROUND_TRIPS_MS = [0, 270, 2640];

const simulate = (run: GateRun, opts: SimOptions = {}) =>
  runScript(run.inputs, {}, { untilMs: run.untilMs, timerJitterMs: TIMER_JITTER_MS, speech: run.speech, ...opts });

const at = (result: Awaited<ReturnType<typeof simulate>>) =>
  result.authorizations.map((a) => `${a.questionId}@${(a.at / 1000).toFixed(1)}s`).join(", ");

describe("P3 acceptance runs (simulation): 0 interruptions, authorization ≤ 250 ms after conditions valid", () => {
  it.each([...GATE_RUNS, RUN_D_REPRODUCTION].flatMap((run) => ROUND_TRIPS_MS.map((rtt) => [run.name, rtt, run] as const)))(
    "%s (round trip %i ms)",
    async (_name, rtt, run) => {
      for (const input of run.inputs) GateInputSchema.parse(input);
      const result = await simulate(run, { issueLatencyMs: rtt });
      console.info(
        `[gate] ${run.name} (rtt ${rtt} ms): ${result.authorizations.length} asked, ${result.interruptions} interruptions, ` +
          `${result.withdrawn} withdrawn, decision latency p50/p95/max ${result.latency?.p50}/${result.latency?.p95}/${result.latency?.max} ms (at ${at(result)})`,
      );
      expect(result.interruptions).toBe(0);
      // A multi-second round trip may outlast the silence: the authorization then arrives into speech and is withdrawn.
      if (rtt <= 270) expect(result.authorizations).toHaveLength(run.expectedAuthorizations);
      else expect(result.authorizations.length).toBeGreaterThanOrEqual(1);
      expect(result.latency?.max).toBeLessThanOrEqual(AUTHORIZATION_LATENCY_BOUND_MS);
    },
  );

  it("are deterministic", async () => {
    const run = GATE_RUNS[3]!;
    expect(await simulate(run)).toEqual(await simulate(run));
  });

  it("the run D reproduction is faithful: without the local microphone detector it interrupts, as live run D did", async () => {
    const vadOnly = { ...RUN_D_REPRODUCTION, inputs: RUN_D_REPRODUCTION.inputs.filter((i) => i.kind !== "local_speech") };
    const result = await simulate(vadOnly);
    console.info(`[gate] run D reproduction without local_speech: ${result.interruptions} interruptions (at ${at(result)})`);
    expect(result.interruptions).toBeGreaterThanOrEqual(1);
  });
});
