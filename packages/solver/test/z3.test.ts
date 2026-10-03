import { describe, expect, it, vi } from "vitest";
import type * as Z3Solver from "z3-solver";

// Wraps the real `init` in a spy so tests can count initialisations and inject one failure.
vi.mock("z3-solver", async (importOriginal) => {
  const actual = await importOriginal<typeof Z3Solver>();
  return { ...actual, init: vi.fn(actual.init) };
});

/** A fresh module graph, so each test starts with no memoised Z3. */
async function freshZ3() {
  vi.resetModules();
  // Sequential: concurrent imports of a fresh graph can each run the mock factory.
  const z3 = await import("../src/index");
  const { init } = await import("z3-solver");
  return { init: vi.mocked(init), ...z3 };
}

describe("getZ3", () => {
  it("shares one initialisation between concurrent first callers and later calls", async () => {
    const { init, getZ3 } = await freshZ3();
    const [a, b] = await Promise.all([getZ3(), getZ3()]);
    expect(a).toBe(b);
    expect(await getZ3()).toBe(a);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed initialisation", async () => {
    const { init, getZ3 } = await freshZ3();
    init.mockRejectedValueOnce(new Error("wasm load failed"));
    const [first, concurrent] = await Promise.allSettled([getZ3(), getZ3()]);
    expect(first).toMatchObject({ status: "rejected", reason: { message: "wasm load failed" } });
    expect(concurrent).toEqual(first);
    const handle = await getZ3();
    expect(handle.ctx.name).toBe("main");
    expect(init).toHaveBeenCalledTimes(2);
  });

  it("decides an unsat integer problem as unsat", async () => {
    const { getZ3 } = await freshZ3();
    const { ctx } = await getZ3();
    const x = ctx.Int.const("x");
    const y = ctx.Int.const("y");
    const solver = new ctx.Solver();
    solver.add(x.add(y).eq(10), x.gt(5), y.gt(5));
    expect(await solver.check()).toBe("unsat");
  });
});

describe("z3SelfTest", () => {
  it("passes and reports its duration", async () => {
    const { z3SelfTest } = await freshZ3();
    const result = await z3SelfTest();
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.ms).toBeGreaterThan(0);
    const warm = await z3SelfTest();
    expect(warm.ok).toBe(true);
    console.info(`z3SelfTest cold ${result.ok ? result.ms.toFixed(0) : "?"} ms, warm ${warm.ok ? warm.ms.toFixed(0) : "?"} ms`);
  });

  it("reports an initialisation failure instead of throwing", async () => {
    const { init, z3SelfTest } = await freshZ3();
    init.mockRejectedValueOnce(new Error("wasm load failed"));
    expect(await z3SelfTest()).toEqual({ ok: false, error: "wasm load failed" });
  });
});
