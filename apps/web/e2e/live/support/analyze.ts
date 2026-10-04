/**
 * Ground-truth analysis of one live run: the script's own expert speech, typing and scrolling windows
 * (harness events, page clock = Date.now, the gate's clock) against the agent's behaviour (gate
 * authorizations from the production ledger, control messages leaving the browser, the agent's audio
 * measured on the remote WebRTC track). Pure functions; no conclusions are hard-coded.
 */
import type { HarnessEvent } from "./harness";
import type { Entry } from "./expert";

export const SPEECH_GUARD_MS = 1200;
export const TYPING_GUARD_MS = 1500;
export const SCROLL_GUARD_MS = 1500;

export type Window = { kind: "speech" | "typing" | "scroll"; start: number; end: number; guardEnd: number; label?: string };
export type AgentTurn = { start: number; end: number; text: string };

function merge(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const out: Window[] = [];
  for (const w of sorted) {
    const last = out.at(-1);
    if (last !== undefined && last.kind === w.kind && w.start <= last.guardEnd) {
      last.end = Math.max(last.end, w.end);
      last.guardEnd = Math.max(last.guardEnd, w.guardEnd);
    } else out.push({ ...w });
  }
  return out;
}

export function protectedWindows(events: readonly HarnessEvent[]): Window[] {
  const speech: Window[] = [];
  const open = new Map<string, HarnessEvent>();
  for (const e of events) {
    if (e.type === "speech_start") open.set(String(e.key) + String(e.label), e);
    if (e.type === "speech_end") {
      const k = String(e.key) + String(e.label);
      const s = open.get(k);
      if (s !== undefined) {
        speech.push({ kind: "speech", start: s.t, end: e.t, guardEnd: e.t + SPEECH_GUARD_MS, label: String(s.label) });
        open.delete(k);
      }
    }
  }
  // A clip still playing when the run ended.
  const lastT = events.at(-1)?.t ?? 0;
  for (const s of open.values()) speech.push({ kind: "speech", start: s.t, end: lastT, guardEnd: lastT + SPEECH_GUARD_MS, label: String(s.label) });
  const typing = events.filter((e) => e.type === "key").map((e): Window => ({ kind: "typing", start: e.t, end: e.t, guardEnd: e.t + TYPING_GUARD_MS }));
  const scroll = events.filter((e) => e.type === "wheel").map((e): Window => ({ kind: "scroll", start: e.t, end: e.t, guardEnd: e.t + SCROLL_GUARD_MS }));
  return [...merge(speech), ...merge(typing), ...merge(scroll)].sort((a, b) => a.start - b.start);
}

/** The agent's spoken turns from the remote-audio analyser (several watchers of one track are collapsed). */
export function agentTurns(events: readonly HarnessEvent[]): AgentTurn[] {
  const starts = events.filter((e) => e.type === "agent_audio_start").map((e) => e.t).sort((a, b) => a - b);
  const ends = events.filter((e) => e.type === "agent_audio_end").map((e) => e.t).sort((a, b) => a - b);
  const responses = events.filter((e) => e.type === "agent_response");
  const turns: AgentTurn[] = [];
  for (const start of starts) {
    const last = turns.at(-1);
    if (last !== undefined && start <= last.end + 50) continue;
    const end = ends.find((t) => t >= start) ?? start;
    const response = responses.find((r) => r.t >= start - 200 && r.t <= end + 3000);
    turns.push({ start, end, text: typeof response?.text === "string" ? response.text : "" });
  }
  return turns;
}

/**
 * Half-open protected window [start, guardEnd): the plan's conditions are "silent for ≥ 1.2 s",
 * "last keystroke ≥ 1.5 s", "screen idle ≥ 1.5 s", so a decision exactly at the guard end is allowed.
 */
const inside = (t: number, w: Window): boolean => t >= w.start && t < w.guardEnd;

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? null;
}

