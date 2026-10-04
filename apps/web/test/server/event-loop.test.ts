/**
 * Bug #6 (docs/evidence/live/bugs/BUGS.txt): the server's event loop stalled for seconds while it ran
 * Z3, question generation (EIG) and Work Map builds on the thread that also serves the gate and the
 * custom LLM. This drives the heavy flow through the real composition root (`createRuntime`: the Z3 and
 * engine worker threads) and the real handlers — expert sessions with decisions, authorisations, custom-LLM
 * turns and answers, debriefs with confirmations and witness reruns, Work Maps and exports, the
 * two-experts disagreement search and the tutor's practice cases — and bounds how long the event loop
 * was ever blocked meanwhile (`monitorEventLoopDelay`). Every handler module is loaded before measuring.
 */
import { PERMIT_ALL, harnessSessionRequest } from "../support/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRgba } from "@vashistha/perception";
import { encodePng } from "@vashistha/perception/png";
import { caseDeskDeps } from "../../lib/server/casedesk/deps";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handleCreateSession } from "../../lib/server/casedesk/sessions";
import { handleChatCompletion } from "../../lib/server/custom-llm";
import { handleExport, handleExpertAction, handleGenerateTeachBack, handleGetDebrief, handleGetWorkMap, handleRebuildWitnesses } from "../../lib/server/debrief/handlers";
import { debriefDeps } from "../../lib/server/debrief/runtime-deps";
import { handleSearchDisagreements } from "../../lib/server/disagreements/handlers";
import { disagreementDeps } from "../../lib/server/disagreements/runtime-deps";
import { interviewDeps } from "../../lib/server/interview/deps";
import { handleGateAuthorize, handlePostUtterance, handleQuestionQueue } from "../../lib/server/interview/handlers";
import { interviewIdle } from "../../lib/server/interview/orchestrator";
import { perceptionDeps } from "../../lib/server/perception/deps";
import { handlePostFrame } from "../../lib/server/perception/frames";
import { createRuntime } from "../../lib/server/runtime-init";
import type { Runtime } from "../../lib/server/runtime";
import { tutorDeps } from "../../lib/server/tutor/deps";
import { handlePractice, handleTutorState } from "../../lib/server/tutor/handlers";

/** POST /api/sessions as the account the pre-accounts body names (see support/accounts.ts). */
function createSessionAs(raw: unknown): Promise<Response> {
  const { actor, body } = harnessSessionRequest(raw);
  return handleCreateSession(post("/api/sessions", body), caseDeskDeps(), actor, PERMIT_ALL);
}

/** The bound on any single block of the request event loop under the heavy flow (CI hardware; locally it stays far below). */
const MAX_BLOCK_MS = 100;
/** `monitorEventLoopDelay` sampling interval; the histogram records whole intervals, so it is subtracted. */
const RESOLUTION_MS = 10;
/** Expert sessions in the flow: Asha's rulebook grows over them (as one expert's did in production), Priya's gives the disagreement search a pair. */
const SESSIONS = 6;
const SECRET = "event-loop-test-secret-0123456789abcdef";
const DECISIONS: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "approve", "NS-2026-0103": "enhancedReview" };
const EXPERTS = [
  { name: "Asha Rao", language: "en" },
  { name: "Priya Sharma", language: "en" },
] as const;

