/**
 * The server's Z3: one shared worker thread (z3.worker.ts) behind the solver functions the debrief,
 * the two-experts reconciliation, the tutor and the verified replay are given. Every query keeps its
 * `@vashistha/solver` semantics; only where it runs changes. Imported by the composition root only.
 */
import type { DisagreementSolver } from "../disagreements/deps";
import type { WitnessSolver } from "../debrief/solver";
import type { CheckResult } from "../runtime";
import type { PracticeSolver } from "../tutor/deps";
import { createRpcWorker } from "./client";
import { Z3_OPS } from "./z3-ops";

/** Z3 interleaves queries in its own threads; a few in flight keep a short query from waiting behind a long search. */
const MAX_IN_FLIGHT = 4;

export type Z3Worker = {
  witnesses: WitnessSolver;
  disagreements: DisagreementSolver;
  practice: PracticeSolver;
  /** Preflight "Z3 initialises" (plan §12), run in the worker; queued ahead of searches. */
  selfTest: () => Promise<CheckResult>;
  close: () => Promise<void>;
};

export function createZ3Worker(log: Pick<Console, "warn" | "error">): Z3Worker {
  const rpc = createRpcWorker({ name: "z3", entry: new URL("./z3.worker.ts", import.meta.url), ops: Z3_OPS, maxInFlight: MAX_IN_FLIGHT, log });
  return {
    witnesses: (search) => rpc.call("witnesses", search),
    disagreements: (query) => rpc.call("disagreements", query),
    practice: (query) => rpc.call("practice", query),
    selfTest: () =>
      rpc.call("selfTest", {}).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })),
    close: () => rpc.close(),
  };
}
