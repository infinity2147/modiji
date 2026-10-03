import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvError } from "@vashistha/core/server";
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
