import { describe, expect, it, vi } from "vitest";
import {
  CONDITION_KEYS,
  DEFAULT_GATE_CONFIG,
  GateConfigSchema,
  createGateController,
  evaluateGate,
  hudModel,
  type GateDecision,
  type GateEvent,
  type GateMode,
  type LatencySample,
} from "../src/gate/index";
import type { GateAuthorization } from "../src/schemas/gate";
import type { Question } from "../src/schemas/engine";
import { fakeClock, q, queue, stateOf } from "./gate-support";

const cfg = DEFAULT_GATE_CONFIG;
const NOW = 10_000;
/** Breakpoint, a valuable queued question, a long-quiet user: everything valid at NOW. */
const BASE: GateEvent[] = [{ kind: "breakpoint", t: 0, at: true }, queue(0, q("q1"))];

const evalAt = (events: readonly GateEvent[], now = NOW, mode: GateMode = "interviewer") =>
  evaluateGate(stateOf(events), now, mode, cfg);
const failing = (events: readonly GateEvent[], now = NOW, mode: GateMode = "interviewer") => {
  const e = evalAt(events, now, mode);
  return CONDITION_KEYS.filter((k) => !e.conditions[k].ok);
};
/** Authorized at `t`, spoken by the agent and finished. */
const askedAndSpoken = (t: number, question: Question): GateEvent[] => [
  { kind: "authorized", t, question, expiresAt: t + 4000 },
  { kind: "agent_speaking", t: t + 500, value: 1 },
  { kind: "agent_speaking", t: t + 3000, value: 0 },
];

describe("config", () => {
  it("has the plan defaults", () => {
    expect(cfg).toMatchObject({
      userSilenceMs: 1200,
      screenIdleMs: 1500,
      typingIdleMs: 1500,
      liveBudget: { max: 5, windowMs: 600_000 },
      authorizationTtlMs: 4000,
    });
    expect(cfg.tickMs).toBeLessThanOrEqual(50);
  });
  it("rejects a tick that would endanger the 250 ms bound, and unknown keys", () => {
    expect(GateConfigSchema.safeParse({ tickMs: 100 }).success).toBe(false);
    expect(GateConfigSchema.safeParse({ silence: 1 }).success).toBe(false);
  });
});

