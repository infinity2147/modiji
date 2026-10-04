/**
 * Session lifecycle (replay security): a session id is a write capability and a published replay exposes
 * it, so a session can be archived — `POST /api/sessions/:id/archive`, operator bearer only. Afterwards
 * EVERY write route refuses with 409 `session_archived` and writes nothing, every read keeps working,
 * and rules confirmed in the session stay in the rulebook. Runs the real runtime (createRuntime) and
 * the real handlers; a route inventory keeps the table complete as routes are added.
 */
import { PERMIT_ALL, harnessSessionRequest } from "../support/accounts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRgba } from "@vashistha/perception";
import { encodePng } from "@vashistha/perception/png";
import { ArchiveSessionResponseSchema, CreateSessionResponseSchema } from "../../lib/contracts/casedesk";
import { handleArchiveSession } from "../../lib/server/casedesk/archive";
import { caseDeskDeps } from "../../lib/server/casedesk/deps";
import { handleCommitDecision, handleInterlockCheck } from "../../lib/server/casedesk/interlock";
import { handlePostEvents } from "../../lib/server/casedesk/events";
import { handleLedgerPage } from "../../lib/server/casedesk/ledger-page";
import { handleCreateSession, handleListCases } from "../../lib/server/casedesk/sessions";
import {
  handleConversation,
  handleExpertAction,
  handleExport,
  handleGenerateTeachBack,
  handleGetDebrief,
  handleGetRulebook,
  handleGetWorkMap,
  handleLineage,
  handleRebuildWitnesses,
} from "../../lib/server/debrief/handlers";
import { debriefDeps } from "../../lib/server/debrief/runtime-deps";
import {
  handleEngineState,
  handleGateAuthorize,
  handleOffRecord,
  handlePostAgentUtterance,
  handlePostUtterance,
  handleQuestionQueue,
} from "../../lib/server/interview/handlers";
import { interviewDeps } from "../../lib/server/interview/deps";
import { perceptionDeps } from "../../lib/server/perception/deps";
import { handlePostFrame, handleVisionState } from "../../lib/server/perception/frames";
import { getRuntime } from "../../lib/server/runtime";
import { createRuntime } from "../../lib/server/runtime-init";
import { handleConceptAction, handleGetConcepts } from "../../lib/server/schema/handlers";
import { schemaDeps } from "../../lib/server/schema/runtime-deps";
import { tutorDeps } from "../../lib/server/tutor/deps";
import { handleIntent, handleJudgeCase, handlePractice, handlePrediction, handleTutorState } from "../../lib/server/tutor/handlers";

/** POST /api/sessions as the account the pre-accounts body names (see support/accounts.ts). */
function createSessionAs(raw: unknown): Promise<Response> {
  const { actor, body } = harnessSessionRequest(raw);
  return handleCreateSession(post("/api/sessions", body), caseDeskDeps(), actor, PERMIT_ALL);
}

const SECRET = "archive-test-secret-0123456789-abcdef";
const BASE = "http://localhost:3000";
const API = join(import.meta.dirname, "../../app/api");
const STOP_QUOTE = "Never approve a new customer from a high-risk country at desk level.";

const post = (path: string, body?: unknown, headers: Record<string, string> = {}): Request =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const get = (path: string): Request => new Request(`${BASE}${path}`);

