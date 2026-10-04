/** Writes a live run's evidence (JSON + text summary) under docs/evidence/live/<group>/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_DIR, SYNTHETIC_LABEL, BASE_URL } from "./env";
import type { Expert, Entry } from "./expert";
import type { HarnessEvent } from "./harness";
import type { RunAnalysis } from "./analyze";

export function evidencePath(group: string, name: string): string {
  const dir = join(EVIDENCE_DIR, group);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

export function conversationIds(events: readonly HarnessEvent[], ledger: readonly Entry[]): string[] {
  const ids = new Set<string>();
  for (const e of ledger) if (typeof e.payload.conversationId === "string") ids.add(e.payload.conversationId);
  for (const e of events) {
    const m = /"conversationId":"(conv_[A-Za-z0-9]+)"/.exec(String(e.body ?? ""));
    if (m?.[1] !== undefined) ids.add(m[1]);
  }
  return [...ids];
}

const fmt = (s: { n: number; p50: number | null; p95: number | null; max: number | null }) =>
  s.n === 0 ? "n=0" : `n=${s.n} p50=${s.p50} ms p95=${s.p95} ms max=${s.max} ms`;

export function summarizeRun(title: string, sessionId: string, convIds: string[], a: RunAnalysis, extra: string[] = []): string {
  const lines = [
    `${title}`,
    `Label: expert speech is ${SYNTHETIC_LABEL}.`,
    `Target: ${BASE_URL}`,
    `Session: ${sessionId}`,
    `ElevenLabs conversation(s): ${convIds.join(", ") || "(none recorded)"}`,
    "",
    `Questions authorized by the gate (ledger gate.authorized): ${a.counts.questionsAuthorized}`,
    `Custom-LLM speak decisions: ${a.counts.llmSpeak} · skip_turn decisions: ${a.counts.llmSkip}`,
    `Agent audio turns measured on the WebRTC track: ${a.counts.agentAudioTurns}`,
    `Expert lines spoken: ${a.counts.expertLinesSpoken} · expert utterances ledgered: ${a.counts.expertUtterancesLedger}`,
    `Keystrokes: ${a.counts.keystrokes} · wheel (scroll input) events: ${a.counts.wheelEvents} · scroll events (incl. programmatic): ${a.counts.scrollEvents}`,
    `Questions queued / dropped / re-queued (authorized, never spoken): ${a.counts.questionsQueued} / ${a.counts.questionsDropped} / ${a.counts.questionsRequeued}`,
    "",
    `INTERRUPTIONS (authorization or agent audio onset inside [speech, +1.2 s], [keystroke, +1.5 s], [wheel scroll, +1.5 s]): ${a.interruptions.count}`,
    ...a.interruptions.authorizationsInsideProtectedWindows.map((v) => `  auth ${String(v.questionId)} at ${v.decidedAt} inside ${v.window.kind} ${v.window.start}..${v.window.guardEnd}`),
    ...a.interruptions.agentAudioStartsInsideProtectedWindows.map((v) => `  agent audio at ${v.agentStart} inside ${v.window.kind} ${v.window.start}..${v.window.guardEnd} "${v.text}"`),
    `Talk-over (agent audio overlapping expert speech, either direction): ${a.interruptions.talkOver.length}`,
    ...a.interruptions.talkOver.map((o) => `  ${o.startedFirst} started first: expert ${o.expert.start}..${o.expert.end} (${o.expert.label ?? ""}), agent ${o.agent.start}..${o.agent.end}`),
    "",
    `Authorization latency (decidedAt − becameValidAt, ledger): ${fmt(a.authorizationLatencyMs)}`,
    `gate/authorize round trip (browser → production → browser): ${fmt(a.authorizeRoundTripMs)}`,
    `Conditions valid → control message sent: ${fmt(a.conditionsValidToControlSentMs)}`,
    `Control messages sent: ${a.controlMessagesSent} · not followed by agent speech: ${a.controlMessagesWithoutAgentSpeech}`,
    `First audio (control message sent → agent audio on the track): ${fmt(a.firstAudioMs)}`,
    `Control message sent → first ElevenLabs audio event on the data channel: ${fmt(a.firstAudioEventMs)}`,
    `Control message sent → agent_response text: ${fmt(a.firstAgentTextMs)}`,
    "",
    `Control turns never evidence: ${a.controlNeverEvidence.ok ? "OK" : "VIOLATED"} ${JSON.stringify(a.controlNeverEvidence)}`,
    "",
    "Agent turns (as heard):",
    ...a.agentTurns.map((t) => `  ${t.start}..${t.end} "${t.text}"`),
    ...extra,
  ];
  return `${lines.join("\n")}\n`;
}

/** Spent, single-use gate nonces are still credentials in form: never written to evidence. */
export function redactNonces(text: string): string {
  return text.replace(/ctl:[A-Za-z0-9_-]+/g, "ctl:<redacted>").replace(/(\\?"nonce\\?"\s*:\s*\\?")[A-Za-z0-9_-]+/g, "$1<redacted>");
}

export function saveRun(group: string, name: string, expert: Expert, data: Record<string, unknown>, summary: string): void {
  writeFileSync(
    evidencePath(group, `${name}.json`),
    `${redactNonces(JSON.stringify({ label: SYNTHETIC_LABEL, target: BASE_URL, sessionId: expert.sessionId, ...data }, null, 2))}\n`,
  );
  writeFileSync(evidencePath(group, `${name}.txt`), summary);
}

/** VAD scores thinned for storage: every crossing of `threshold` and one sample per second otherwise. */
export function thinVad(events: readonly HarnessEvent[], threshold = 0.4): HarnessEvent[] {
  let last = -Infinity;
  let above = false;
  return events.filter((e) => {
    if (e.type !== "vad") return true;
    const v = Number(e.v);
    const crossing = v >= threshold !== above;
    above = v >= threshold;
    if (crossing || e.t - last >= 1000 || v >= threshold) {
      last = e.t;
      return true;
    }
    return false;
  });
}