describe("evaluateGate: each condition", () => {
  it("authorizes when every condition holds, valid since the latest enabling event", () => {
    const e = evalAt(BASE);
    expect(e.decision).toBe("authorize");
    expect(e.question?.id).toBe("q1");
    expect(e.becameValidAt).toBe(0);
    expect(e.readyInMs).toBe(0);
    expect(e.reason).toBe("contradiction detected · EIG 0.61 bits");
  });

  it("user speaking blocks until the first silent VAD frame + userSilenceMs", () => {
    expect(failing([...BASE, { kind: "vad", t: 9000, value: 0.9 }])).toEqual(["userSilent"]);
    expect(evalAt([...BASE, { kind: "vad", t: 9000, value: 0.9 }]).conditions.userSilent.waitMs).toBe(Infinity);
    const stopped: GateEvent[] = [...BASE, { kind: "vad", t: 8000, value: 0.9 }, { kind: "vad", t: 8100, value: 0.1 }];
    expect(evalAt(stopped, 9000).conditions.userSilent).toEqual({ ok: false, waitMs: 300 });
    expect(evalAt(stopped, 9300).decision).toBe("authorize");
    expect(evalAt(stopped, 9300).becameValidAt).toBe(9300);
  });

  it("the explicit user_speaking channel blocks too, and turn_end ends it", () => {
    const speaking: GateEvent[] = [...BASE, { kind: "user_speaking", t: 5000 }];
    expect(failing(speaking)).toEqual(["userSilent"]);
    expect(evalAt([...speaking, { kind: "turn_end", t: 8000 }], 9200).decision).toBe("authorize");
    expect(evalAt([...speaking, { kind: "user_speaking", t: 8000, value: 0 }], 9199).decision).toBe("wait");
  });

  it("speech on either channel keeps the user speaking", () => {
    const both: GateEvent[] = [
      ...BASE,
      { kind: "vad", t: 5000, value: 0.9 },
      { kind: "user_speaking", t: 5000 },
      { kind: "turn_end", t: 6000 },
    ];
    expect(failing(both)).toEqual(["userSilent"]);
  });

  it("screen motion blocks for screenIdleMs", () => {
    const e = evalAt([...BASE, { kind: "screen_motion", t: 9000 }]);
    expect(failing([...BASE, { kind: "screen_motion", t: 9000 }])).toEqual(["screenIdle"]);
    expect(e.conditions.screenIdle.waitMs).toBe(500);
    expect(e.readyInMs).toBe(500);
  });

  it("typing blocks for typingIdleMs; pointer and focus changes do not gate", () => {
    expect(failing([...BASE, { kind: "typing", t: 9000 }])).toEqual(["typingIdle"]);
    expect(evalAt([...BASE, { kind: "typing", t: 8500 }]).becameValidAt).toBe(10_000);
    expect(failing([...BASE, { kind: "pointer", t: 9999 }, { kind: "focus_change", t: 9999 }])).toEqual([]);
  });

  it("needs a breakpoint unless the question is ephemeral; ephemeral bypasses nothing else", () => {
    const noBreak: GateEvent[] = [queue(0, q("q1"))];
    expect(failing(noBreak)).toEqual(["breakpointOrEphemeral"]);
    expect(
      evalAt([...noBreak, { kind: "breakpoint", t: 9000, at: true }, { kind: "breakpoint", t: 9500, at: false }])
        .decision,
    ).toBe("wait");
    const eph: GateEvent[] = [queue(0, q("q1", { ephemeral: true }))];
    expect(evalAt(eph).decision).toBe("authorize");
    expect(failing([...eph, { kind: "typing", t: 9000 }])).toEqual(["typingIdle"]);
    expect(failing([...eph, { kind: "screen_motion", t: 9000 }])).toEqual(["screenIdle"]);
    expect(failing([...eph, { kind: "vad", t: 9000, value: 1 }])).toEqual(["userSilent"]);
  });

  it("asks only questions worth ≥ θ_ask", () => {
    const at = (value: number) => evalAt([BASE[0]!, queue(0, q("q1", { value }))]);
    expect(at(0.29).decision).toBe("wait");
    expect(at(0.29).conditions.valueAboveTheta.waitMs).toBe(Infinity);
    expect(at(0.3).decision).toBe("authorize");
    expect(evalAt([BASE[0]!]).reason).toBe("no question queued");
  });

  it("restarts the question's clock only when it changes in a way the gate cares about", () => {
    const base: GateEvent[] = [BASE[0]!, queue(1000, q("q1", { value: 0.2 }))];
    expect(
      evalAt([...base, queue(2000, q("q1", { value: 0.5 })), queue(3000, q("q1", { value: 0.6 }))]).becameValidAt,
    ).toBe(2000);
    expect(
      evalAt([...base, queue(2000, q("q2", { value: 0.2 })), queue(3000, q("q2", { value: 0.6 }))]).becameValidAt,
    ).toBe(3000);
  });

  it("enforces the live budget over a sliding window", () => {
    const asked = [0, 1000, 2000, 3000, 4000].flatMap((t, i) => askedAndSpoken(t * 10, q(`old${i}`)));
    const events: GateEvent[] = [...asked, BASE[0]!, queue(100_000, q("q6"))];
    const before = evalAt(events, 599_999);
    expect(failing(events, 599_999)).toEqual(["budget"]);
    expect(before.conditions.budget.waitMs).toBe(1);
    const after = evalAt(events, 600_000);
    expect(after.decision).toBe("authorize");
    expect(after.becameValidAt).toBe(600_000);
    // With 4 in the window there is room again; the 5th oldest is the one that matters.
    expect(failing([...asked.slice(3), BASE[0]!, queue(100_000, q("q6"))], 100_000)).toEqual([]);
  });

  it("never authorizes off the record, and restarts the clock when back on", () => {
    const off: GateEvent[] = [...BASE, { kind: "off_record", t: 5000, on: true }];
    expect(failing(off)).toEqual(["notOffRecord"]);
    expect(evalAt(off).reason).toBe("off the record: the agent stays silent");
    expect(evalAt(off, NOW, "tutor").decision).toBe("wait");
    const back = evalAt([...off, { kind: "off_record", t: 9000, on: false }]);
    expect(back.decision).toBe("authorize");
    expect(back.becameValidAt).toBe(9000);
  });

  it("waits while the agent speaks or an authorization holds the floor; an unspoken hold lapses at its expiry", () => {
    expect(failing([...BASE, { kind: "agent_speaking", t: 9000, value: 1 }])).toEqual(["agentIdle"]);
    const held: GateEvent[] = [...BASE, { kind: "authorized", t: 8000, question: q("q0"), expiresAt: 12_000 }];
    expect(failing(held)).toEqual(["agentIdle"]);
    expect(evalAt(held).conditions.agentIdle.waitMs).toBe(2000);
    expect(evalAt(held).inFlight?.id).toBe("q0");
    expect(evalAt(held, 12_000).decision).toBe("authorize");
    const spoken: GateEvent[] = [...held, { kind: "agent_speaking", t: 8500, value: 1 }];
    expect(evalAt(spoken, 20_000).conditions.agentIdle.waitMs).toBe(Infinity);
  });

  it("after an agent turn waits for the expert's answer, or for the answer window to pass", () => {
    const spoke: GateEvent[] = [...BASE, ...askedAndSpoken(1000, q("q0"))]; // agent turn ends at 4000
    expect(evalAt(spoke, 8999).conditions.userSilent).toEqual({ ok: false, waitMs: 1 });
    expect(evalAt(spoke, 9000).decision).toBe("authorize");
    const answered: GateEvent[] = [
      ...spoke,
      { kind: "vad", t: 4500, value: 0.9 },
      { kind: "vad", t: 5000, value: 0.1 },
    ];
    expect(evalAt(answered, 6200).decision).toBe("authorize");
    expect(evalAt(answered, 6199).decision).toBe("wait");
  });

  it("never authorizes the same question twice", () => {
    const e = evalAt([...BASE, ...askedAndSpoken(0, q("q1"))], 100_000);
    expect(e.decision).toBe("wait");
    expect(e.question).toBeNull();
  });

  it("lists what it waits for, with seconds where time alone resolves it", () => {
    const e = evalAt([queue(0, q("q1")), { kind: "typing", t: 9201 }, { kind: "vad", t: 9500, value: 0.8 }]);
    expect(e.reason).toBe("waiting: Speaking, Typing 0.8 s, Breakpoint");
  });
});

