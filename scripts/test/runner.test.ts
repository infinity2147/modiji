import { describe, expect, it } from "vitest";
import { CHECKS, exitCodeFor, runChecks, selectChecks, UsageError, type CheckDefinition } from "../preflight/runner";
import type { CheckResult } from "../preflight/types";
import { fakeAgentSockets, fakeClaude, fakeElevenLabs, fakeServer, GOOD_ENV, makeContext, SECRET } from "./support/fakes";

const result = (status: CheckResult["status"]): CheckResult => ({ id: "env", title: "t", status, ms: 0, detail: "" });

describe("selectChecks", () => {
  it("runs everything by default, in canonical order", () => {
    expect(selectChecks(undefined)).toEqual(CHECKS.map((c) => c.id));
  });

  it("adds dependencies of selected checks", () => {
    expect(selectChecks(["voice-skip-turn"])).toEqual(["public-llm", "voice-skip-turn"]);
    expect(selectChecks(["sandbox", "env"])).toEqual(["env", "sandbox"]);
  });

  it("rejects unknown ids as a usage error", () => {
    expect(() => selectChecks(["sandbox", "nope"])).toThrow(UsageError);
  });
});

describe("exitCodeFor", () => {
  it("is 0 only when every gating check passed", () => {
    expect(exitCodeFor([result("pass"), result("info")])).toBe(0);
    expect(exitCodeFor([result("info")])).toBe(0);
    expect(exitCodeFor([result("pass"), result("fail")])).toBe(1);
    expect(exitCodeFor([result("pass"), result("skip")])).toBe(1);
  });
});

describe("runChecks", () => {
  it("skips a dependent check when its dependency fails, and never runs it", async () => {
    let voiceRan = false;
    const defs: CheckDefinition[] = [
      { id: "public-llm", title: "llm", run: async () => ({ status: "fail", detail: "boom" }) },
      {
        id: "voice-skip-turn",
        title: "voice",
        dependsOn: ["public-llm"],
        run: async () => {
          voiceRan = true;
          return { status: "pass", detail: "" };
        },
      },
    ];
    const results = await runChecks(makeContext(), ["public-llm", "voice-skip-turn"], defs);
    expect(voiceRan).toBe(false);
    expect(results.map((r) => [r.id, r.status, r.detail])).toEqual([
      ["public-llm", "fail", "boom"],
      ["voice-skip-turn", "skip", "depends on public-llm (fail)"],
    ]);
    expect(exitCodeFor(results)).toBe(1);
  });

  it("runs independent checks concurrently and dependents only after their dependency", async () => {
    const order: string[] = [];
    const slow = (id: string, ms: number) => async () => {
      order.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${id}`);
      return { status: "pass" as const, detail: "" };
    };
    const defs: CheckDefinition[] = [
      { id: "public-llm", title: "", run: slow("public-llm", 30) },
      { id: "voice-skip-turn", title: "", dependsOn: ["public-llm"], run: slow("voice", 1) },
      { id: "sandbox", title: "", run: slow("sandbox", 5) },
    ];
    await runChecks(makeContext(), ["public-llm", "voice-skip-turn", "sandbox"], defs);
    expect(order.slice(0, 2)).toEqual(["start public-llm", "start sandbox"]);
    expect(order.indexOf("start voice")).toBeGreaterThan(order.indexOf("end public-llm"));
  });

  it("turns a thrown error into a redacted failure", async () => {
    const defs: CheckDefinition[] = [
      { id: "env", title: "", run: async () => Promise.reject(new Error(`leaked ${SECRET} in a message`)) },
    ];
    const [r] = await runChecks(makeContext(), ["env"], defs);
    expect(r?.status).toBe("fail");
    expect(r?.detail).toBe("leaked [redacted] in a message");
  });

  it("runs the real suite green against the fakes, with nothing sensitive in any result", async () => {
    // The fake deployment and the check context share one clock, so the retry-window wait advances it.
    let now = Date.now();
    const clock = () => now;
    const server = fakeServer({}, clock);
    const sockets = fakeAgentSockets(server);
    const eleven = fakeElevenLabs({ getAgent: () => Promise.reject(new Error("not part of this test")) });
    const ctx = makeContext({
      fetch: server.fetch,
      WebSocket: sockets.factory,
      createElevenLabs: () => eleven,
      createClaude: () => fakeClaude(),
      wallClock: clock,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const ids = selectChecks(["env", "anthropic", "token", "public-llm", "voice-skip-turn", "server-deep", "sandbox", "permissions"]);
    const results = await runChecks(ctx, ids);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["env", "pass"],
      ["anthropic", "pass"],
      ["token", "pass"],
      ["public-llm", "pass"],
      ["voice-skip-turn", "pass"],
      ["server-deep", "pass"],
      ["sandbox", "pass"],
      ["permissions", "info"],
    ]);
    expect(exitCodeFor(results)).toBe(0);
    const json = JSON.stringify(results);
    for (const value of [SECRET, GOOD_ENV.ANTHROPIC_API_KEY, GOOD_ENV.ELEVENLABS_API_KEY, ...server.authorizations.keys()]) {
      expect(json).not.toContain(value);
    }
    expect(json).not.toMatch(/conversation_signature|tok_agent|public-token-|⟦ctl:[A-Za-z0-9]/);
  });
});
