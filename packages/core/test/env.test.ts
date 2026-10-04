import { describe, expect, it } from "vitest";
import { EnvError, loadServerEnv, requireEnv } from "../src/server";

const SECRET = "fake-secret-value-do-not-leak-0123456789";

const dev = { PUBLIC_BASE_URL: "http://localhost:3000", DATA_DIR: "./data" };
const prod = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://vashistha.example.com",
  DATA_DIR: "/data",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ELEVENLABS_API_KEY: "el-test",
  CUSTOM_LLM_SECRET: SECRET,
};

function envError(source: Record<string, string | undefined>): EnvError {
  try {
    loadServerEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return err as EnvError;
  }
  throw new Error("expected EnvError");
}

describe("loadServerEnv", () => {
  it("loads a minimal development env with defaults", () => {
    expect(loadServerEnv({ ...dev, UNRELATED: "x" })).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      PUBLIC_BASE_URL: "http://localhost:3000",
      DATA_DIR: "./data",
      LLM_CALLS: "on",
    });
  });

  it("loads a complete production env", () => {
    const env = loadServerEnv({ ...prod, ELEVENLABS_TUTOR_AGENT_ID: "agent_1" });
    expect(env).toMatchObject({ NODE_ENV: "production", CUSTOM_LLM_SECRET: SECRET, ELEVENLABS_TUTOR_AGENT_ID: "agent_1" });
  });

  it("requires the API keys and custom-LLM secret in production", () => {
    const err = envError({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://x.example", DATA_DIR: "/data" });
    expect(err.variables).toEqual(["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "CUSTOM_LLM_SECRET"]);
    expect(err.message).toContain("ANTHROPIC_API_KEY: missing");
  });

  it("requires https in production", () => {
    expect(envError({ ...prod, PUBLIC_BASE_URL: "http://vashistha.example.com" }).variables).toEqual(["PUBLIC_BASE_URL"]);
  });

  it("reports every problem at once, including production requirements", () => {
    const err = envError({ NODE_ENV: "production", PORT: "http", PUBLIC_BASE_URL: "http://x.example" });
    expect(err.variables).toEqual([
      "PORT",
      "PUBLIC_BASE_URL",
      "DATA_DIR",
      "ANTHROPIC_API_KEY",
      "ELEVENLABS_API_KEY",
      "CUSTOM_LLM_SECRET",
    ]);
    for (const name of err.variables) expect(err.message).toContain(name);
  });

  it("treats empty and blank strings as unset", () => {
    expect(loadServerEnv({ ...dev, PORT: "", NODE_ENV: "  ", ANTHROPIC_API_KEY: "" })).toEqual({
      NODE_ENV: "development",
      PORT: 3000,
      PUBLIC_BASE_URL: "http://localhost:3000",
      DATA_DIR: "./data",
      LLM_CALLS: "on",
    });
    expect(envError({ ...dev, DATA_DIR: "" }).message).toContain("DATA_DIR: missing");
    expect(envError({ ...prod, CUSTOM_LLM_SECRET: "" }).variables).toEqual(["CUSTOM_LLM_SECRET"]);
  });

  it("never includes secret values in the error message", () => {
    const leaky = SECRET.slice(0, 20);
    const err = envError({ ...prod, CUSTOM_LLM_SECRET: leaky, ANTHROPIC_API_KEY: SECRET, PORT: SECRET });
    expect(err.variables).toEqual(["PORT", "CUSTOM_LLM_SECRET"]);
    expect(err.message).toContain("CUSTOM_LLM_SECRET: invalid");
    expect(err.message).not.toContain(leaky);
    expect(err.message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(leaky);
  });

  it("validates CUSTOM_LLM_SECRET length even in development", () => {
    expect(envError({ ...dev, CUSTOM_LLM_SECRET: "short" }).variables).toEqual(["CUSTOM_LLM_SECRET"]);
  });

  it.each([
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://Example.COM//", "https://example.com"],
    ["https://example.com/base/", "https://example.com/base"],
    ["  https://example.com  ", "https://example.com"],
  ])("normalises PUBLIC_BASE_URL %j", (input, expected) => {
    expect(loadServerEnv({ ...dev, PUBLIC_BASE_URL: input }).PUBLIC_BASE_URL).toBe(expected);
  });

  it.each(["example.com", "ftp://example.com", "https://example.com/?a=1", "https://example.com/#x", "https://u:p@example.com"])(
    "rejects PUBLIC_BASE_URL %j",
    (input) => {
      expect(envError({ ...dev, PUBLIC_BASE_URL: input }).variables).toEqual(["PUBLIC_BASE_URL"]);
    },
  );

  it.each([
    ["8080", 8080],
    [" 4000 ", 4000],
  ])("coerces PORT %j", (input, expected) => {
    expect(loadServerEnv({ ...dev, PORT: input }).PORT).toBe(expected);
  });

  it.each(["0", "65536", "3000.5", "-1", "0x10", "abc"])("rejects PORT %j", (input) => {
    expect(envError({ ...dev, PORT: input }).variables).toEqual(["PORT"]);
  });

  it("reads the LLM_CALLS switch (default on) and rejects anything but on/off without echoing it", () => {
    expect(loadServerEnv({ ...dev, LLM_CALLS: " off " }).LLM_CALLS).toBe("off");
    expect(loadServerEnv({ ...dev, LLM_CALLS: "on" }).LLM_CALLS).toBe("on");
    expect(loadServerEnv({ ...dev, LLM_CALLS: "" }).LLM_CALLS).toBe("on");
    const err = envError({ ...dev, LLM_CALLS: "disabled-please" });
    expect(err.variables).toEqual(["LLM_CALLS"]);
    expect(err.message).toContain("LLM_CALLS: invalid (on or off)");
    expect(err.message).not.toContain("disabled-please");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(envError({ ...dev, NODE_ENV: "staging" }).variables).toEqual(["NODE_ENV"]);
  });
});

describe("requireEnv", () => {
  it("returns a set variable and names a missing one", () => {
    const env = loadServerEnv({ ...dev, ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(requireEnv(env, "ANTHROPIC_API_KEY")).toBe("sk-ant-test");
    expect(() => requireEnv(env, "ELEVENLABS_TUTOR_AGENT_ID")).toThrow(EnvError);
    expect(() => requireEnv(env, "ELEVENLABS_TUTOR_AGENT_ID")).toThrow(/ELEVENLABS_TUTOR_AGENT_ID is not set/);
  });
});