describe("evaluateGate: tutor mode", () => {
  const rude: GateEvent[] = [
    { kind: "vad", t: 9900, value: 0.95 },
    { kind: "typing", t: 9990 },
    { kind: "screen_motion", t: 9990 },
    ...[1, 2, 3, 4, 5].flatMap((i) => askedAndSpoken(i * 100, q(`old${i}`))),
  ];

  it("authorizes guardrail interventions immediately: safety overrides politeness", () => {
    const e = evalAt(
      [...rude, queue(9995, q("stop", { kind: "intervention", value: 0, reason: "guardrail: BO ≥ 25% unverified" }))],
      NOW,
      "tutor",
    );
    expect(e.decision).toBe("authorize");
    expect(e.becameValidAt).toBe(9995);
    expect(e.reason).toBe("guardrail: BO ≥ 25% unverified · intervention: safety overrides politeness");
  });

  it("still never speaks over the agent, over an in-flight authorization, or off the record", () => {
    const stop = queue(9995, q("stop", { kind: "intervention" }));
    expect(evalAt([...rude, stop, { kind: "agent_speaking", t: 9000, value: 1 }], NOW, "tutor").decision).toBe("wait");
    expect(
      evalAt([...rude, stop, { kind: "authorized", t: 9000, question: q("x"), expiresAt: 13_000 }], NOW, "tutor")
        .decision,
    ).toBe("wait");
    expect(evalAt([...rude, stop, { kind: "off_record", t: 9000, on: true }], NOW, "tutor").decision).toBe("wait");
  });

  it("other tutor prompts follow the normal rules", () => {
    const predict = queue(0, q("p1", { kind: "prediction", ephemeral: true }));
    expect(evalAt([predict, { kind: "typing", t: 9990 }], NOW, "tutor").decision).toBe("wait");
    expect(evalAt([predict], NOW, "tutor").decision).toBe("authorize");
  });

  it("interventions follow the normal rules in interviewer mode", () => {
    expect(evalAt([...rude, queue(9995, q("stop", { kind: "intervention" }))]).decision).toBe("wait");
  });
});

