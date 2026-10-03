import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "@vashistha/core";
import { computeCompliance } from "../../lib/client/judge/compliance";
import { percentiles } from "../../lib/client/judge/stats";
import { formatFeatureValue, tickerLines } from "../../lib/client/judge/ticker";
import { fixtures as f } from "./judge-fixtures";
import { entry } from "./interview-support";

const text = (entries: LedgerEntry[]) => tickerLines(entries, 100).map((l) => l.text);

describe("event ticker lines", () => {
  it("renders screen events with domain labels and values", () => {
    expect(text([f.openCase(), f.boRead(), f.riskChange(), f.action()])).toEqual([
      "Opened case · NS-2026-0101",
      "Largest beneficial owner share read: 35% · NS-2026-0101",
      "Analyst risk rating changed: Medium→High · NS-2026-0101",
      "Action: Send to enhanced review · NS-2026-0101",
    ]);
    expect(formatFeatureValue("pep", true)).toBe("Yes");
    expect(formatFeatureValue("uboOwnershipPct", 24.5)).toBe("24.50%");
  });

  it("renders decisions, questions, gate and agent turns, resolving question text from the ledger", () => {
    const lines = tickerLines([f.queued("q-1"), f.authorized("q-1"), f.control("q-1"), f.speak("q-1"), f.skip(), f.decision()], 100);
    expect(lines.map((l) => [l.source, l.tone, l.text])).toEqual([
      ["engine", "system", expect.stringMatching(/^Question queued · contradiction detected · EIG 0\.61 bits · “You sent this one/)],
      ["engine", "system", expect.stringMatching(/^Gate authorized · “You sent this one.*” · 12 ms after valid$/)],
      ["system_control", "control", "Control message"],
      ["engine", "system", expect.stringMatching(/^Agent asks · “You sent/)],
      ["engine", "system", "Agent turn skipped (No authorization)"],
      ["dom", "evidence", "Decision saved: Send to enhanced review · NS-2026-0101"],
    ]);
  });

  it("shows control and privacy traffic as control lines, never as evidence", () => {
    const lines = tickerLines([f.offRecord(), f.onRecord(), f.control("q-1"), f.utterance("Anything over 25 percent.")], 100);
    expect(lines.map((l) => [l.source, l.tone])).toEqual([
      ["system_control", "privacy"],
      ["system_control", "privacy"],
      ["system_control", "control"],
      ["voice", "evidence"],
    ]);
    expect(lines[3]?.text).toBe("Expert: “Anything over 25 percent.”");
  });

  it("labels entries that break their registered schema or source as unreadable", () => {
    const wrongSource = entry("case.decision", "engine", { caseId: "NS-1", action: "approve", edits: {}, result: { decision: "allow" } });
    const badPayload = entry("screen.event", "dom", { kind: "open_case" });
    expect(text([wrongSource, badPayload])).toEqual([
      "Unreadable case.decision entry (does not match its registered schema)",
      "Unreadable screen.event entry (does not match its registered schema)",
    ]);
    expect(tickerLines([wrongSource], 10)[0]?.tone).toBe("warning");
  });

  it("keeps only the newest lines", () => {
    const entries = Array.from({ length: 5 }, () => f.openCase());
    expect(tickerLines(entries, 2).map((l) => l.id)).toEqual(entries.slice(-2).map((e) => e.id));
  });
});

describe("compliance strip", () => {
  const empty = { liveQuestions: 0, guardrail: false, debriefGaps: 0, teachBack: false, unseenCaseIntercepted: false };

  it("starts with every item pending", () => {
    expect(computeCompliance([])).toEqual(empty);
    expect(computeCompliance([f.openCase(), f.decision()])).toEqual(empty);
  });

  it("counts a live question only once the gate authorized it and the agent spoke it", () => {
    const queued = [f.queued("q-1"), f.queued("q-2"), f.queued("q-w", "witness")];
    expect(computeCompliance([...queued, f.authorized("q-1")]).liveQuestions).toBe(0);
    const speak = f.speak("q-1");
    const asked = [...queued, f.authorized("q-1"), speak];
    expect(computeCompliance(asked).liveQuestions).toBe(1);
    // A speak without an authorization does not count; neither does a debrief (witness) question.
    expect(computeCompliance([...asked, f.speak("q-2"), f.authorized("q-w"), f.speak("q-w")]).liveQuestions).toBe(1);
    // An aborted stream un-counts the question until a later speak succeeds.
    const aborted = [...asked, f.aborted(speak, "q-1")];
    expect(computeCompliance(aborted).liveQuestions).toBe(0);
    expect(computeCompliance([...aborted, f.speak("q-1")]).liveQuestions).toBe(1);
  });

  it("earns Guardrail only for a confirmed guardrail rule", () => {
    expect(computeCompliance([f.ruleConfirmed("decision")]).guardrail).toBe(false);
    expect(computeCompliance([f.ruleConfirmed("decision"), f.ruleConfirmed("guardrail")]).guardrail).toBe(true);
  });

  it("counts closed debrief gaps and the confirmed teach-back", () => {
    const c = computeCompliance([f.witnessResolved(1), f.witnessResolved(2), f.witnessResolved(3), f.teachbackConfirmed()]);
    expect(c.debriefGaps).toBe(3);
    expect(c.teachBack).toBe(true);
  });

  it("marks the unseen case intercepted unless the violating action is committed afterwards", () => {
    const intervention = f.intervention("NS-2026-0201", "approve");
    expect(computeCompliance([intervention]).unseenCaseIntercepted).toBe(true);
    expect(computeCompliance([intervention, f.decision("NS-2026-0201", "requestDocuments")]).unseenCaseIntercepted).toBe(true);
    expect(computeCompliance([intervention, f.decision("NS-2026-0201", "approve")]).unseenCaseIntercepted).toBe(false);
    expect(
      computeCompliance([intervention, f.decision("NS-2026-0201", "approve", { kind: "escalated", note: "To the controller." })])
        .unseenCaseIntercepted,
    ).toBe(true);
    // A decision before the intervention is not a response to it.
    const earlier = f.decision("NS-2026-0201", "approve");
    expect(computeCompliance([earlier, f.intervention("NS-2026-0201", "approve")]).unseenCaseIntercepted).toBe(true);
  });

  it("ignores entries that break their schema", () => {
    expect(computeCompliance([entry("teachback.confirmed", "dom", { utteranceId: "u", rulebookRevision: 1 })]).teachBack).toBe(false);
  });
});

describe("latency percentiles", () => {
  it("uses nearest rank", () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([40, 10, 30, 20])).toEqual({ p50: 20, p95: 40, n: 4 });
  });
});
