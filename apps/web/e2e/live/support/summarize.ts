/**
 * Aggregates the saved live runs (docs/evidence/live/**) into SUMMARY.json / SUMMARY.txt. Reads only
 * the evidence files (harness events + production ledger excerpts); measures nothing new.
 *   npx tsx e2e/live/support/summarize.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRun, percentile } from "./analyze";
import { EVIDENCE_DIR, SYNTHETIC_LABEL } from "./env";
import type { Entry } from "./expert";
import type { HarnessEvent } from "./harness";

type Run = { file: string; sessionId: string; conversationIds: string[]; events: HarnessEvent[]; ledger: Entry[]; spoken?: { label: string; start: number; end: number; gain: number; text: string }[] };

const load = (file: string): Run => ({ ...(JSON.parse(readFileSync(file, "utf8")) as Run), file });
const runFiles = (dir: string, re: RegExp): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];

const stat = (v: readonly number[]) => ({ n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v.length ? Math.max(...v) : null });
const fmt = (s: ReturnType<typeof stat>) => (s.n === 0 ? "n=0" : `p50 ${s.p50} · p95 ${s.p95} · max ${s.max} ms (n=${s.n})`);

/** Server-side timing of each successful authorization: request → ledger row → nonce issuance → response. */
function authorizeTimings(run: Run) {
  const auth = new Map(run.ledger.filter((e) => e.kind === "gate.authorized").map((e) => [String(e.payload.questionId), e]));
  return run.events.flatMap((e) => {
    if (e.type !== "fetch_gate_authorize" || e.status !== 200) return [];
    const body = JSON.parse(String(e.response)) as { authorization?: { questionId: string; expiresAt: number } };
    const a = body.authorization;
    const row = a && auth.get(a.questionId);
    if (!a || !row) return [];
    const issued = a.expiresAt - 4000;
    return [{ requestToRow: row.receivedAt - e.t, rowToIssue: issued - row.receivedAt, rtt: Number(e.doneAt) - e.t }];
  });
}

function lostAuthorizations(run: Run) {
  const decisions = run.ledger.filter((e) => e.kind === "llm.turn_decision");
  const spoke = new Set(decisions.filter((d) => d.payload.decision === "speak").map((d) => String(d.payload.questionId)));
  return run.ledger
    .filter((e) => e.kind === "gate.authorized" && !spoke.has(String(e.payload.questionId)))
    .map((e) => String(e.payload.questionId));
}

function refused(run: Run) {
  return run.events
    .filter((e) => e.type === "fetch_gate_authorize" && e.status !== 200)
    .map((e) => (JSON.parse(String(e.response)) as { error?: string }).error ?? String(e.status));
}

function vadByGain(run: Run) {
  const vad = run.events.filter((e) => e.type === "vad").map((e) => ({ t: e.t, v: Number(e.v) }));
  return (run.spoken ?? [])
    .filter((s) => s.label.startsWith("short@"))
    .map((s) => ({ text: s.text, gain: s.gain, maxVad: Math.max(0, ...vad.filter((x) => x.t >= s.start + 150 && x.t <= s.end + 600).map((x) => x.v)) }));
}

