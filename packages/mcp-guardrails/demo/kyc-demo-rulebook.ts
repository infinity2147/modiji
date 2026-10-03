/**
 * A SYNTHETIC confirmed rulebook for the KYC domain, used by the tests and the local demo server
 * until P5 produces real confirmed rules from an expert session. The quotes, utterance ids, frame
 * ids and timestamps are written by hand; they were not captured from a real expert. Production
 * serves `runtime.rulebook()` instead (see README).
 */
import { ConfirmedRuleSchema, type ConfirmedRule } from "@vashistha/core";

const EXPERT_ID = "expert-demo";
const CONFIRMED_AT = Date.UTC(2026, 9, 4, 9, 0, 0);

type DemoRule = {
  id: string;
  kind: ConfirmedRule["kind"];
  decisionFamily: string;
  predicate: unknown;
  effect: unknown;
  priority: number;
  overrides?: string[];
  quote: string;
  t0Ms: number;
  t1Ms: number;
};

function confirmed(r: DemoRule): ConfirmedRule {
  return ConfirmedRuleSchema.parse({
    id: r.id,
    decisionFamily: r.decisionFamily,
    kind: r.kind,
    predicate: r.predicate,
    effect: r.effect,
    priority: r.priority,
    overrides: r.overrides ?? [],
    evidence: [
      {
        kind: "expert_quote",
        utteranceId: `utt-${r.id}`,
        exactQuote: r.quote,
        t0Ms: r.t0Ms,
        t1Ms: r.t1Ms,
        frameIds: [`frame-${r.id}`],
        eventIds: [],
        relation: "supports",
        provenance: "human_voice",
      },
    ],
    confirmedBy: [{ expertId: EXPERT_ID, at: CONFIRMED_AT, method: "debrief", ledgerEntryId: `ledger-confirm-${r.id}` }],
    revision: 1,
    schemaVersion: 1,
    expertId: EXPERT_ID,
  });
}

export const DEMO_RULEBOOK_REVISION = 3;

const SPECS: readonly DemoRule[] = [
  {
    id: "R-sanctions",
    kind: "guardrail",
    decisionFamily: "reviewOutcome",
    predicate: { "==": [{ var: "sanctionsHit" }, true] },
    effect: { type: "forbid", action: "approve" },
    priority: 100,
    quote: "Any sanctions match and we never approve. Full stop. It goes to compliance.",
    t0Ms: 41_200,
    t1Ms: 45_900,
  },
  {
    id: "R-high-risk-country",
    kind: "guardrail",
    decisionFamily: "reviewOutcome",
    predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] },
    effect: { type: "forbid", action: "approve" },
    priority: 80,
    quote: "High-risk country on the Northstar list? I don't approve that at desk level, however clean the file looks.",
    t0Ms: 132_400,
    t1Ms: 139_100,
  },
  {
    id: "R-long-standing-exception",
    kind: "exception",
    decisionFamily: "reviewOutcome",
    predicate: {
      and: [
        { "==": [{ var: "customerStatus" }, "existing"] },
        { ">=": [{ var: "accountAgeMonths" }, 24] },
        { "==": [{ var: "sourceOfFunds" }, "verified"] },
      ],
    },
    effect: { type: "recommend", action: "approve" },
    priority: 90,
    overrides: ["R-high-risk-country"],
    quote: "The exception is someone we've banked for two years or more with verified funds. Then the country alone doesn't stop me.",
    t0Ms: 151_800,
    t1Ms: 158_300,
  },
  {
    id: "R-unverified-owner",
    kind: "guardrail",
    decisionFamily: "reviewOutcome",
    predicate: {
      and: [
        { in: [{ var: "entityType" }, ["company", "trust"]] },
        { ">": [{ var: "uboOwnershipPct" }, 25] },
        { "==": [{ var: "uboVerified" }, false] },
      ],
    },
    effect: { type: "forbid", action: "approve" },
    priority: 70,
    quote: "Anyone holding more than twenty-five percent has to be verified before I approve. Otherwise I request the documents.",
    t0Ms: 18_600,
    t1Ms: 24_000,
  },
  {
    id: "R-pep-approval",
    kind: "escalation",
    decisionFamily: "reviewOutcome",
    predicate: { "==": [{ var: "pep" }, true] },
    effect: { type: "require_approval", role: "compliance officer" },
    priority: 60,
    quote: "A politically exposed person always needs a compliance officer's sign-off, whatever I decide.",
    t0Ms: 205_000,
    t1Ms: 210_500,
  },
];

export const DEMO_RULES: readonly ConfirmedRule[] = SPECS.map(confirmed);
