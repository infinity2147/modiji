/** Shared setup for the debrief tests: a seeded expert session on an in-memory ledger, the real solver and rulebook store, fake Opus behind the real `createClaude`. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { ConfirmedRuleSchema, engineConfig, legacyExpertId, RuleConfirmedPayloadSchema, type ConfirmedRule, type LedgerEntry } from "@vashistha/core";
import { CLAUDE_MODELS, createClaude, createLedger, openDatabase, type ClaudeClient, type Ledger, type OpenedDatabase } from "@vashistha/core/server";
import { kycCases } from "@vashistha/core/domains/kyc";
import { ORACLE_MARKER } from "@vashistha/core/domains/kyc/oracle";
import { compileProcedure, exportWorkMapJson } from "@vashistha/mcp-guardrails";
import { DebriefStateSchema, ExpertActionResponseSchema, type DebriefState } from "../../lib/contracts/debrief";
import { createAuthorizationStore } from "../../lib/server/authorizations";
import { createCaseDeskStore } from "../../lib/server/casedesk/session";
import { createDebriefStore, type DebriefDeps } from "../../lib/server/debrief/deps";
import { handleExpertAction, handleGetDebrief, handleRebuildWitnesses } from "../../lib/server/debrief/handlers";
import { createLedgerRulebook } from "../../lib/server/debrief/rulebook-store";
import { createWitnessSolver } from "../../lib/server/debrief/solver";
import { TEACHBACK_SYSTEM } from "../../lib/server/debrief/teachback";
import { WORKMAP_PROSE_SYSTEM } from "../../lib/server/debrief/workmap";
import { createInterviewStore } from "../../lib/server/interview/engine-state";
import { jsonRequest } from "./casedesk-harness";

export const T0 = 1_760_000_000_000;
export const OPUS_TEACHBACK =
  "I learned that when the largest owner holds more than 25% and their identity is not verified, you request documents, and that a politically exposed person is never approved. Did I get that right?";

type CreateParams = Parameters<ClaudeClient["messages"]["create"]>[0];
type Message = Awaited<ReturnType<ClaudeClient["messages"]["create"]>>;

export function message(text: string): Message {
  return {
    id: "msg_fake",
    container: null,
    content: [{ type: "text", text, citations: null }],
    diagnostics: null,
    model: CLAUDE_MODELS.prose,
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: null,
      input_tokens: 400,
      output_tokens: 60,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  };
}

function promptText(params: CreateParams): { system: string; user: string } {
  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("");
  const user = params.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""))).join("\n");
  return { system, user };
}

/** Fake Opus: teach-back prose, and Work Map titles for exactly the step ids it is given. */
function fakeOpus(calls: { system: string; user: string; model: string }[]): ClaudeClient {
  return {
    messages: {
      create: async (params) => {
        const { system, user } = promptText(params);
        calls.push({ system, user, model: params.model });
        if (system === TEACHBACK_SYSTEM) return message(OPUS_TEACHBACK);
        if (system === WORKMAP_PROSE_SYSTEM) {
          const ids = [...user.matchAll(/<step id="([^"]+)">/g)].map((m) => m[1] ?? "");
          return message(JSON.stringify({ titles: ids.map((stepId, i) => ({ stepId, title: `Review ${i + 1}` })), summary: "Three onboarding reviews and the rules behind them." }));
        }
        throw new Error("unexpected prompt");
      },
    },
  };
}

export type Reply = { status: number; body: unknown };
export async function reply(r: Response): Promise<Reply> {
  const text = await r.text();
  return { status: r.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

/** Fixture rules: a numeric decision rule (owner share over 25% unverified → request documents) and a guardrail (never approve a PEP). */
function fixtureRule(id: string, input: { predicate: unknown; effect: unknown; kind: ConfirmedRule["kind"]; utteranceId: string; quote: string; moment: string; expertId: string }): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id,
    decisionFamily: "reviewOutcome",
    kind: input.kind,
    predicate: input.predicate,
    effect: input.effect,
    priority: input.kind === "guardrail" ? 40 : 10,
    overrides: [],
    evidence: [
      { kind: "expert_quote", utteranceId: input.utteranceId, exactQuote: input.quote, t0Ms: 1_000, t1Ms: 4_000, frameIds: [input.moment], eventIds: [], relation: "supports", provenance: "human_voice" },
    ],
    confirmedBy: [{ expertId: input.expertId, at: T0, method: "explicit_statement", ledgerEntryId: input.utteranceId }],
    revision: 1,
    schemaVersion: 1,
    expertId: input.expertId,
  });
}

export const PEP_QUOTE = "Never approve a politically exposed person on the first pass.";
export const DOCS_QUOTE = "If the main owner holds more than a quarter and we can't verify them, we ask for documents.";

export type World = { opened: OpenedDatabase; ledger: Ledger; deps: DebriefDeps; sessionId: string; calls: { system: string; user: string; model: string }[]; dataDir: string };