const p3 = runFiles(join(EVIDENCE_DIR, "p3"), /^run-[a-e]-.*\.json$/).map(load);
const p4 = [
  ...runFiles(join(EVIDENCE_DIR, "p4"), /^p4-run-.*\.json$/),
  ...readdirSync(join(EVIDENCE_DIR, "p4"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => runFiles(join(EVIDENCE_DIR, "p4", d.name), /^p4-run-.*\.json$/)),
].map(load);

const rows = [...p3, ...p4].map((run) => {
  const a = analyzeRun(run.events, run.ledger);
  return {
    file: run.file ?? "",
    sessionId: run.sessionId,
    conversationIds: run.conversationIds,
    questionsAuthorized: a.counts.questionsAuthorized,
    questionsSpoken: a.counts.llmSpeak,
    interruptions: a.interruptions.count,
    interruptionDetail: [
      ...a.interruptions.authorizationsInsideProtectedWindows.map((v) => `authorization ${v.decidedAt - v.window.start} ms into a ${v.window.kind} window`),
      ...a.interruptions.agentAudioStartsInsideProtectedWindows.map((v) => `agent audio ${v.agentStart - v.window.start} ms into a ${v.window.kind} window`),
    ],
    talkOver: a.interruptions.talkOver.map((o) => `${o.startedFirst} first`),
    authorizationLatency: a.authorizationLatencyMs.values,
    authorizeRtt: a.authorizeRoundTripMs.values,
    validToControl: a.conditionsValidToControlSentMs.values,
    firstAudio: a.firstAudioMs.values,
    firstAudioEvent: a.firstAudioEventMs.values,
    firstText: a.firstAgentTextMs.values,
    controlNeverEvidence: a.controlNeverEvidence.ok,
    lostAuthorizations: lostAuthorizations(run),
    refusedAuthorizations: refused(run),
    serverAuthorizeTimings: authorizeTimings(run),
    vadByGain: vadByGain(run),
  };
});
const isP3 = (r: { sessionId: string }) => p3.some((x) => x.sessionId === r.sessionId);
const p3Rows = rows.filter(isP3);
const all = (k: "authorizationLatency" | "authorizeRtt" | "validToControl" | "firstAudio" | "firstAudioEvent" | "firstText", rs = p3Rows) => stat(rs.flatMap((r) => r[k]));

const lines: string[] = [
  `LIVE acceptance runs — production — expert speech is ${SYNTHETIC_LABEL}`,
  "",
  "P3 — five scripted typing/talking runs (gate + voice)",
  ...p3Rows.map(
    (r) =>
      `  ${r.file.split("/").pop()?.slice(0, 14)} session ${r.sessionId} conv ${r.conversationIds.join(",")}\n` +
      `    questions authorized ${r.questionsAuthorized}, spoken ${r.questionsSpoken}; INTERRUPTIONS ${r.interruptions}${r.interruptionDetail.length ? ` (${r.interruptionDetail.join("; ")})` : ""}; talk-over ${r.talkOver.length}${r.talkOver.length ? ` (${r.talkOver.join(", ")})` : ""}\n` +
      `    auth latency ${fmt(stat(r.authorizationLatency))}; authorize RTT ${fmt(stat(r.authorizeRtt))}; first audio ${fmt(stat(r.firstAudio))}\n` +
      `    control never evidence ${r.controlNeverEvidence}; authorized-but-never-spoken ${r.lostAuthorizations.length}; refused authorizations ${r.refusedAuthorizations.join(", ") || "none"}`,
  ),
  `  TOTAL interruptions across the 5 runs: ${p3Rows.reduce((n, r) => n + r.interruptions, 0)} (threshold 0)`,
  `  Gate decision latency (decidedAt − becameValidAt), all 5 runs: ${fmt(all("authorizationLatency"))} (bound 250 ms)`,
  `  Including the gate/authorize round trip to production: ${fmt(all("validToControl"))} (conditions valid → control message sent)`,
  `  First audio (control message sent → agent audio on the WebRTC track): ${fmt(all("firstAudio"))}`,
  `  First audio event on the data channel: ${fmt(all("firstAudioEvent"))} · first agent_response text: ${fmt(all("firstText"))}`,
  `  Questions authorized ${p3Rows.reduce((n, r) => n + r.questionsAuthorized, 0)}, spoken ${p3Rows.reduce((n, r) => n + r.questionsSpoken, 0)}`,
  "",
  "Run D — VAD (ElevenLabs vad_score, max within the clip +0.6 s) per short utterance and playback gain:",
  ...p3Rows.flatMap((r) => r.vadByGain.map((v) => `  gain ${v.gain.toFixed(2)} "${v.text}" max VAD ${v.maxVad.toFixed(3)}${v.maxVad < 0.4 ? "  ← below the gate's 0.4 threshold: invisible to the gate" : ""}`)),
  "",
  "Additional gate data from the P4 runs:",
  ...rows.filter((r) => !isP3(r)).map((r) => `  session ${r.sessionId}: authorized ${r.questionsAuthorized}, spoken ${r.questionsSpoken}, interruptions ${r.interruptions}, talk-over ${r.talkOver.length}, lost ${r.lostAuthorizations.length}, refused ${r.refusedAuthorizations.join(",") || "none"}, first audio ${fmt(stat(r.firstAudio))}`),
  "",
  "Server-side authorize timings (request → gate.authorized row timestamp → nonce issued; from the nonce's expiresAt − 4 s TTL):",
  ...rows.flatMap((r) =>
    r.serverAuthorizeTimings.filter((t) => t.rtt > 500).map((t) => `  session ${r.sessionId.slice(0, 8)}: request→row ${t.requestToRow} ms, row→issue ${t.rowToIssue} ms, total RTT ${t.rtt} ms`),
  ),
];
writeFileSync(join(EVIDENCE_DIR, "SUMMARY.json"), `${JSON.stringify({ label: SYNTHETIC_LABEL, runs: rows }, null, 2)}\n`);
writeFileSync(join(EVIDENCE_DIR, "SUMMARY.txt"), `${lines.join("\n")}\n`);
console.info(lines.join("\n"));
