/**
 * Two experts on one in-memory ledger (plan §7.10): expert sessions started through the public
 * sessions API with a name (and language), redacted frames uploaded through the public frames API,
 * rules confirmed from the experts' own words, the real rulebook store, team rulebook and Z3 solver.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  PredicateSchema,
  RULE_PRIORITY_BY_KIND,
  RuleConfirmedPayloadSchema,
  engineConfig,
  promoteToConfirmedRule,
  type ConfirmedRule,
  type Predicate,
  type StatedRule,
} from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { AnswerDisagreementResponseSchema, DisagreementsStateSchema, SearchDisagreementsResponseSchema, type DisagreementsState } from "../../lib/contracts/disagreements";
import { createAuthorizationStore } from "../../lib/server/authorizations";
import { createDisagreementHolds, createExpertDirectory, createLedgerRulebook, teamRulebookView } from "../../lib/server/debrief/rulebook-store";
import type { DisagreementDeps } from "../../lib/server/disagreements/deps";
import { handleAnswerDisagreement, handleGetDisagreements, handleSearchDisagreements } from "../../lib/server/disagreements/handlers";
import { findDisagreements } from "@vashistha/solver";
import { createInterviewStore } from "../../lib/server/interview/engine-state";
import { T0, jsonRequest } from "./casedesk-harness";
import { createPerceptionHarness, metadata, png, type PerceptionHarness } from "./perception-harness";

export const ASHA = { name: "Asha Rao", id: "asha-rao" } as const;
export const PRIYA = { name: "Priya Sharma", id: "priya-sharma" } as const;
export const PAIR = [ASHA.id, PRIYA.id] as const;
export const FAMILY = "reviewOutcome";

export const HIGH: Predicate = PredicateSchema.parse({ "==": [{ var: "jurisdictionRisk" }, "high"] });
export const LONG_STANDING_HIGH: Predicate = PredicateSchema.parse({
  and: [{ "==": [{ var: "customerStatus" }, "existing"] }, { ">=": [{ var: "accountAgeMonths" }, 24] }, { "==": [{ var: "jurisdictionRisk" }, "high"] }],
});

export type ExpertsHarness = PerceptionHarness & {
  disagreements: DisagreementDeps;
  localized: { text: string; language: string }[];
  /** Starts an expert session through POST /api/sessions and uploads one redacted frame through the frames API. */
  expertSession: (expert: { name: string; language?: "en" | "hi" }) => Promise<{ sessionId: string; frameEntryId: string }>;
  /** The expert states a rule in their own words (voice utterance on screen); code promotes it as the interview does. */
  stateRule: (sessionId: string, expertId: string, input: { id: string; quote: string; rule: Omit<StatedRule, "exactQuote" | "t0Ms" | "t1Ms">; priority?: number; overrides?: string[] }) => ConfirmedRule;
  get: (query?: string) => Promise<{ status: number; state: DisagreementsState }>;
  getStatus: (query: string) => Promise<number>;
  search: () => Promise<{ status: number; body: unknown }>;
  answer: (expertId: string, witnessId: string, decision: string, quote: string) => Promise<{ status: number; body: unknown }>;
};

