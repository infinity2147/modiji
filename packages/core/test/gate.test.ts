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
  type GateInput,
  type GateMode,
  type LatencySample,
} from "../src/gate/index";
import { runScript } from "../src/gate/simulate";
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
/** Authorized at `t`, issued, spoken by the agent and finished. */
const askedAndSpoken = (t: number, question: Question): GateEvent[] => [
  { kind: "authorized", t, question },
  { kind: "issued", t: t + 100, questionId: question.id },
  { kind: "agent_speaking", t: t + 500, value: 1 },
  { kind: "agent_speaking", t: t + 3000, value: 0 },
];

describe("config", () => {
  it("has the plan defaults", () => {
    expect(cfg).toMatchObject({
      userSilenceMs: 1200,
      screenIdleMs: 1500,
      typingIdleMs: 1500,
      liveBudget: { max: 5, windowMs: 600_000, kinds: ["why_probe", "counterfactual", "concept_definition"] },
      authorizationTtlMs: 4000,
      authorizationGraceMs: 1500,
      answerWindowMs: 5000,
      answerSilenceMs: 4000,
      transcriptWaitMs: 3000,
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

  it("user speaking blocks until the turn is transcribed and userSilenceMs past the last speech signal", () => {
    expect(failing([...BASE, { kind: "vad", t: 9000, value: 0.9 }])).toEqual(["userSilent"]);
    expect(evalAt([...BASE, { kind: "vad", t: 9000, value: 0.9 }]).conditions.userSilent.waitMs).toBe(Infinity);
    const stopped: GateEvent[] = [...BASE, { kind: "vad", t: 8000, value: 0.9 }, { kind: "vad", t: 8100, value: 0.1 }];
    // No final transcript yet: the open turn holds the floor for transcriptWaitMs after the speech.
    expect(evalAt(stopped, 9300).conditions.userSilent).toEqual({ ok: false, waitMs: 1800 });
    expect(evalAt(stopped, 11_100).becameValidAt).toBe(11_100);
    // The final transcript closes the turn; silence counts from it (the last speech signal).
    const transcribed: GateEvent[] = [...stopped, { kind: "user_transcript", t: 8600 }];
    expect(evalAt(transcribed, 9799).decision).toBe("wait");
    expect(evalAt(transcribed, 9800).becameValidAt).toBe(9800);
  });

  it("the local microphone detector is a speech channel of its own (OR-ed with the provider VAD)", () => {
    const local: GateEvent[] = [...BASE, { kind: "local_speech", t: 9000, value: 1 }, { kind: "vad", t: 9100, value: 0 }];
    expect(failing(local)).toEqual(["userSilent"]);
    expect(evalAt(local).conditions.userSilent.waitMs).toBe(Infinity);
    const quiet: GateEvent[] = [...local, { kind: "local_speech", t: 9400, value: 0 }, { kind: "user_transcript", t: 9900 }];
    expect(evalAt(quiet, 11_099).decision).toBe("wait");
    expect(evalAt(quiet, 11_100).decision).toBe("authorize");
  });

  it("a transcript is speech evidence: the provider heard a word no level channel did", () => {
    const heard: GateEvent[] = [...BASE, { kind: "tentative_transcript", t: 9000 }];
    expect(evalAt(heard, 11_999).decision).toBe("wait");
    expect(evalAt(heard, 12_000).decision).toBe("authorize");
    const final: GateEvent[] = [...heard, { kind: "user_transcript", t: 9500 }];
    expect(evalAt(final, 10_699).decision).toBe("wait");
    expect(evalAt(final, 10_700).decision).toBe("authorize");
  });

  it("a final arriving while speech is still heard closes the turn only if that speech began ≥ 1 s earlier", () => {
    const trailing: GateEvent[] = [...BASE, { kind: "vad", t: 6000, value: 0.9 }, { kind: "user_transcript", t: 7500 }, { kind: "vad", t: 7600, value: 0 }];
    expect(stateOf(trailing).userTurnOpen).toBe(false);
    expect(evalAt(trailing, 8800).decision).toBe("authorize");
    const newTurn: GateEvent[] = [...BASE, { kind: "local_speech", t: 7000, value: 1 }, { kind: "user_transcript", t: 7500 }, { kind: "local_speech", t: 7600, value: 0 }];
    expect(stateOf(newTurn).userTurnOpen).toBe(true);
    expect(evalAt(newTurn, 10_599).decision).toBe("wait");
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

  it("budgets live question kinds only: debrief and tutor questions neither wait for nor spend it", () => {
    const live = [0, 1, 2, 3, 4].flatMap((i) => askedAndSpoken(i * 10_000, q(`live${i}`, { kind: "why_probe" })));
    const exhausted = (top: Question): GateEvent[] => [...live, BASE[0]!, queue(100_000, top)];
    expect(failing(exhausted(q("q6", { kind: "concept_definition" })), 100_000)).toEqual(["budget"]);
    for (const kind of ["witness", "teach_back", "prediction"] as const) {
      const e = evalAt(exhausted(q("q6", { kind })), 100_000);
      expect(e.decision).toBe("authorize");
      expect(e.conditions.budget).toEqual({ ok: true, waitMs: 0 });
    }

    const debrief = [0, 1, 2, 3, 4, 5, 6].flatMap((i) =>
      askedAndSpoken(i * 10_000, q(`d${i}`, { kind: i % 2 === 0 ? "witness" : "teach_back" })),
    );
    const afterDebrief = (top: Question): GateEvent[] => [...debrief, BASE[0]!, queue(100_000, top)];
    expect(failing(afterDebrief(q("d7", { kind: "teach_back" })), 100_000)).toEqual([]);
    const liveAfter = evalAt(afterDebrief(q("live", { kind: "counterfactual" })), 100_000);
    expect(liveAfter.decision).toBe("authorize");
    // Four live questions plus any number of debrief ones still leave room for a fifth live question.
    const mixed = [...live.slice(3), ...debrief];
    expect(failing([...mixed, BASE[0]!, queue(100_000, q("q6"))], 100_000)).toEqual([]);
  });

  it("honours a configured set of budgeted kinds", () => {
    const strict = GateConfigSchema.parse({ liveBudget: { max: 1, kinds: ["witness"] } });
    const events: GateEvent[] = [...askedAndSpoken(0, q("w1", { kind: "witness" })), BASE[0]!];
    const at = (top: Question) => evaluateGate(stateOf([...events, queue(10_000, top)], strict), 20_000, "interviewer", strict);
    expect(at(q("w2", { kind: "witness" })).conditions.budget.ok).toBe(false);
    expect(at(q("c1", { kind: "counterfactual" })).decision).toBe("authorize");
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

  it("waits while the agent speaks or an authorization holds the floor: in flight, then TTL + grace once issued", () => {
    expect(failing([...BASE, { kind: "agent_speaking", t: 9000, value: 1 }])).toEqual(["agentIdle"]);
    const inFlight: GateEvent[] = [...BASE, { kind: "authorized", t: 1000, question: q("q0") }];
    expect(failing(inFlight)).toEqual(["agentIdle"]);
    expect(evalAt(inFlight, 60_000).conditions.agentIdle.waitMs).toBe(Infinity);
    const held: GateEvent[] = [...inFlight, { kind: "issued", t: 8000, questionId: "q0" }];
    expect(failing(held)).toEqual(["agentIdle"]);
    expect(evalAt(held).conditions.agentIdle.waitMs).toBe(3500);
    expect(evalAt(held).inFlight?.id).toBe("q0");
    expect(evalAt(held, 13_500).decision).toBe("authorize");
    const spoken: GateEvent[] = [...held, { kind: "agent_speaking", t: 8500, value: 1 }];
    expect(evalAt(spoken, 20_000).conditions.agentIdle.waitMs).toBe(Infinity);
  });

  it("an unspoken hold lapses: floor and budget slot released (the server re-queues the question)", () => {
    const asked = [0, 1, 2, 3].flatMap((i) => askedAndSpoken(i * 10_000, q(`old${i}`)));
    const held: GateEvent[] = [...asked, BASE[0]!, { kind: "authorized", t: 50_000, question: q("q5") }, { kind: "issued", t: 50_300, questionId: "q5" }];
    const top = queue(50_000, q("q6"));
    expect(failing([...held, top], 51_000)).toEqual(["budget", "agentIdle"]);
    // Not yet lapsed: nothing changes before the end of the hold; spoken holds never lapse.
    expect(stateOf([...held, { kind: "lapsed", t: 55_799 }]).hold?.question.id).toBe("q5");
    expect(stateOf([...held, { kind: "agent_speaking", t: 51_000, value: 1 }, { kind: "lapsed", t: 99_000 }]).asked).toHaveLength(5);
    const lapsed = stateOf([...held, { kind: "lapsed", t: 55_800 }, top]);
    expect(lapsed.hold).toBeNull();
    expect(lapsed.asked.map((a) => a.questionId)).toEqual(["old0", "old1", "old2", "old3"]);
    expect(evaluateGate(lapsed, 55_800, "interviewer", cfg).decision).toBe("authorize");
  });

  it("a refusal releases the floor and the budget slot, and blocks the question until the queue is re-read", () => {
    const refused: GateEvent[] = [...BASE, { kind: "authorized", t: 1000, question: q("q1") }, { kind: "refused", t: 1300, questionId: "q1" }];
    const s = stateOf(refused);
    expect([s.hold, s.asked]).toEqual([null, []]);
    expect(evalAt(refused).decision).toBe("wait");
    expect(evalAt(refused).question).toBeNull();
    expect(evalAt([...refused, queue(1300, q("q1"))]).decision).toBe("wait");
    expect(evalAt([...refused, queue(1301, q("q1"))]).decision).toBe("authorize");
    // A refusal for another question (or after the agent spoke) changes nothing.
    expect(stateOf([...BASE, { kind: "authorized", t: 1000, question: q("q1") }, { kind: "refused", t: 1300, questionId: "x" }]).asked).toHaveLength(1);
  });

  it("a withdrawn authorization releases floor and budget slot without blocking the question", () => {
    const withdrawn: GateEvent[] = [...BASE, { kind: "authorized", t: 1000, question: q("q1") }, { kind: "withdrawn", t: 1300, questionId: "q1" }];
    expect(stateOf(withdrawn).asked).toEqual([]);
    expect(evalAt(withdrawn).decision).toBe("authorize");
  });

  it("after an agent turn waits for the expert's answer, or for the answer window to pass", () => {
    const spoke: GateEvent[] = [...BASE, ...askedAndSpoken(1000, q("q0"))]; // agent turn ends at 4000
    expect(evalAt(spoke, 8999).conditions.userSilent).toEqual({ ok: false, waitMs: 1 });
    expect(evalAt(spoke, 9000).decision).toBe("authorize");
    // An answer ends with answerSilenceMs of silence after its last speech signal (here its final transcript).
    const answered: GateEvent[] = [
      ...spoke,
      { kind: "vad", t: 4500, value: 0.9 },
      { kind: "vad", t: 5000, value: 0.1 },
      { kind: "user_transcript", t: 5600 },
    ];
    expect(stateOf(answered).answering).toBe(true);
    expect(evalAt(answered, 9599).decision).toBe("wait");
    expect(evalAt(answered, 9600).decision).toBe("authorize");
  });

  it("a mid-answer pause shorter than answerSilenceMs never lets the next question in (live run B)", () => {
    const pausing: GateEvent[] = [
      ...BASE,
      ...askedAndSpoken(1000, q("q0")), // agent turn ends at 4000
      { kind: "local_speech", t: 4300, value: 1 }, // "Well, let me think."
      { kind: "local_speech", t: 5800, value: 0 },
      { kind: "user_transcript", t: 6300 },
    ];
    expect(evalAt(pausing, 9000).decision).toBe("wait"); // 3.2 s into the pause: still the expert's floor
    const resumed: GateEvent[] = [...pausing, { kind: "local_speech", t: 9300, value: 1 }, { kind: "local_speech", t: 15_000, value: 0 }, { kind: "user_transcript", t: 15_500 }];
    expect(stateOf(resumed).answering).toBe(true);
    expect(evalAt(resumed, 19_499).decision).toBe("wait");
    expect(evalAt(resumed, 19_500).decision).toBe("authorize");
    // Talk after the answer ended (a gap ≥ answerSilenceMs) is ordinary speech again: 1.2 s.
    const later: GateEvent[] = [...resumed, { kind: "local_speech", t: 30_000, value: 1 }, { kind: "local_speech", t: 31_000, value: 0 }, { kind: "user_transcript", t: 31_400 }];
    expect(stateOf(later).answering).toBe(false);
    expect(evalAt(later, 32_600).decision).toBe("authorize");
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

describe("live budget through the controller (simulation)", () => {
  it("authorizes 7 debrief questions and then still 5 live ones, holding back only the 6th live question", async () => {
    const debrief = Array.from({ length: 7 }, (_, i) =>
      queue(i * 20_000, q(`d${i}`, { kind: i % 2 === 0 ? "witness" : "teach_back", t: i * 20_000 })),
    );
    const live = Array.from({ length: 6 }, (_, i) =>
      queue(140_000 + i * 20_000, q(`l${i}`, { kind: "why_probe", t: 140_000 + i * 20_000 })),
    );
    const script = [{ kind: "breakpoint", t: 0, at: true } as const, ...debrief, ...live];
    const { authorizations } = await runScript(script, {}, { untilMs: 300_000 });
    expect(authorizations.map((a) => a.questionId)).toEqual([
      ...debrief.map((_, i) => `d${i}`),
      ...live.slice(0, 5).map((_, i) => `l${i}`),
    ]);
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
    expect(evalAt([...rude, stop, { kind: "authorized", t: 9000, question: q("x") }], NOW, "tutor").decision).toBe("wait");
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

describe("evaluateGate: the tutor's coach turns", () => {
  const coach = (t: number, id = "c1") => queue(t, q(id, { kind: "coach_turn", ephemeral: true, value: 90, reason: "coach reply" }));
  /** The trainee spoke 8000–9500 (provider transcript at 9600) while working: typing and the screen moving. */
  const talked: GateEvent[] = [
    { kind: "vad", t: 8000, value: 0.9 },
    { kind: "vad", t: 9500, value: 0.1 },
    { kind: "user_transcript", t: 9600 },
    { kind: "typing", t: 9900 },
    { kind: "screen_motion", t: 9950 },
  ];

  it("answers once the trainee pauses: coachSilenceMs after their speech, whatever the screen and keyboard do", () => {
    const events = [...talked, coach(9700)];
    expect(evalAt(events, 9600 + cfg.coachSilenceMs - 1, "tutor").decision).toBe("wait");
    const e = evalAt(events, 9600 + cfg.coachSilenceMs, "tutor");
    expect(e.decision).toBe("authorize");
    expect(e.becameValidAt).toBe(9600 + cfg.coachSilenceMs);
    expect(e.conditions.screenIdle.ok).toBe(false);
    expect(e.conditions.typingIdle.ok).toBe(false);
    expect(e.reason).toBe("coach reply · coach turn: answers once the trainee pauses");
  });

  it("never speaks while the trainee is still talking, before their turn is transcribed, over the agent or off the record", () => {
    expect(evalAt([{ kind: "vad", t: 5000, value: 0.9 }, coach(5000)], NOW, "tutor").decision).toBe("wait");
    // Speech ended at 9500 with no final transcript: the provider's turn is open until transcriptWaitMs.
    const open: GateEvent[] = [{ kind: "vad", t: 8000, value: 0.9 }, { kind: "vad", t: 9500, value: 0.1 }, coach(9500)];
    expect(evalAt(open, 9500 + cfg.coachSilenceMs, "tutor").decision).toBe("wait");
    expect(evalAt(open, 9500 + cfg.transcriptWaitMs, "tutor").decision).toBe("authorize");
    expect(evalAt([coach(0), { kind: "agent_speaking", t: 9000, value: 1 }], NOW, "tutor").decision).toBe("wait");
    expect(evalAt([coach(0), { kind: "off_record", t: 9000, on: true }], NOW, "tutor").decision).toBe("wait");
  });

  it("ignores the interview's longer answer silence, the live budget, breakpoints and θ_ask", () => {
    const spent = [1, 2, 3, 4, 5].flatMap((i) => askedAndSpoken(i * 100, q(`old${i}`)));
    // The trainee answered the coach's last turn (answering: the interview would wait answerSilenceMs).
    const answered: GateEvent[] = [
      ...askedAndSpoken(6000, q("prev", { kind: "coach_turn", ephemeral: true })),
      { kind: "vad", t: 9000, value: 0.9 },
      { kind: "vad", t: 9200, value: 0.1 },
      { kind: "user_transcript", t: 9250 },
    ];
    const low = queue(9300, q("c2", { kind: "coach_turn", ephemeral: false, value: 0 }));
    expect(evalAt([...spent, ...answered, low], 9250 + cfg.coachSilenceMs, "tutor").decision).toBe("authorize");
    expect(evalAt([...spent, ...answered, low], 9250 + cfg.coachSilenceMs).decision).toBe("wait");
  });

  it("after its own turn, waits coachAnswerWindowMs for the trainee before speaking again", () => {
    const events = [...askedAndSpoken(1000, q("prev", { kind: "coach_turn", ephemeral: true })), coach(4000, "c2")];
    expect(evalAt(events, 4000 + cfg.coachAnswerWindowMs - 1, "tutor").decision).toBe("wait");
    expect(evalAt(events, 4000 + cfg.coachAnswerWindowMs, "tutor").decision).toBe("authorize");
  });

  it("a controller in tutor mode sends a coach turn while the screen moves, and withdraws it only if the trainee resumes speaking", async () => {
    const run = (extra: GateInput[]) => {
      const clock = fakeClock();
      const sent: string[] = [];
      const withdrawn: string[] = [];
      let resolve: (a: GateAuthorization) => void = () => {};
      const gate = createGateController({
        mode: "tutor",
        clock,
        issue: (question) =>
          new Promise<GateAuthorization>((r) => {
            resolve = r;
            void question;
          }),
        onAuthorize: (_a, question) => {
          sent.push(question.id);
          return true;
        },
        onWithdraw: (_a, question) => withdrawn.push(question.id),
        onHudUpdate: () => {},
      });
      gate.feed({ kind: "vad", t: 0, value: 0.9 });
      gate.feed({ kind: "vad", t: 1000, value: 0.1 });
      gate.feed({ kind: "user_transcript", t: 1100 });
      const question = q("c1", { kind: "coach_turn", ephemeral: true, value: 90 });
      gate.feed(queue(1200, question));
      clock.advanceTo(1100 + cfg.coachSilenceMs);
      for (const e of extra) gate.feed(e);
      resolve({ sessionId: "s1", questionId: "c1", nonce: "n".repeat(22), expiresAt: 0, contextVersion: 0 });
      return { sent, withdrawn, gate };
    };
    const moving = run([{ kind: "screen_motion", t: 1800 }, { kind: "typing", t: 1800 }]);
    await Promise.resolve();
    expect(moving.sent).toEqual(["c1"]);
    const resumed = run([{ kind: "vad", t: 1800, value: 0.9 }]);
    await Promise.resolve();
    expect(resumed.sent).toEqual([]);
    expect(resumed.withdrawn).toEqual(["c1"]);
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
        { kind: "authorized", t: 9000, question: q("q1") },
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
    const onWithdraw = vi.fn();
    const gate = createGateController({
      mode: "interviewer",
      clock,
      issue,
      onAuthorize: (_a, question, sample) => {
        authorized.push({ question: question.id, sample });
        return true;
      },
      onHudUpdate: (hud) => huds.push(hud.line),
      onHoldAgentHint,
      onError,
      onWithdraw,
    });
    return { clock, gate, authorized, huds, onError, onHoldAgentHint, onWithdraw };
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
    gate.feed({ kind: "agent_speaking", t: 60_000, value: 1 });
    clock.advanceTo(65_000);
    gate.feed({ kind: "agent_speaking", t: 65_000, value: 0 });
    clock.advanceTo(120_000);
    expect(authorized).toHaveLength(1);
  });

  it("re-authorizes a question whose authorization lapsed unspoken (the server re-queued it)", () => {
    const { clock, gate, authorized } = setup();
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    expect(authorized).toHaveLength(1);
    clock.advanceTo(5499); // TTL 4 s + grace 1.5 s
    expect(authorized).toHaveLength(1);
    clock.advanceTo(5550);
    expect(authorized.map((a) => a.question)).toEqual(["q1", "q1"]);
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

  it("holds the floor through a slow issue and after it, until the agent has spoken (live bug #2: two control messages 23 ms apart)", async () => {
    let resolve: () => void = () => {};
    const issue = vi.fn((question: Question) => new Promise<GateAuthorization>((r) => (resolve = () => r(authorization(question)))));
    const { clock, gate, authorized } = setup(issue);
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    gate.feed(queue(1, q("q2")));
    clock.advanceTo(4910); // the live round trip
    expect(issue).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    clock.advanceTo(4933);
    expect(authorized.map((a) => a.question)).toEqual(["q1"]);
    expect(issue).toHaveBeenCalledTimes(1);
    gate.feed({ kind: "agent_speaking", t: 5600, value: 1 });
    clock.advanceTo(9000);
    gate.feed({ kind: "agent_speaking", t: 9000, value: 0 });
    clock.advanceTo(13_999); // the answer window after the agent's turn
    expect(issue).toHaveBeenCalledTimes(1);
    clock.advanceTo(14_000);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("reports an issuer failure or a mismatched authorization; retries the question only once the queue is re-read", async () => {
    const { clock, gate, authorized, onError } = setup(() => authorization(q("other")));
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    expect(onError).toHaveBeenCalledTimes(1);
    clock.advanceTo(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
    const failing = setup(() => Promise.reject(new Error("503")));
    failing.gate.feed({ kind: "breakpoint", t: 0, at: true });
    failing.gate.feed(queue(0, q("q1")));
    await Promise.resolve();
    expect(failing.onError).toHaveBeenCalledWith(new Error("503"), expect.objectContaining({ id: "q1" }));
    failing.clock.advanceTo(1000);
    failing.gate.feed(queue(1000, q("q1")));
    await Promise.resolve();
    expect(failing.onError).toHaveBeenCalledTimes(2);
    expect(authorized).toEqual([]);
  });

  it("a refused authorization gives its live-budget slot back (live bug #4)", () => {
    let refuse = true;
    const { clock, gate, authorized } = setup((question) => {
      if (refuse) throw new Error("409 question_not_queued");
      return authorization(question);
    });
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    for (let i = 0; i < 5; i += 1) {
      clock.advanceTo(i * 1000);
      gate.feed(queue(i * 1000, q(`r${i}`)));
    }
    refuse = false;
    clock.advanceTo(10_000);
    gate.feed(queue(10_000, q("live")));
    expect(authorized.map((a) => a.question)).toEqual(["live"]);
  });

  it("withdraws an authorization that arrives after the expert started speaking: no control message, slot released", async () => {
    let resolve: () => void = () => {};
    const issue = (question: Question) => new Promise<GateAuthorization>((r) => (resolve = () => r(authorization(question))));
    const { clock, gate, authorized, onWithdraw } = setup(issue);
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    clock.advanceTo(150);
    gate.feed({ kind: "local_speech", t: 150, value: 1 });
    clock.advanceTo(270);
    resolve();
    await Promise.resolve();
    expect(authorized).toEqual([]);
    expect(onWithdraw).toHaveBeenCalledWith(expect.objectContaining({ questionId: "q1" }), expect.objectContaining({ id: "q1" }), ["userSilent"]);
    // Released at once: the question is asked again once the expert is done.
    gate.feed({ kind: "local_speech", t: 900, value: 0 });
    gate.feed({ kind: "user_transcript", t: 1300 });
    clock.advanceTo(2499);
    expect(authorized).toEqual([]);
    clock.advanceTo(2500);
    resolve();
    await Promise.resolve();
    expect(authorized.map((a) => a.question)).toEqual(["q1"]);
  });

  it("a control message the session could not send gives the authorization up until the queue is re-read", () => {
    const clock = fakeClock();
    let sends = 0;
    const gate = createGateController({
      mode: "interviewer",
      clock,
      issue: (question) => authorization(question),
      onAuthorize: () => {
        sends += 1;
        return sends > 1;
      },
      onHudUpdate: () => {},
    });
    gate.feed({ kind: "breakpoint", t: 0, at: true });
    gate.feed(queue(0, q("q1")));
    clock.advanceTo(10_000);
    expect(sends).toBe(1); // released (no hold left behind), not retried blindly
    gate.feed(queue(10_000, q("q1")));
    expect(sends).toBe(2);
    expect(gate.latencySamples()).toHaveLength(1);
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

  it("never hints once the expert has spoken, until the provider finalized the turn (live bug #1), nor while holding the floor", () => {
    const { clock, gate, onHoldAgentHint } = setup();
    gate.feed({ kind: "local_speech", t: 0, value: 1 });
    gate.feed({ kind: "local_speech", t: 2000, value: 0 });
    for (let t = 2000; t < 8000; t += 100) {
      clock.advanceTo(t);
      gate.feed({ kind: "typing", t });
    }
    expect(onHoldAgentHint).not.toHaveBeenCalled(); // speech, then its open turn (no transcript before the cap)
    gate.feed({ kind: "user_transcript", t: 8000 });
    gate.feed({ kind: "typing", t: 8000 });
    expect(onHoldAgentHint).toHaveBeenCalledTimes(1);
    gate.feed({ kind: "breakpoint", t: 8000, at: true });
    gate.feed(queue(8000, q("q1", { ephemeral: true })));
    clock.advanceTo(10_000); // authorized at 9500 and issued; the agent never speaks: held until 15 000
    const before = onHoldAgentHint.mock.calls.length;
    gate.feed({ kind: "typing", t: 11_000 });
    expect(onHoldAgentHint).toHaveBeenCalledTimes(before);
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