async function body(response: Response | Promise<Response>): Promise<{ status: number; json: unknown }> {
  const r = await response;
  const text = await r.text();
  return { status: r.status, json: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function ok(response: Response | Promise<Response>): Promise<unknown> {
  const r = await body(response);
  expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
  return r.json;
}

function frameRequest(sessionId: string, frameSeq: number): Request {
  const image = createRgba(64, 36);
  image.data.fill(200);
  const form = new FormData();
  const metadata = { frameSeq, captureTime: Date.now(), privacyEpoch: 0, changeScore: 24, redactedRegions: 0, source: { width: 64, height: 36 }, bbox: null, crop: null };
  form.set("metadata", JSON.stringify(metadata));
  form.set("frame", new Blob([new Uint8Array(encodePng(image))], { type: "image/png" }), "frame.png");
  return new Request(`${BASE}/api/sessions/${sessionId}/frames`, { method: "POST", body: form });
}

const JUDGE_CASE = {
  entityType: "company",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "high",
  uboOwnershipPct: 40,
  uboVerified: false,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 10_000,
};

const openCase = (caseId: string, frameSeq: number) => ({ id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false });

let dataDir: string;
let close: () => void;
let expert: string;
let novice: string;
let frameEntry: string;

/** Every write route of a session, with a well-formed request: each must answer 409 session_archived. Keyed by route path under app/api. */
const WRITES: Record<string, (sessionId: string) => Promise<Response>> = {
  "sessions/[sessionId]/events": (id) => handlePostEvents(post(`/api/sessions/${id}/events`, { events: [openCase("NS-2026-0101", 99)] }), id, caseDeskDeps()),
  "sessions/[sessionId]/frames": (id) => handlePostFrame(frameRequest(id, 99), id, perceptionDeps()),
  "sessions/[sessionId]/decisions": (id) =>
    handleCommitDecision(post(`/api/sessions/${id}/decisions`, { caseId: "NS-2026-0101", edits: {}, action: "approve", checkId: randomUUID() }), id, caseDeskDeps()),
  "interlock/check": (id) => handleInterlockCheck(post("/api/interlock/check", { sessionId: id, caseId: "NS-2026-0101", edits: {}, proposedAction: "approve" }), caseDeskDeps()),
  "sessions/[sessionId]/utterances": (id) =>
    handlePostUtterance(post(`/api/sessions/${id}/utterances`, { conversationId: "conv_1", text: "We always ask for documents.", t0Ms: 0, t1Ms: 900, privacyEpoch: 0 }), id, interviewDeps()),
  "sessions/[sessionId]/agent-utterances": (id) => handlePostAgentUtterance(post(`/api/sessions/${id}/agent-utterances`, { conversationId: "conv_1", text: "Why?" }), id, interviewDeps()),
  "sessions/[sessionId]/gate/authorize": (id) =>
    handleGateAuthorize(post(`/api/sessions/${id}/gate/authorize`, { questionId: "q_1", contextVersion: 0, becameValidAt: 1, decidedAt: 2, conditions: {} }), id, interviewDeps()),
  "sessions/[sessionId]/off-record": (id) => handleOffRecord(post(`/api/sessions/${id}/off-record`, { offRecord: true }), id, interviewDeps()),
  "sessions/[sessionId]/debrief/conversation": (id) =>
    handleConversation(post(`/api/sessions/${id}/debrief/conversation`, { type: "reply", text: "Never approve a sanctions hit." }), id, { debrief: debriefDeps(), schema: schemaDeps() }),
  "sessions/[sessionId]/debrief": (id) =>
    handleExpertAction(post(`/api/sessions/${id}/debrief`, { action: "confirm_teachback", teachBackId: randomUUID(), quote: "Yes, that's right." }), id, debriefDeps()),
  "sessions/[sessionId]/teachback": (id) => handleGenerateTeachBack(id, debriefDeps()),
  "sessions/[sessionId]/witnesses": (id) => handleRebuildWitnesses(id, debriefDeps()),
  "sessions/[sessionId]/concepts": (id) =>
    handleConceptAction(post(`/api/sessions/${id}/concepts`, { action: "dismiss", name: "registryExtractAge", reason: "not_a_concept", statement: { text: "Not a thing we use." } }), id, schemaDeps()),
  "sessions/[sessionId]/tutor/intent": (id) => handleIntent(post(`/api/sessions/${id}/tutor/intent`, { caseId: "NS-2026-0201", proposedAction: "approve", edits: {} }), id, tutorDeps()),
  "sessions/[sessionId]/tutor/prediction": (id) => handlePrediction(post(`/api/sessions/${id}/tutor/prediction`, { caseId: "NS-2026-0201", predicted: "approve", edits: {} }), id, tutorDeps()),
  "sessions/[sessionId]/tutor/practice": (id) => handlePractice(id, tutorDeps()),
  "sessions/[sessionId]/tutor/cases": (id) => handleJudgeCase(post(`/api/sessions/${id}/tutor/cases`, { features: JUDGE_CASE }), id, tutorDeps()),
};

/** Write routes that are not one session's: covered elsewhere (two-experts.test.ts for /api/disagreements*), or not session writes. */
const NOT_SESSION_WRITES = new Set([
  "sessions", // creates a new session
  "sessions/[sessionId]/archive", // the lifecycle call itself
  "disagreements",
  "disagreements/answer",
  "llm/chat/completions", // speaks only an authorization issued by gate/authorize (refused when archived; archiving revokes outstanding ones)
  "preflight/authorize",
  "replays/[bundleId]/import",
  "replays/[bundleId]/import/[...path]",
  // Accounts (no CaseDesk session): sign-up, sign-in, sign-out, and the admin's account actions.
  "auth/signup",
  "auth/login",
  "auth/logout",
  "admin/users/[userId]",
]);

/** Novice-session writes (the tutor teaches novices; an expert session answers 409 not_novice first). */
const NOVICE_ROUTES = new Set(["sessions/[sessionId]/tutor/intent", "sessions/[sessionId]/tutor/prediction", "sessions/[sessionId]/tutor/practice", "sessions/[sessionId]/tutor/cases"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? routeFiles(join(dir, d.name)) : d.name === "route.ts" ? [join(dir, d.name)] : []));
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "vashistha-archive-"));
  ({ close } = createRuntime({ NODE_ENV: "test", PUBLIC_BASE_URL: BASE, DATA_DIR: dataDir, CUSTOM_LLM_SECRET: SECRET }));
  const created = CreateSessionResponseSchema.parse(await ok(createSessionAs({ mode: "expert", caseSet: "training", expert: { name: "Asha Rao" } })));
  expert = created.sessionId;
  const decisions: [string, string][] = [
    ["NS-2026-0101", "requestDocuments"],
    ["NS-2026-0102", "approve"],
    ["NS-2026-0103", "enhancedReview"],
  ];
  for (const [i, [caseId, action]] of decisions.entries()) {
    await ok(handlePostEvents(post(`/api/sessions/${expert}/events`, { events: [openCase(caseId, i + 1)] }), expert, caseDeskDeps()));
    frameEntry = ((await ok(handlePostFrame(frameRequest(expert, i + 1), expert, perceptionDeps()))) as { ledgerId: string }).ledgerId;
    const { checkId } = (await ok(handleInterlockCheck(post("/api/interlock/check", { sessionId: expert, caseId, edits: {}, proposedAction: action }), caseDeskDeps()))) as { checkId: string };
    await ok(handleCommitDecision(post(`/api/sessions/${expert}/decisions`, { caseId, edits: {}, action, checkId }), expert, caseDeskDeps()));
  }
  await ok(
    handleExpertAction(
      post(`/api/sessions/${expert}/debrief`, {
        action: "confirm_stop_rule",
        decisionFamily: "reviewOutcome",
        when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }, { feature: "customerStatus", op: "==", value: "new" }] },
        effect: { type: "forbid", action: "approve" },
        momentEntryId: frameEntry,
        quote: STOP_QUOTE,
      }),
      expert,
      debriefDeps(),
    ),
  );
  novice = CreateSessionResponseSchema.parse(await ok(createSessionAs({ mode: "novice", caseSet: "heldout" }))).sessionId;
  await ok(handlePostEvents(post(`/api/sessions/${novice}/events`, { events: [openCase("NS-2026-0201", 1)] }), novice, caseDeskDeps()));
});