const url = (path: string) => `http://localhost${path}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/**
 * Settles a handler's response, then yields to the event loop: requests reach a server as separate I/O
 * events, so one handler's continuation never runs straight into the next request's (which would
 * measure the test's own request chain, not any handler).
 */
async function ok<T>(response: Promise<Response>): Promise<T> {
  const r = await response;
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as T;
  await new Promise((resolve) => setImmediate(resolve));
  return body;
}

/** A small schematic case page, encoded once before measuring (the browser uploads frames like it). */
function framePng(): Blob {
  const image = createRgba(320, 180);
  for (let i = 0; i < image.data.length; i += 4) image.data.set([(i >> 6) & 255, 220, 230, 255], i);
  return new Blob([new Uint8Array(encodePng(image))], { type: "image/png" });
}

let dataDir: string;
let runtime: Runtime;
let close: () => void;
let png: Blob;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vashistha-event-loop-"));
  ({ runtime, close } = createRuntime({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:3000", DATA_DIR: dataDir, CUSTOM_LLM_SECRET: SECRET }));
  png = framePng();
  // Z3 initialised in its worker before measuring (as the server warms it at boot).
  expect(await runtime.checks.z3()).toMatchObject({ ok: true });
}, 60_000);

afterAll(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function uploadFrame(sessionId: string, frameSeq: number): Promise<void> {
  const form = new FormData();
  const metadata = { frameSeq, captureTime: Date.now(), privacyEpoch: 0, changeScore: 24, redactedRegions: 0, source: { width: 320, height: 180 }, bbox: null, crop: null };
  form.set("metadata", JSON.stringify(metadata));
  form.set("frame", png, "frame.png");
  const r = await handlePostFrame(new Request(url(`/api/sessions/${sessionId}/frames`), { method: "POST", body: form }), sessionId, perceptionDeps());
  if (r.status !== 202) throw new Error(`frame upload: HTTP ${r.status}: ${await r.text()}`);
}

type Queue = { queue: { id: string }[]; contextVersion: number };
type Debrief = {
  proposals: { candidateId: string; decisionFamily: string; action: string; text: string }[];
  witnesses: unknown[];
  rules: { rule: { id: string } }[];
};

/** An expert session: three decisions, each followed by an authorised question, its custom-LLM turn and the expert's answer. */
async function expertSession(index: number): Promise<{ sessionId: string; asked: number }> {
  const { sessionId } = await ok<{ sessionId: string }>(
    createSessionAs({ mode: "expert", caseSet: "training", expert: EXPERTS[index % 3 === 2 ? 1 : 0] }),
  );
  let frameSeq = 0;
  let asked = 0;
  for (const [caseId, action] of Object.entries(DECISIONS)) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(handlePostEvents(post(`/api/sessions/${sessionId}/events`, { events: [event] }), sessionId, caseDeskDeps()));
    await uploadFrame(sessionId, frameSeq);
    const check = await ok<{ checkId: string; result: { decision: string } }>(
      handleInterlockCheck(post("/api/interlock/check", { sessionId, caseId, edits: {}, proposedAction: action }), caseDeskDeps()),
    );
    const override = check.result.decision === "allow" ? {} : { override: { kind: "acknowledged", note: "Reviewed the sign-off requirement." } };
    await ok(handleCommitDecision(post(`/api/sessions/${sessionId}/decisions`, { caseId, edits: {}, action, checkId: check.checkId, ...override }), sessionId, caseDeskDeps()));
    await interviewIdle(runtime.interview, sessionId);
    const { queue, contextVersion } = await ok<Queue>(handleQuestionQueue(sessionId, interviewDeps()));
    const top = queue[0];
    if (top === undefined) continue;
    const now = Date.now();
    const authorize = post(`/api/sessions/${sessionId}/gate/authorize`, { questionId: top.id, contextVersion, becameValidAt: now - 5, decidedAt: now, conditions: { silence: true } });
    const { controlMessage } = await ok<{ controlMessage: string }>(handleGateAuthorize(authorize, sessionId, interviewDeps()));
    const turn = post(
      "/api/llm/chat/completions",
      { model: "vashistha-interviewer-v1", stream: true, messages: [{ role: "user", content: controlMessage }], elevenlabs_extra_body: { sessionId } },
      { authorization: `Bearer ${SECRET}` },
    );
    const spoken = await handleChatCompletion(turn, { secret: SECRET, authorizations: runtime.authorizations, ledger: runtime.ledger, now: Date.now, log: console }, performance.now());
    await spoken.text();
    await new Promise((resolve) => setImmediate(resolve));
    const answer = { conversationId: `conv-${sessionId}`, text: "Because the owner is not verified, it goes to enhanced review.", t0Ms: frameSeq * 10_000, t1Ms: frameSeq * 10_000 + 4_000, questionId: top.id, privacyEpoch: 0 };
    await ok(handlePostUtterance(post(`/api/sessions/${sessionId}/utterances`, answer), sessionId, interviewDeps()));
    asked += 1;
  }
  return { sessionId, asked };
}

/**
 * The debrief of a session: solver witnesses, two confirmations (one corrected to a threshold, which gives
 * the tutor boundary cases), a rerun, a teach-back, the Work Map and both exports.
 */
async function debrief(sessionId: string, index: number): Promise<number> {
  const state = await ok<Debrief>(handleGetDebrief(sessionId, debriefDeps()));
  let latest = state;
  for (const p of state.proposals.slice(0, 2)) {
    const confirm = { action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote: `Yes: ${p.text}, ${p.action}.` };
    latest = (await ok<{ state: Debrief }>(handleExpertAction(post(`/api/sessions/${sessionId}/debrief`, confirm), sessionId, debriefDeps()))).state;
  }
  const rule = latest.rules.at(-1)?.rule;
  if (rule !== undefined) {
    const revise = { action: "revise_rule", ruleId: rule.id, predicate: { ">": [{ var: "uboOwnershipPct" }, 25 + index] }, quote: "Only when the owner holds more than a quarter." };
    await ok(handleExpertAction(post(`/api/sessions/${sessionId}/debrief`, revise), sessionId, debriefDeps()));
  }
  const rebuilt = await ok<Debrief>(handleRebuildWitnesses(sessionId, debriefDeps()));
  await ok(handleGenerateTeachBack(sessionId, debriefDeps()));
  await ok(handleGetWorkMap(sessionId, debriefDeps()));
  for (const format of ["json", "procedure"]) {
    const r = await handleExport(new Request(url(`/api/sessions/${sessionId}/workmap/export?format=${format}`)), sessionId, debriefDeps());
    if (!r.ok) throw new Error(`export ${format}: HTTP ${r.status}`);
    await r.text();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return rebuilt.witnesses.length;
}

describe("request event loop under the heavy flow", () => {
  it(`is never blocked for ${MAX_BLOCK_MS} ms or more`, { timeout: 180_000 }, async () => {
    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    let asked = 0;
    let witnesses = 0;
    for (let i = 0; i < SESSIONS; i++) {
      const session = await expertSession(i);
      asked += session.asked;
      witnesses += await debrief(session.sessionId, i);
    }
    const found = await ok<{ written: string[] }>(
      handleSearchDisagreements(post("/api/disagreements", { experts: ["asha-rao", "priya-sharma"], decisionFamily: "reviewOutcome" }), disagreementDeps()),
    );
    const { sessionId: novice } = await ok<{ sessionId: string }>(createSessionAs({ mode: "novice", caseSet: "heldout" }));
    await ok(handleTutorState(novice, tutorDeps()));
    const practice = await ok<{ cases: unknown[] }>(handlePractice(novice, tutorDeps()));
    histogram.disable();

    // The flow did the heavy work: questions generated and asked, witnesses and practice cases found by Z3.
    expect(asked).toBeGreaterThanOrEqual(6);
    expect(witnesses).toBeGreaterThan(0);
    expect(found.written).toBeDefined();
    expect(practice.cases.length).toBeGreaterThan(0);

    const maxBlockMs = histogram.max / 1e6 - RESOLUTION_MS;
    const p99Ms = histogram.percentile(99) / 1e6 - RESOLUTION_MS;
    console.info(`event-loop delay over the heavy flow: p99 ${p99Ms.toFixed(1)} ms, max ${maxBlockMs.toFixed(1)} ms (${histogram.count} samples)`);
    expect(maxBlockMs).toBeLessThan(MAX_BLOCK_MS);
  });
});