describe("hudModel", () => {
  it("LISTENING with nothing queued; off the record says so", () => {
    const idle = hudModel(evalAt([]));
    expect([idle.line, idle.reason, idle.value]).toMatchInlineSnapshot(`
      [
        "LISTENING · Typing ✓ · Speaking ✓ · Screen moving ✓",
        "no question queued",
        null,
      ]
    `);
    expect(idle.rows.map((r) => `${r.label} ${r.text}`)).toMatchInlineSnapshot(`
      [
        "Speaking ✓",
        "Screen moving ✓",
        "Typing ✓",
        "Breakpoint wait",
        "Question value wait",
        "Budget ✓",
        "Off record ✓",
        "Agent speaking ✓",
      ]
    `);
    const off = hudModel(evalAt([...BASE, { kind: "off_record", t: 9000, on: true }]));
    expect([off.status, off.reason, off.rows.find((r) => r.key === "notOffRecord")?.text]).toMatchInlineSnapshot(`
      [
        "WAITING",
        "off the record: the agent stays silent",
        "wait",
      ]
    `);
  });

  it("WAITING while the expert types and talks", () => {
    const hud = hudModel(evalAt([...BASE, { kind: "typing", t: 9201 }, { kind: "vad", t: 9500, value: 0.8 }]));
    expect(hud.line).toMatchInlineSnapshot(
      `"WAITING · Typing wait 0.8 s · Speaking wait · Screen moving ✓ · Question value ██████ 0.61"`,
    );
    expect(hud.judge).toMatchInlineSnapshot(`
      [
        {
          "key": "typingIdle",
          "label": "Typing",
          "ok": false,
          "text": "wait 0.8 s",
        },
        {
          "key": "userSilent",
          "label": "Speaking",
          "ok": false,
          "text": "wait",
        },
        {
          "key": "screenIdle",
          "label": "Screen moving",
          "ok": true,
          "text": "✓",
        },
      ]
    `);
    expect(hud.reason).toMatchInlineSnapshot(`"waiting: Speaking, Typing 0.8 s"`);
  });

  it("ASKING when authorized and while the agent speaks the question", () => {
    const asking = hudModel(evalAt([BASE[0]!, queue(0, q("q1", { value: 0.83 }))]));
    expect(asking.line).toMatchInlineSnapshot(
      `"ASKING · Typing ✓ · Speaking ✓ · Screen moving ✓ · Question value ████████ 0.83"`,
    );
    expect(asking.reason).toMatchInlineSnapshot(`"contradiction detected · EIG 0.83 bits"`);
    expect(asking.value).toMatchInlineSnapshot(`
      {
        "level": 0.83,
        "text": "0.83",
      }
    `);
    const speaking = hudModel(
      evalAt([
        ...BASE,
        { kind: "authorized", t: 9000, question: q("q1"), expiresAt: 13_000 },
        { kind: "agent_speaking", t: 9500 },
      ]),
    );
    expect(speaking.status).toBe("ASKING");
    expect(speaking.rows.find((r) => r.key === "agentIdle")).toMatchInlineSnapshot(`
      {
        "key": "agentIdle",
        "label": "Agent speaking",
        "ok": false,
        "text": "wait",
      }
    `);
  });

  it("clamps the value bar and shows the budget countdown in the engineering rows", () => {
    const asked = [0, 1, 2, 3, 4].flatMap((i) => askedAndSpoken(i * 10_000, q(`old${i}`)));
    const hud = hudModel(evalAt([...asked, BASE[0]!, queue(100_000, q("q6", { value: 2.4 }))], 595_000));
    expect(hud.value).toEqual({ level: 1, text: "2.40" });
    expect(hud.rows.find((r) => r.key === "budget")?.text).toBe("wait 5.0 s");
    expect(hud.status).toBe("WAITING");
  });
});

