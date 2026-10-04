/** `GET /api/health/deep`: preflight's "DB and DATA_DIR writable · Z3 initialises" (plan §12), plus the model-call switch and event-loop / GC / CPU-throttle telemetry. */
import { volumeStats, type VolumeStats } from "./disk";
import type { CpuThrottle, EventLoopDelay, GcStats } from "./event-loop";
import type { FrameStoreStats, ProbeResult } from "./perception/frame-store";
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
  /** Capacity of the volume holding DATA_DIR, or null when the platform cannot say: a full volume fails every ledger write (sign-in included). */
  disk: VolumeStats | null;
  /** Where redacted frames go. With R2 the probe is a real write, read and delete, and the counters show the 2 GB retention cap at work. */
  frames: FrameStoreStats & { probe: ProbeResult };
};

/** `ok` covers the probes only; `llmCalls`, `eventLoop`, `gc`, `cpuThrottle` and `disk` are reported for preflight/ops to judge, never a reason for 503. */
export async function deepHealth(runtime: Pick<Runtime, "env" | "checks" | "frames">): Promise<DeepHealth> {
  const { env, checks, frames } = runtime;
  const db = checks.db();
  const [dataDir, z3, probe] = await Promise.all([checks.dataDir(), checks.z3(), checks.frames()]);
  return { ok: db.ok && dataDir.ok && z3.ok && probe.ok, db, dataDir, z3, llmCalls: env.LLM_CALLS, eventLoop: checks.eventLoop(), gc: checks.gc(), cpuThrottle: checks.cpuThrottle(), disk: volumeStats(env.DATA_DIR), frames: { ...frames.stats(), probe } };
}