afterAll(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

const archive = (sessionId: string, headers: Record<string, string>, data: unknown = { by: "replay_export" }) =>
  body(
    handleArchiveSession(post(`/api/sessions/${sessionId}/archive`, data, headers), sessionId, {
      ledger: getRuntime().ledger,
      store: getRuntime().casedesk,
      authorizations: getRuntime().authorizations,
      secret: SECRET,
      now: Date.now,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
  );

describe("archiving a session", () => {
  it("is operator only (bearer), appends one session.archived entry, and refuses a second archive", async () => {
    expect((await archive(expert, {})).status).toBe(401);
    expect((await archive(expert, { authorization: "Bearer not-the-secret-not-the-secret-0000" })).status).toBe(401);
    expect(getRuntime().ledger.getSession(expert)?.archived).toBe(false);

    const contextBefore = getRuntime().authorizations.getContextVersion(expert);
    const archived = ArchiveSessionResponseSchema.parse((await archive(expert, { authorization: `Bearer ${SECRET}` })).json);
    expect(archived).toMatchObject({ sessionId: expert, archived: true });
    expect(getRuntime().ledger.get(archived.entryId)).toMatchObject({ kind: "session.archived", source: "engine", payload: { by: "replay_export" } });
    // Outstanding authorizations are revoked with the context version.
    expect(getRuntime().authorizations.getContextVersion(expert)).toBe(contextBefore + 1);

    const again = await archive(expert, { authorization: `Bearer ${SECRET}` }, {});
    expect(again).toMatchObject({ status: 409, json: { error: "session_archived" } });
    expect(ArchiveSessionResponseSchema.parse((await archive(novice, { authorization: `Bearer ${SECRET}` }, { note: "replay published" })).json).sessionId).toBe(novice);
  });

  it("every write route of an archived session answers 409 session_archived and writes nothing", async () => {
    const ledger = getRuntime().ledger;
    for (const [route, write] of Object.entries(WRITES)) {
      const sessionId = NOVICE_ROUTES.has(route) ? novice : expert;
      const before = ledger.list(sessionId).length;
      const r = await body(write(sessionId));
      expect({ route, status: r.status, json: r.json }).toMatchObject({ route, status: 409, json: { error: "session_archived" } });
      expect(ledger.list(sessionId), route).toHaveLength(before);
    }
  });

  it("the table covers every write route under app/api", () => {
    const writes = routeFiles(API)
      .filter((file) => /export (async )?function (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(file, "utf8")))
      .map((file) => relative(API, file).replace(/\/route\.ts$/, ""));
    expect(writes.length).toBeGreaterThan(Object.keys(WRITES).length);
    for (const route of writes) expect(route in WRITES || NOT_SESSION_WRITES.has(route), `${route}: add it to WRITES (or NOT_SESSION_WRITES)`).toBe(true);
  });

  it("every read keeps working, and the session's confirmed rules stay in the rulebook", async () => {
    const reads: [string, Promise<Response>][] = [
      ["ledger", handleLedgerPage(get(`/api/sessions/${expert}/ledger`), expert, caseDeskDeps())],
      ["cases", handleListCases(get(`/api/cases?set=training&session=${expert}`), caseDeskDeps())],
      ["questions", handleQuestionQueue(expert, interviewDeps())],
      ["engine", handleEngineState(expert, interviewDeps())],
      ["frames", handleVisionState(expert, perceptionDeps())],
      ["concepts", handleGetConcepts(expert, schemaDeps())],
      ["debrief", handleGetDebrief(expert, debriefDeps())],
      ["workmap", handleGetWorkMap(expert, debriefDeps())],
      ["workmap/export", handleExport(get(`/api/sessions/${expert}/workmap/export?format=procedure`), expert, debriefDeps())],
      ["lineage", handleLineage(get(`/api/sessions/${expert}/lineage?entryId=${frameEntry}`), expert, debriefDeps())],
      ["tutor", handleTutorState(novice, tutorDeps())],
    ];
    const lengths = [expert, novice].map((id) => getRuntime().ledger.list(id).length);
    for (const [name, read] of reads) expect({ name, status: (await read).status }).toEqual({ name, status: 200 });
    // Reading wrote nothing (the Work Map of an archived session is served without its workmap.generated entry).
    expect([expert, novice].map((id) => getRuntime().ledger.list(id).length)).toEqual(lengths);

    const book = (await ok(handleGetRulebook({ rulebook: getRuntime().rulebookState, log: console }))) as { rules: { evidence: { exactQuote?: string }[] }[] };
    expect(book.rules.some((r) => r.evidence.some((e) => e.exactQuote === STOP_QUOTE))).toBe(true);
  });
});
