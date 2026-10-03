/** Registry-valid ledger fixtures for the ticker and compliance-strip tests. */
import type { LedgerEntry } from "@vashistha/core";
import { entry, question } from "./interview-support";

export const ALLOW = { decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] } as const;

const screen = (over: Record<string, unknown>, source: "dom" | "vision" = "dom") => ({
  id: `evt-${Math.random().toString(36).slice(2, 10)}`,
  frameSeq: 1,
  captureTime: 1_700_000_000_000,
  sessionEpoch: 0,
  confidence: source === "dom" ? 1 : 0.92,
  source,
  critical: false,
  ...over,
});

export const fixtures = {
  openCase: () => entry("screen.event", "dom", screen({ kind: "open_case", caseId: "NS-2026-0101" })),
  riskChange: () =>
    entry(
      "screen.event",
      "dom",
      screen({ kind: "field_change", caseId: "NS-2026-0101", field: "riskRating", from: "medium", to: "high", critical: true }),
    ),
  boRead: () =>
    entry("screen.event", "vision", screen({ kind: "field_change", caseId: "NS-2026-0101", field: "uboOwnershipPct", to: 35 }, "vision")),
  action: () => entry("screen.event", "dom", screen({ kind: "action", caseId: "NS-2026-0101", action: "enhancedReview" })),
  decision: (caseId = "NS-2026-0101", action = "enhancedReview", override?: { kind: "acknowledged" | "escalated"; note: string }) =>
    entry("case.decision", "dom", { caseId, action, edits: { riskRating: "high" }, result: ALLOW, ...(override && { override }) }),
  queued: (id: string, kind: "counterfactual" | "witness" | "intervention" = "counterfactual") =>
    entry("question.queued", "engine", question(id, { kind })),
  authorized: (questionId: string) =>
    entry("gate.authorized", "engine", {
      questionId,
      contextVersion: 4,
      becameValidAt: 1_700_000_000_000,
      decidedAt: 1_700_000_000_012,
      conditions: { userSilent: true },
    }),
  control: (questionId: string) => entry("gate.control_message", "system_control", { nonceDigest: "ab12", questionId }),
  speak: (questionId: string) => entry("llm.turn_decision", "engine", { decision: "speak", questionId, agent: "interviewer" }),
  skip: () => entry("llm.turn_decision", "engine", { decision: "skip_turn", reason: "no_authorization", agent: "interviewer" }),
  aborted: (decision: LedgerEntry, questionId: string) =>
    entry("llm.stream_aborted", "engine", { questionId, nonceReleased: true }, { parentIds: [decision.id] }),
  offRecord: () => entry("privacy.off_record", "system_control", { offRecord: true, privacyEpoch: 1 }, { privacyEpoch: 1 }),
  onRecord: () => entry("privacy.on_record", "system_control", { offRecord: false, privacyEpoch: 2 }, { privacyEpoch: 2 }),
  utterance: (text: string) =>
    entry("utterance.transcript", "voice", { conversationId: "conv-1", text, t0Ms: 1000, t1Ms: 3000, frameIds: [] }),
  ruleConfirmed: (kind: "guardrail" | "decision") => entry("rule.confirmed", "expert", { ruleId: `rule-${kind}`, kind }),
  witnessResolved: (n: number) =>
    entry("witness.resolved", "engine", { witnessId: `w-${n}`, resolution: "rule_added", ledgerEntryId: `l-${n}` }),
  teachbackConfirmed: () => entry("teachback.confirmed", "engine", { utteranceId: "u-9", rulebookRevision: 3 }),
  intervention: (caseId = "NS-2026-0201", proposedAction = "approve") =>
    entry("tutor.intervention", "engine", {
      caseId,
      trigger: "guardrail_violation",
      proposedAction,
      ruleIds: ["rule-guardrail"],
      questionId: "q-int",
    }),
};