describe("createGateController", () => {
  const authorization = (question: Question, nonce = "n".repeat(22)): GateAuthorization => ({
    sessionId: question.sessionId,
    questionId: question.id,
    nonce,
    expiresAt: 0,
    contextVersion: 0,
  });

  function setup(
    issue: (question: Question, decision: GateDecision) => Promise<GateAuthorization> | GateAuthorization = (question) =>
      authorization(question),
  ) {
    const clock = fakeClock();
    const authorized: { question: string; sample: LatencySample }[] = [];
    const huds: string[] = [];
    const onError = vi.fn();
    const onHoldAgentHint = vi.fn();
    const gate = createGateController({
      mode: "interviewer",
      clock,
      issue,
      onAuthorize: (_a, question, sample) => authorized.push({ question: question.id, sample }),
      onHudUpdate: (hud) => huds.push(hud.line),
      onHoldAgentHint,
      onError,
    });
    return { clock, gate, authorized, huds, onError, onHoldAgentHint };
  }

  it("wakes exactly when the conditions become valid and authorizes once", () => {
    const { clock, gate, authorized } = setup();
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed({ kind: "typing", t: 0 });
    gate.feed(queue(0, q("q1")));
    clock.advanceTo(1499);
    expect(authorized).toEqual([]);
    clock.advanceTo(1500);
    expect(authorized).toEqual([
      {
        question: "q1",
        sample: { questionId: "q1", becameValidAt: 1500, decidedAt: 1500, authorizedAt: 1500, latencyMs: 0 },
      },
    ]);
    clock.advanceTo(60_000);
    expect(authorized).toHaveLength(1);
  });

  it("passes issue the decision it authorized on: becameValidAt, decidedAt and every condition", () => {
    const decisions: GateDecision[] = [];
    const { clock, gate } = setup((question, decision) => {
      decisions.push(decision);
      return authorization(question);
    });
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed({ kind: "typing", t: 200 });
    gate.feed(queue(300, q("q1")));
    clock.advanceTo(1700);
    expect(decisions).toEqual([
      {
        becameValidAt: 1700,
        decidedAt: 1700,
        conditions: Object.fromEntries(CONDITION_KEYS.map((k) => [k, true])),
      },
    ]);
    expect(Object.keys(decisions[0]?.conditions ?? {}).sort()).toEqual([...CONDITION_KEYS].sort());
  });

  it("holds the floor until the agent has spoken, then asks the next question after the answer window", () => {
    const { clock, gate, authorized } = setup();
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    gate.feed(queue(10, q("q2")));
    expect(authorized.map((a) => a.question)).toEqual(["q1"]);
    clock.advanceTo(700);
    gate.feed({ kind: "agent_speaking", t: 700, value: 1 });
    clock.advanceTo(5000);
    expect(authorized).toHaveLength(1);
    gate.feed({ kind: "agent_speaking", t: 5000, value: 0 });
    clock.advanceTo(9999);
    expect(authorized).toHaveLength(1);
    clock.advanceTo(10_000);
    expect(authorized.map((a) => a.question)).toEqual(["q1", "q2"]);
  });

  it("never has two authorizations in flight while an async issue is pending", async () => {
    let resolve: (a: GateAuthorization) => void = () => {};
    const issue = vi.fn(
      (question: Question) => new Promise<GateAuthorization>((r) => (resolve = () => r(authorization(question)))),
    );
    const { clock, gate, authorized } = setup(issue);
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    gate.feed(queue(1, q("q2")));
    clock.advanceTo(200);
    expect(issue).toHaveBeenCalledTimes(1);
    resolve(authorization(q("q1")));
    await Promise.resolve();
    expect(authorized).toEqual([
      {
        question: "q1",
        sample: { questionId: "q1", becameValidAt: 0, decidedAt: 0, authorizedAt: 200, latencyMs: 200 },
      },
    ]);
  });

  it("reports an issuer failure or a mismatched authorization, and does not retry the question", async () => {
    const { clock, gate, authorized, onError } = setup(() => authorization(q("other")));
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    expect(onError).toHaveBeenCalledTimes(1);
    const failing = setup(() => Promise.reject(new Error("503")));
    failing.gate.feed({ kind: "breakpoint", t: 0, at: true });
    failing.gate.feed(queue(0, q("q1")));
    await Promise.resolve();
    expect(failing.onError).toHaveBeenCalledWith(new Error("503"), expect.objectContaining({ id: "q1" }));
    clock.advanceTo(30_000);
    expect(authorized).toEqual([]);
  });

  it("validates inputs at the boundary", () => {
    const { gate } = setup();
    expect(() => gate.feed({ kind: "typing", t: -1 })).toThrow();
    expect(() => gate.feed(JSON.parse('{"kind":"queue","t":1,"top":{"id":"x"}}'))).toThrow();
  });

  it("hints (non-enforcing) to hold the agent at most once per second while typing", () => {
    const { gate, onHoldAgentHint } = setup();
    for (let t = 0; t < 2500; t += 100) gate.feed({ kind: "typing", t });
    expect(onHoldAgentHint).toHaveBeenCalledTimes(3);
  });

  it("publishes the HUD only when it changes and stops ticking once disposed", () => {
    const { clock, gate, huds } = setup();
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed({ kind: "typing", t: 0 });
    gate.feed(queue(0, q("q1")));
    clock.advanceTo(1000);
    expect(huds.length).toBeLessThanOrEqual(15); // one per 0.1 s countdown step, not one per 50 ms tick
    expect(huds.at(-1)).toContain("Typing wait 0.5 s");
    gate.dispose();
    expect(clock.pending()).toBe(0);
  });
});