export function createExpertsHarness(): ExpertsHarness {
  const h = createPerceptionHarness({ unavailable: "no_api_key" });
  const localized: ExpertsHarness["localized"] = [];
  const log = { info: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a) };
  const all = createLedgerRulebook(h.opened.sqlite);
  const disagreements: DisagreementDeps = {
    ledger: h.ledger,
    casedesk: h.deps.store,
    interview: createInterviewStore(),
    engineConfig: engineConfig(),
    authorizations: createAuthorizationStore({ now: () => T0 }),
    rulebook: all,
    experts: createExpertDirectory(h.opened.sqlite),
    solver: findDisagreements,
    team: teamRulebookView(all, createDisagreementHolds(h.opened.sqlite)),
    // Records what would be translated; returns the English question (the LLM-off fallback).
    localize: async (question, language) => {
      localized.push({ text: question.text, language });
      return question;
    },
    store: { tail: Promise.resolve() },
    now: () => T0 + 1_000,
    log,
  };
  const reply = async (r: Response) => ({ status: r.status, body: (await r.json()) as unknown });
  return Object.assign(h, {
    disagreements,
    localized,
    expertSession: async (expert: { name: string; language?: "en" | "hi" }) => {
      const created = await h.createSession({ mode: "expert", caseSet: "training", expert });
      expect(created.status).toBe(201);
      const sessionId = (created.body as { sessionId: string }).sessionId;
      const frame = await h.postFrame(sessionId, { metadata: metadata({ frameSeq: 1 }), frame: png() });
      expect(frame.status).toBe(202);
      return { sessionId, frameEntryId: (frame.body as { ledgerId: string }).ledgerId };
    },
    stateRule: (sessionId: string, expertId: string, input: Parameters<ExpertsHarness["stateRule"]>[2]) => {
      const session = h.ledger.getSession(sessionId);
      const [frame] = h.ledger.list(sessionId, { kinds: ["frame.received"] });
      if (session === undefined || frame === undefined) throw new Error("session with a frame expected");
      const utterance = h.ledger.append({
        sessionId,
        source: "voice",
        kind: "utterance.transcript",
        occurredAt: T0,
        traceId: randomUUID(),
        parentIds: [],
        schemaVersion: 1,
        privacyEpoch: session.privacyEpoch,
        payload: { conversationId: "conv", text: input.quote, t0Ms: 1_000, t1Ms: 5_000, frameIds: [frame.id] },
      });
      const promoted = promoteToConfirmedRule({
        ruleId: input.id,
        domain: KYC_DOMAIN,
        decisionFamily: FAMILY,
        source: { statedRule: { ...input.rule, exactQuote: input.quote, t0Ms: 1_000, t1Ms: 5_000 } as StatedRule },
        priority: input.priority ?? RULE_PRIORITY_BY_KIND[input.rule.kind],
        overrides: input.overrides ?? [],
        evidence: [{ kind: "expert_quote", utteranceId: utterance.id, exactQuote: input.quote, t0Ms: 1_000, t1Ms: 5_000, frameIds: [frame.id], eventIds: [], relation: "supports", provenance: "human_voice" }],
        confirmation: { expertId, at: T0, method: "explicit_statement", ledgerEntryId: utterance.id },
        expertId,
        schemaVersion: 1,
        ledger: h.ledger,
      });
      if (!promoted.ok) throw new Error(`promotion failed: ${promoted.errors.map((e) => e.code).join(", ")}`);
      h.ledger.append({
        sessionId,
        source: "engine",
        kind: "rule.confirmed",
        occurredAt: T0,
        traceId: randomUUID(),
        parentIds: [utterance.id],
        schemaVersion: 1,
        privacyEpoch: session.privacyEpoch,
        payload: RuleConfirmedPayloadSchema.parse({ rule: promoted.rule }),
      });
      return promoted.rule;
    },
    get: async (query = `?experts=${PAIR.join(",")}&family=${FAMILY}`) => {
      const r = await reply(await handleGetDisagreements(new Request(`http://localhost/api/disagreements${query}`), disagreements));
      return { status: r.status, state: DisagreementsStateSchema.parse(r.body) };
    },
    getStatus: async (query: string) => (await handleGetDisagreements(new Request(`http://localhost/api/disagreements${query}`), disagreements)).status,
    search: async () => {
      const r = await reply(await handleSearchDisagreements(jsonRequest("/api/disagreements", { experts: PAIR, decisionFamily: FAMILY }), disagreements));
      if (r.status === 200) SearchDisagreementsResponseSchema.parse(r.body);
      return r;
    },
    answer: async (expertId: string, witnessId: string, decision: string, quote: string) => {
      const body = { experts: PAIR, decisionFamily: FAMILY, witnessId, expertId, decision, quote };
      const r = await reply(await handleAnswerDisagreement(jsonRequest("/api/disagreements/answer", body), disagreements));
      if (r.status === 200) AnswerDisagreementResponseSchema.parse(r.body);
      return r;
    },
  });
}
