import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvError, loadServerEnv } from "@vashistha/core/server";
import { deepHealth } from "../../lib/server/health";
import { createVolumeFrameStore } from "../../lib/server/perception/frame-store";
import { createRuntime } from "../../lib/server/runtime-init";
import { getRuntime } from "../../lib/server/runtime";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vashistha-runtime-"));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

const SESSION = { id: "s", privacyEpoch: 0, offRecord: false };
const baseEnv = () => ({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", DATA_DIR: dataDir });

describe("createRuntime", () => {
  it("registers a runtime for route handlers and unregisters it on close", () => {
    const { runtime, close } = createRuntime(baseEnv());
    try {
      expect(getRuntime()).toBe(runtime);
      expect(runtime.env.PORT).toBe(3000);
      expect(runtime.elevenLabs).toBeNull();
      expect(readdirSync(dataDir)).toContain("vashistha.db");
    } finally {
      close();
    }
    expect(() => getRuntime()).toThrow(/not initialised/);
  });

  it("creates an ElevenLabs client when the key is set", () => {
    const { runtime, close } = createRuntime({ ...baseEnv(), ELEVENLABS_API_KEY: "xi-test-key" });
    try {
      expect(runtime.elevenLabs).not.toBeNull();
    } finally {
      close();
    }
  });

  it("constructs no model client when LLM_CALLS=off, even with ANTHROPIC_API_KEY set", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const keyed = { ...baseEnv(), ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key" };
    const on = createRuntime(keyed);
    try {
      expect(on.runtime.env.LLM_CALLS).toBe("on");
      expect(on.runtime.claude).not.toBeNull();
      expect(on.runtime.perception.state(SESSION)).toMatchObject({ extraction: "available", unavailableReason: null });
    } finally {
      on.close();
    }
    const off = createRuntime({ ...keyed, LLM_CALLS: "off" });
    try {
      expect(off.runtime.env.LLM_CALLS).toBe("off");
      expect(off.runtime.claude).toBeNull();
      expect(off.runtime.perception.state(SESSION)).toMatchObject({ extraction: "unavailable", unavailableReason: "disabled" });
      expect(info).toHaveBeenCalledWith(expect.stringContaining("LLM_CALLS=off: model calls disabled"));
    } finally {
      off.close();
      info.mockRestore();
    }
  });

  it("rejects an invalid LLM_CALLS naming the variable, never the value", () => {
    expect(() => createRuntime({ ...baseEnv(), LLM_CALLS: "nope-value" })).toThrow(
      expect.objectContaining({ name: "EnvError", variables: ["LLM_CALLS"], message: expect.not.stringContaining("nope-value") }),
    );
  });

  it("fails fast with an EnvError that names variables but not values", () => {
    const shortSecret = "too-short-secret-value";
    let caught: unknown;
    try {
      createRuntime({ ...baseEnv(), PORT: "70000", CUSTOM_LLM_SECRET: shortSecret });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvError);
    const { message, variables } = caught as EnvError;
    expect(variables).toEqual(["PORT", "CUSTOM_LLM_SECRET"]);
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain("70000");
    expect(() => getRuntime()).toThrow();
  });
});

describe("deep health response", () => {
  const checks = (z3: boolean) => ({
    db: () => ({ ok: true as const, ms: 1 }),
    dataDir: async () => ({ ok: true as const, ms: 1 }),
    z3: async () => (z3 ? { ok: true as const, ms: 1 } : { ok: false as const, error: "boom" }),
    eventLoop: () => ({ p50Ms: 0, p99Ms: 1, maxMs: 2, samples: 10, sinceMs: 100 }),
    gc: () => ({ count: 3, totalPauseMs: 5, maxPauseMs: 2, sinceMs: 100 }),
    cpuThrottle: () => null,
    frames: async () => ({ ok: true as const, ms: 0 }),
  });
  const frames = createVolumeFrameStore("/nonexistent");

  it("reports GC and CPU-throttle telemetry alongside the event loop, without letting them affect ok", async () => {
    const env = loadServerEnv({ ...baseEnv(), LLM_CALLS: "on" });
    expect(await deepHealth({ env, frames, checks: checks(true) })).toMatchObject({
      ok: true,
      eventLoop: { p99Ms: 1 },
      gc: { count: 3, totalPauseMs: 5, maxPauseMs: 2 },
      cpuThrottle: null,
    });
  });

  it("reports llmCalls from the environment, without letting it affect ok", async () => {
    const env = loadServerEnv({ ...baseEnv(), LLM_CALLS: "off" });
    expect(await deepHealth({ env, frames, checks: checks(true) })).toMatchObject({ ok: true, llmCalls: "off" });
    expect(await deepHealth({ env: { ...env, LLM_CALLS: "on" }, frames, checks: checks(false) })).toMatchObject({
      ok: false,
      z3: { ok: false, error: "boom" },
      llmCalls: "on",
    });
  });
});

describe("deep health checks", () => {
  it("passes on a writable data dir, leaving no trace in the database or the directory", async () => {
    const { runtime, close } = createRuntime(baseEnv());
    try {
      const before = readdirSync(dataDir).sort();
      expect(runtime.checks.db()).toMatchObject({ ok: true });
      expect(runtime.checks.db()).toMatchObject({ ok: true }); // the probe table never persists
      expect(await runtime.checks.dataDir()).toMatchObject({ ok: true });
      expect(readdirSync(dataDir).sort()).toEqual(before);
      runtime.ledger.createSession({ id: "after-probe" });
      expect(runtime.ledger.list("after-probe")).toEqual([]);
    } finally {
      close();
    }
  });

  it.skipIf(process.getuid?.() === 0)("reports a read-only data dir", async () => {
    const { runtime, close } = createRuntime(baseEnv());
    try {
      chmodSync(dataDir, 0o500);
      expect(await runtime.checks.dataDir()).toMatchObject({ ok: false, error: expect.stringMatching(/EACCES/) });
    } finally {
      close();
    }
  });

  it("initialises Z3 and solves the self-test", { timeout: 60_000 }, async () => {
    const { runtime, close } = createRuntime(baseEnv());
    try {
      expect(await runtime.checks.z3()).toMatchObject({ ok: true, ms: expect.any(Number) });
    } finally {
      close();
    }
  });
});