const stats = (values: readonly number[]) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: values.length === 0 ? null : Math.max(...values),
  values,
});

const CONTROL = /⟦ctl:|ctl:[A-Za-z0-9_-]{8,}/;

export function analyzeRun(events: readonly HarnessEvent[], ledger: readonly Entry[]) {
  const windows = protectedWindows(events);
  const turns = agentTurns(events);
  const authorized = ledger.filter((e) => e.kind === "gate.authorized");
  const ctlSent = events.filter((e) => e.type === "ctl_sent").map((e) => e.t).sort((a, b) => a - b);
  const authorizeFetches = events.filter((e) => e.type === "fetch_gate_authorize");

  // 1. Interruptions: an authorization decided, or agent audio starting, inside a protected window.
  const authViolations = authorized.flatMap((a) => {
    const decidedAt = Number(a.payload.decidedAt);
    return windows.filter((w) => inside(decidedAt, w)).map((w) => ({ entryId: a.id, questionId: a.payload.questionId, decidedAt, window: w }));
  });
  const audioViolations = turns.flatMap((turn) => windows.filter((w) => inside(turn.start, w)).map((w) => ({ agentStart: turn.start, text: turn.text, window: w })));
  // Talk-over in either direction (reported, classified by who started first).
  const speech = windows.filter((w) => w.kind === "speech");
  const overlaps = turns.flatMap((turn) =>
    speech
      .filter((w) => turn.start <= w.end && w.start <= turn.end)
      .map((w) => ({ agent: { start: turn.start, end: turn.end, text: turn.text }, expert: w, startedFirst: w.start < turn.start ? "expert" : "agent" })),
  );

  // 2. Authorization latency (gate: conditions valid → decided) and the server round trip.
  const decisionLatency = authorized.map((a) => Number(a.payload.decidedAt) - Number(a.payload.becameValidAt));
  const roundTrip = authorizeFetches.filter((f) => f.status === 200).map((f) => Number(f.doneAt) - f.t);
  const validToCtl = authorized.flatMap((a) => {
    const decidedAt = Number(a.payload.decidedAt);
    const sent = ctlSent.find((t) => t >= decidedAt && t <= decidedAt + 5000);
    return sent === undefined ? [] : [sent - Number(a.payload.becameValidAt)];
  });

  // 3. First audio: control message sent → first agent audio; and → agent_response text.
  const responses = events.filter((e) => e.type === "agent_response").map((e) => e.t);
  // Each control message is paired only with agent output before the next control message (a control
  // message the custom LLM did not speak for must not borrow the next question's audio).
  const nextCtl = (i: number): number => Math.min(ctlSent[i + 1] ?? Infinity, (ctlSent[i] ?? 0) + 8000);
  const firstAudio = ctlSent.flatMap((t, i) => {
    const turn = turns.find((x) => x.start >= t && x.start < nextCtl(i));
    return turn === undefined ? [] : [turn.start - t];
  });
  const audioEvents = events.filter((e) => e.type === "el_audio").map((e) => e.t);
  const firstAudioEvent = ctlSent.flatMap((t, i) => {
    const a = audioEvents.find((x) => x >= t && x < nextCtl(i));
    return a === undefined ? [] : [a - t];
  });
  const firstText = ctlSent.flatMap((t, i) => {
    const r = responses.find((x) => x >= t && x < Math.min(ctlSent[i + 1] ?? Infinity, t + 10000));
    return r === undefined ? [] : [r - t];
  });
  const controlWithoutSpeech = ctlSent.filter((t, i) => !turns.some((x) => x.start >= t && x.start < nextCtl(i))).length;

  // 4. Control turns never in evidence.
  const transcripts = ledger.filter((e) => e.kind === "utterance.transcript");
  const controlInTranscripts = transcripts.filter((e) => CONTROL.test(String(e.payload.text)));
  const controlInAgentUtterances = ledger.filter((e) => e.kind === "agent.utterance" && CONTROL.test(String(e.payload.text)));
  const controlEchoedToBrowser = events.filter((e) => e.type === "user_transcript" && CONTROL.test(String(e.text)));
  const controlPosted = events.filter((e) => e.type === "fetch_utterances" && CONTROL.test(String(e.body)));
  const controlEntries = ledger.filter((e) => e.kind === "gate.control_message");
  const controlEntriesNotSystem = controlEntries.filter((e) => e.source !== "system_control");
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const ruleEvidence = ledger
    .filter((e) => e.kind === "rule.confirmed" || e.kind === "rule.revised")
    .flatMap((e) => {
      const rule = (e.payload.rule ?? {}) as { evidence?: { kind: string; utteranceId?: string; frameIds?: string[]; eventIds?: string[] }[] };
      return (rule.evidence ?? []).flatMap((ev) => [ev.utteranceId, ...(ev.frameIds ?? []), ...(ev.eventIds ?? [])].filter((x): x is string => x !== undefined));
    });
  const evidenceFromControl = ruleEvidence.filter((id) => byId.get(id)?.source === "system_control");

  const speakDecisions = ledger.filter((e) => e.kind === "llm.turn_decision" && e.payload.decision === "speak");
  const skipDecisions = ledger.filter((e) => e.kind === "llm.turn_decision" && e.payload.decision === "skip_turn");

  return {
    counts: {
      questionsAuthorized: authorized.length,
      llmSpeak: speakDecisions.length,
      llmSkip: skipDecisions.length,
      agentAudioTurns: turns.length,
      agentUtterancesLedger: ledger.filter((e) => e.kind === "agent.utterance").length,
      expertUtterancesLedger: transcripts.length,
      expertLinesSpoken: speech.length,
      keystrokes: events.filter((e) => e.type === "key").length,
      wheelEvents: events.filter((e) => e.type === "wheel").length,
      scrollEvents: events.filter((e) => e.type === "scroll").length,
      questionsQueued: ledger.filter((e) => e.kind === "question.queued").length,
      questionsDropped: ledger.filter((e) => e.kind === "question.dropped").length,
      /** Authorized but never spoken, so put back in the queue (not counted as asked, no budget spent). */
      questionsRequeued: ledger.filter((e) => e.kind === "question.requeued").length,
    },
    interruptions: {
      count: authViolations.length + audioViolations.length,
      authorizationsInsideProtectedWindows: authViolations,
      agentAudioStartsInsideProtectedWindows: audioViolations,
      talkOver: overlaps,
    },
    authorizationLatencyMs: stats(decisionLatency),
    authorizeRoundTripMs: stats(roundTrip),
    conditionsValidToControlSentMs: stats(validToCtl),
    controlMessagesSent: ctlSent.length,
    controlMessagesWithoutAgentSpeech: controlWithoutSpeech,
    firstAudioMs: stats(firstAudio),
    firstAudioEventMs: stats(firstAudioEvent),
    firstAgentTextMs: stats(firstText),
    controlNeverEvidence: {
      ok:
        controlInTranscripts.length === 0 &&
        controlInAgentUtterances.length === 0 &&
        controlEchoedToBrowser.length === 0 &&
        controlPosted.length === 0 &&
        controlEntriesNotSystem.length === 0 &&
        evidenceFromControl.length === 0,
      controlMessagesLedgered: controlEntries.length,
      controlInTranscripts: controlInTranscripts.length,
      controlInAgentUtterances: controlInAgentUtterances.length,
      controlEchoedToBrowserAsUserTranscript: controlEchoedToBrowser.length,
      controlPostedAsUtterance: controlPosted.length,
      controlEntriesNotSystemControl: controlEntriesNotSystem.length,
      ruleEvidenceCitingControl: evidenceFromControl.length,
    },
    agentTurns: turns,
    windows,
  };
}

export type RunAnalysis = ReturnType<typeof analyzeRun>;
