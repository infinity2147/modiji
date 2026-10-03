/**
 * Process-wide Z3 (WASM) bootstrap. `init()` loads and compiles the WASM module and spawns its
 * worker threads, so it runs once per process and every caller shares one `Context("main")`.
 * The workers are unref'd by Emscripten, so an idle Z3 does not keep Node alive.
 */
import { init, type Context } from "z3-solver";

export type Z3Handle = { readonly ctx: Context<"main"> };
export type Z3SelfTestResult = { ok: true; ms: number } | { ok: false; error: string };

let pending: Promise<Z3Handle> | undefined;

/** The shared Z3 context. Concurrent first callers share one initialisation; a failed one is retried by the next call. */
export function getZ3(): Promise<Z3Handle> {
  pending ??= init()
    .then(({ Context }) => ({ ctx: new Context("main") }))
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/**
 * Preflight "Z3 initialises" (plan §12): 2 < x < 4 must be sat with x = 3, and 2 < x < 3 unsat
 * over the integers. `ms` includes initialisation when this is the process's first Z3 use.
 */
export async function z3SelfTest(): Promise<Z3SelfTestResult> {
  const started = performance.now();
  try {
    const { ctx } = await getZ3();
    const x = ctx.Int.const("x");

    const sat = new ctx.Solver();
    sat.add(x.gt(2), x.lt(4));
    const satResult = await sat.check();
    if (satResult !== "sat") return { ok: false, error: `2 < x < 4: expected sat, got ${satResult}` };
    const value = sat.model().eval(x, true);
    if (!ctx.isIntVal(value) || value.value() !== 3n) return { ok: false, error: `2 < x < 4: expected x = 3, got ${value.toString()}` };

    const unsat = new ctx.Solver();
    unsat.add(x.gt(2), x.lt(3));
    const unsatResult = await unsat.check();
    if (unsatResult !== "unsat") return { ok: false, error: `2 < x < 3: expected unsat, got ${unsatResult}` };

    return { ok: true, ms: performance.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