/** `screenFrames: false` seeds a DOM-only session: the expert never shared their screen. */
export function seed(ledger: Ledger, { screenFrames = true }: { screenFrames?: boolean } = {}): string {
  const session = ledger.createSession();
  const at = (kind: string, source: LedgerEntry["source"], payload: unknown, parentIds: string[] = []): LedgerEntry =>
    ledger.append({ sessionId: session.id, source, kind, occurredAt: T0, traceId: "seed", parentIds, schemaVersion: 1, privacyEpoch: 0, payload });
  const started = at("session.started", "engine", { mode: "expert", caseSet: "training", domainId: "kycNorthstar", schemaVersion: 1 });
  const decide: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "approve", "NS-2026-0103": "enhancedReview" };
  let frameSeq = 0;
  const moments: string[] = [];
  for (const c of kycCases("training")) {
    const action = decide[c.id] ?? "approve";
    frameSeq += 1;
    const opened = at("screen.event", "dom", { id: `ev-${c.id}`, frameSeq, captureTime: T0, sessionEpoch: 0, kind: "open_case", caseId: c.id, confidence: 1, source: "dom", critical: false });
    // What perception uploads while the expert shares their screen: the redacted frame of the case.
    const frame = !screenFrames
      ? undefined
      : at("frame.received", "client", {
          frameId: `frame-${c.id}`,
          frameSeq,
          captureTime: T0,
          width: 1568,
          height: 882,
          mediaPath: `frames/${session.id}/frame-${c.id}.png`,
          redactedRegions: 0,
          changeScore: 12,
        });
    moments.push((frame ?? opened).id);
    const result = { decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] };
    const check = at("interlock.check", "engine", { caseId: c.id, action, edits: {}, result }, [started.id]);
    at("case.decision", "dom", { caseId: c.id, action, edits: {}, result }, [check.id]);
  }
  const utter = (text: string): LedgerEntry => at("utterance.transcript", "voice", { conversationId: "conv-1", text, t0Ms: 1_000, t1Ms: 4_000, frameIds: [] });
  const docs = utter(DOCS_QUOTE);
  const pep = utter(PEP_QUOTE);
  // The session's own expert (no name at start: `expert-<sessionId>`), so the debrief reads these rules as theirs.
  const expertId = legacyExpertId(session.id);
  const rules = [
    fixtureRule("rule-docs", { predicate: { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] }, effect: { type: "recommend", action: "requestDocuments" }, kind: "decision", utteranceId: docs.id, quote: DOCS_QUOTE, moment: moments[0] ?? "", expertId }),
    fixtureRule("rule-pep", { predicate: { "==": [{ var: "pep" }, true] }, effect: { type: "forbid", action: "approve" }, kind: "guardrail", utteranceId: pep.id, quote: PEP_QUOTE, moment: moments[2] ?? "", expertId }),
  ];
  for (const [i, rule] of rules.entries()) at("rule.confirmed", "engine", RuleConfirmedPayloadSchema.parse({ rule }), [[docs.id, pep.id][i] ?? ""]);
  return session.id;
}

export async function world(options: { screenFrames?: boolean } = {}): Promise<World> {
  const opened = openDatabase({ memory: true });
  const ledger = createLedger(opened.db, { now: () => T0 });
  const sessionId = seed(ledger, options);
  const calls: World["calls"] = [];
  const dataDir = await mkdtemp(join(tmpdir(), "debrief-"));
  const deps: DebriefDeps = {
    ledger,
    casedesk: createCaseDeskStore(),
    interview: createInterviewStore(),
    engineConfig: engineConfig(),
    authorizations: createAuthorizationStore(),
    rulebook: createLedgerRulebook(opened.sqlite),
    solver: createWitnessSolver(),
    claude: createClaude({ client: fakeOpus(calls), forbiddenMarkers: [ORACLE_MARKER] }),
    models: { prose: CLAUDE_MODELS.prose },
    exports: { workMapJson: exportWorkMapJson, procedure: compileProcedure },
    store: createDebriefStore(),
    dataDir,
    mcpBearerRequired: false,
    now: () => T0,
    log: { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a) },
  };
  return { opened, ledger, deps, sessionId, calls, dataDir };
}

export const path = (sessionId: string, tail: string): string => `/api/sessions/${sessionId}/${tail}`;

export async function getState(w: World): Promise<DebriefState> {
  const r = await reply(await handleGetDebrief(w.sessionId, w.deps));
  expect(r.status).toBe(200);
  return DebriefStateSchema.parse(r.body);
}

export async function act(w: World, body: unknown): Promise<DebriefState> {
  const r = await reply(await handleExpertAction(jsonRequest(path(w.sessionId, "debrief"), body), w.sessionId, w.deps));
  if (r.status !== 200) throw new Error(`action failed: ${r.status} ${JSON.stringify(r.body)}`);
  return ExpertActionResponseSchema.parse(r.body).state;
}

export async function rebuild(w: World): Promise<DebriefState> {
  const r = await reply(await handleRebuildWitnesses(w.sessionId, w.deps));
  expect(r.status).toBe(200);
  return DebriefStateSchema.parse(r.body);
}

export const openGaps = (s: DebriefState) => s.witnesses.filter((v) => v.current && v.witness.kind !== "boundary" && ["open", "queued", "asked"].includes(v.status));

