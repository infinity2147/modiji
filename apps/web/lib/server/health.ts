/** `GET /api/health/deep`: preflight's "DB and DATA_DIR writable · Z3 initialises" (plan §12), plus the model-call switch and event-loop / GC / CPU-throttle telemetry. */
import type { CpuThrottle, EventLoopDelay, GcStats } from "./event-loop";
import type { CheckResult, Runtime } from "./runtime";

export type DeepHealth = {
  ok: boolean;
  db: CheckResult;
  dataDir: CheckResult;
  z3: CheckResult;
  /** `LLM_CALLS` as this process runs it: preflight fails a target that reports `off` (no model calls). */
  llmCalls: "on" | "off";
  /** Event-loop delay since boot: preflight fails a target whose p99 is too high. */
  eventLoop: EventLoopDelay;
  /** GC pauses since boot: a long pause stalls handlers like the loop does — ops reads it to tell a GC/host freeze from a code stall. */
  gc: GcStats;
  /** CFS CPU-throttle counters when the cgroup exposes them, else null (host freeze indicator; PROGRESS.md). */
  cpuThrottle: CpuThrottle | null;
};

/** `ok` covers the probes only; `llmCalls`, `eventLoop`, `gc` and `cpuThrottle` are reported for preflight/ops to judge, never a reason for 503. */
export async function deepHealth(runtime: Pick<Runtime, "env" | "checks">): Promise<DeepHealth> {
  const { env, checks } = runtime;
  const db = checks.db();
  const [dataDir, z3] = await Promise.all([checks.dataDir(), checks.z3()]);
  return { ok: db.ok && dataDir.ok && z3.ok, db, dataDir, z3, llmCalls: env.LLM_CALLS, eventLoop: checks.eventLoop(), gc: checks.gc(), cpuThrottle: checks.cpuThrottle() };
}
