/** P11 replay client: the virtual clock, the HUD derived from recorded gate entries, and follow focus. */
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@vashistha/core";
import { IDLE_GAP_CAP_MS, INITIAL_PLAYBACK, LEAD_IN_MS, advance, buildTimeline, countAt, positionOf, remap } from "../../lib/client/replay/clock";
import { focusOf } from "../../lib/client/replay/follow";
import { replayHud } from "../../lib/client/replay/hud";

describe("virtual clock", () => {
  const times = [1_000, 1_100, 1_100, 61_100, 61_400];

  it("real time keeps every recorded gap; capped time shortens only gaps above the cap", () => {
    const real = buildTimeline(times, null);
    expect(real.offsets).toEqual([LEAD_IN_MS, LEAD_IN_MS + 100, LEAD_IN_MS + 100, LEAD_IN_MS + 60_100, LEAD_IN_MS + 60_400]);
    expect(real.shortened).toBe(0);
    const capped = buildTimeline(times, IDLE_GAP_CAP_MS);
    expect(capped.offsets).toEqual([LEAD_IN_MS, LEAD_IN_MS + 100, LEAD_IN_MS + 100, LEAD_IN_MS + 100 + IDLE_GAP_CAP_MS, LEAD_IN_MS + 400 + IDLE_GAP_CAP_MS]);
    expect(capped.shortened).toBe(1);
  });

  it("counts entries at a position; seeking to n applies exactly n entries", () => {
    const tl = buildTimeline(times, null);
    expect(countAt(tl, 0)).toBe(0);
    expect(countAt(tl, LEAD_IN_MS)).toBe(1);
    // Two entries at the same instant appear together.
    expect(countAt(tl, LEAD_IN_MS + 100)).toBe(3);
    for (const n of [0, 1, 3, 4, 5]) expect(countAt(tl, positionOf(tl, n))).toBe(n);
  });

  it("plays at speed and stops at the end; pausing freezes it; remapping keeps the applied entries", () => {
    const tl = buildTimeline(times, IDLE_GAP_CAP_MS);
    const playing = { ...INITIAL_PLAYBACK, playing: true, speed: 4 };
    expect(advance(playing, tl, 100).position).toBe(400);
    expect(advance({ ...playing, playing: false }, tl, 100).position).toBe(0);
    const end = advance(playing, tl, 1e9);
    expect(end).toMatchObject({ position: tl.duration, playing: false });
    const at4 = { ...playing, position: positionOf(tl, 4) };
    expect(countAt(buildTimeline(times, null), remap(at4, tl, buildTimeline(times, null)).position)).toBe(4);
  });
});

let seq = 0;
function entry(kind: string, source: LedgerEntry["source"], payload: unknown, sessionId = "11111111-1111-4111-8111-111111111111"): LedgerEntry {
  seq += 1;
  return { id: `e${seq}`, sessionId, sequence: seq, source, kind, occurredAt: seq, receivedAt: seq, traceId: "t", parentIds: [], schemaVersion: 1, privacyEpoch: 0, payload };
}

const question = {
  id: "q1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  kind: "why_probe",
  text: "Why enhanced review here?",
  target: { candidateIds: [] },
  value: 0.61,
  reason: "contradiction detected",
  ephemeral: false,
  createdAt: 1,
  contextVersion: 1,
  parentIds: [],
};

describe("HUD from recorded gate entries", () => {
  it("LISTENING → WAITING (queued) → ASKING (authorized, recorded conditions) → LISTENING (answered)", () => {
    expect(replayHud([]).status).toBe("LISTENING");
    const queued = entry("question.queued", "engine", question);
    const parsed = replayHud([queued]);
    if (parsed.status !== "WAITING") {
      // The fixture must satisfy the live QuestionSchema; fail loudly if it drifted.
      throw new Error(`question fixture rejected: ${JSON.stringify(parsed)}`);
    }
    expect(parsed.value).toEqual({ level: 0.61, text: "0.61" });
    expect(parsed.judge).toBeNull();
    const authorized = entry("gate.authorized", "engine", {
      questionId: "q1",
      contextVersion: 1,
      becameValidAt: 10,
      decidedAt: 12,
      conditions: { typingIdle: true, userSilent: true, screenIdle: false },
    });
    const asking = replayHud([queued, authorized]);
    expect(asking.status).toBe("ASKING");
    expect(asking.reason).toBe("contradiction detected · EIG 0.61 bits");
    expect(asking.judge?.map((r) => [r.label, r.ok])).toEqual([
      ["Typing", true],
      ["Speaking", true],
      ["Screen moving", false],
    ]);
    const answered = entry("utterance.transcript", "voice", { conversationId: "c", text: "Because of the PEP flag.", t0Ms: 0, t1Ms: 1, frameIds: [] });
    expect(replayHud([queued, authorized, answered]).status).toBe("LISTENING");
    expect(replayHud([queued, entry("question.dropped", "engine", { questionId: "q1", reason: "superseded" })]).status).toBe("LISTENING");
  });
});

describe("follow focus", () => {
  it("debrief entries of an expert session open the debrief; everything else its CaseDesk", () => {
    const mode = (id: string) => (id === "x" ? ("expert" as const) : ("novice" as const));
    expect(focusOf(entry("witness.found", "solver", {}, "x"), mode)).toEqual({ sessionId: "x", tab: "debrief" });
    expect(focusOf(entry("workmap.generated", "engine", {}, "x"), mode)).toEqual({ sessionId: "x", tab: "workmap" });
    expect(focusOf(entry("case.decision", "dom", {}, "x"), mode)).toEqual({ sessionId: "x", tab: "casedesk" });
    expect(focusOf(entry("rule.confirmed", "engine", {}, "y"), mode)).toEqual({ sessionId: "y", tab: "casedesk" });
  });
});
