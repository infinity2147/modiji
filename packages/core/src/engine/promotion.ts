import type { DomainConfig } from "../schemas/domain";
import type { StatedRule } from "../schemas/engine";
import type { LedgerEntry } from "../schemas/ledger";
import { isEvidenceEligible } from "../schemas/ledger";
import type { Predicate } from "../schemas/predicate";
import type { ActionId } from "../schemas/primitives";
import {
  ConfirmedRuleSchema,
  type CandidateRule,
  type Confirmation,
  type ConfirmedRule,
  type EvidenceLink,
  type ExpertQuoteEvidence,
  type RuleEffect,
} from "../schemas/rules";
import { typecheckPredicate } from "../logic/typecheck";
import { containsQuote } from "./describe";

/** Read access to the ledger; the real `Ledger` and test fakes both satisfy it. */
export type LedgerReader = { get(id: string): Pick<LedgerEntry, "id" | "source" | "kind"> | undefined };

/** The ledger kind of a redacted screen frame: the only thing a quote's `frameIds` may point at. */
export const SCREEN_FRAME_KIND = "frame.received";

/**
 * Priority of a rule confirmed from the expert's own statement, by kind, until the expert orders
 * rules explicitly (debrief `revise_rule`): guardrails above exceptions above escalations above plain
 * decisions. Priority orders decision rules within a family (solver, Work Map); stop-rules
 * (`forbid`, `require_approval`) are enforced by `checkAction` whatever their priority.
 */
export const RULE_PRIORITY_BY_KIND: Readonly<Record<ConfirmedRule["kind"], number>> = {
  decision: 10,
  escalation: 20,
  exception: 30,
  guardrail: 40,
};

export type PromotionError =
  | { code: "utterance_missing"; evidenceIndex: number; utteranceId: string }
  | { code: "utterance_not_expert"; evidenceIndex: number; utteranceId: string; source: string }
  | { code: "frame_missing"; evidenceIndex: number; frameId: string }
  | { code: "not_a_frame"; evidenceIndex: number; frameId: string; kind: string }
  | { code: "event_missing"; evidenceIndex: number; eventId: string }
  | { code: "not_evidence"; evidenceIndex: number; ledgerEntryId: string }
  | { code: "link_missing"; linkIndex: number; ledgerEntryId: string }
  | { code: "blank_quote"; evidenceIndex: number }
  | { code: "reversed_timestamps"; evidenceIndex: number; t0Ms: number; t1Ms: number }
  | { code: "first_evidence_not_supporting" }
  | { code: "stated_quote_not_in_evidence" }
  | { code: "confirmation_missing"; ledgerEntryId: string }
  | { code: "predicate_invalid"; issues: string[] }
  | { code: "action_not_in_family"; action: string }
  | { code: "schema_invalid"; issues: string[] };

export type NonQuoteLink = Exclude<EvidenceLink, { kind: "expert_quote" }>;

export type PromotionResult = { ok: true; rule: ConfirmedRule } | { ok: false; errors: PromotionError[] };

/** Utterances count as evidence only from the expert's microphone (`voice`) or the expert's own typed input (`expert`). */
const UTTERANCE_SOURCES: readonly string[] = ["voice", "expert"];

/**
 * Promotes a candidate, or a rule the expert stated, to a ConfirmedRule (plan §6.4, §7.3).
 * Code checks every link against the ledger — nothing the LLM produced is trusted:
 *   - at least one expert quote, the first one supporting; every quote non-blank with t1 ≥ t0;
 *   - each `utteranceId` exists and comes from `voice` or `expert` (never `system_control`);
 *   - each frame id is a real redacted screen frame (`frame.received`) — never a DOM event or any
 *     other stand-in — and each frame and event id, and each further link's ledger entry, exists and
 *     is evidence-eligible (not `system_control`);
 *   - for a stated rule, its exact quote appears in one of the supporting quotes;
 *   - the confirmation's ledger entry exists and is evidence-eligible;
 *   - the predicate type-checks against the domain and the action belongs to the family.
 * All problems are reported together. The result also passes `ConfirmedRuleSchema` (revision 1).
 */
export function promoteToConfirmedRule(input: {
  ruleId: string;
  domain: DomainConfig;
  decisionFamily: string;
  source: { candidate: CandidateRule } | { statedRule: StatedRule };
  /**
   * Defaults: the stated rule's kind and effect; for a candidate, "decision" and `recommend` of the
   * predicted action. An explicit effect is for revisions that keep a rule's own effect.
   */
  kind?: ConfirmedRule["kind"];
  effect?: RuleEffect;
  priority: number;
  overrides: string[];
  evidence: readonly ExpertQuoteEvidence[];
  /** Further non-quote links (frames, events, observed decisions), appended after the quotes. */
  links?: readonly NonQuoteLink[];
  confirmation: Confirmation;
  expertId: string;
  schemaVersion: number;
  ledger: LedgerReader;
}): PromotionResult {
  const { domain, ledger } = input;
  const errors: PromotionError[] = [];
  const { predicate, action }: { predicate: Predicate; action: ActionId } =
    "candidate" in input.source
      ? { predicate: input.source.candidate.predicate, action: input.source.candidate.predictedAction }
      : { predicate: input.source.statedRule.predicate, action: input.source.statedRule.action };

  const issues = typecheckPredicate(predicate, domain.features);
  if (issues.length > 0) errors.push({ code: "predicate_invalid", issues: issues.map((i) => `${i.path || "/"}: ${i.message}`) });
  const family = domain.decisionFamilies.find((f) => f.id === input.decisionFamily);
  if (family === undefined || !family.actions.includes(action)) errors.push({ code: "action_not_in_family", action });

  input.evidence.forEach((e, evidenceIndex) => {
    if (e.exactQuote.trim() === "") errors.push({ code: "blank_quote", evidenceIndex });
    if (e.t1Ms < e.t0Ms) errors.push({ code: "reversed_timestamps", evidenceIndex, t0Ms: e.t0Ms, t1Ms: e.t1Ms });
    const utterance = ledger.get(e.utteranceId);
    if (utterance === undefined) errors.push({ code: "utterance_missing", evidenceIndex, utteranceId: e.utteranceId });
    else if (!UTTERANCE_SOURCES.includes(utterance.source))
      errors.push({ code: "utterance_not_expert", evidenceIndex, utteranceId: e.utteranceId, source: utterance.source });
    for (const frameId of e.frameIds) {
      const frame = ledger.get(frameId);
      if (frame === undefined) errors.push({ code: "frame_missing", evidenceIndex, frameId });
      else if (!isEvidenceEligible(frame)) errors.push({ code: "not_evidence", evidenceIndex, ledgerEntryId: frameId });
      else if (frame.kind !== SCREEN_FRAME_KIND) errors.push({ code: "not_a_frame", evidenceIndex, frameId, kind: frame.kind });
    }
    for (const eventId of e.eventIds) {
      const event = ledger.get(eventId);
      if (event === undefined) errors.push({ code: "event_missing", evidenceIndex, eventId });
      else if (!isEvidenceEligible(event)) errors.push({ code: "not_evidence", evidenceIndex, ledgerEntryId: eventId });
    }
  });
  (input.links ?? []).forEach((link, linkIndex) => {
    const entry = ledger.get(link.ledgerEntryId);
    if (entry === undefined || !isEvidenceEligible(entry)) errors.push({ code: "link_missing", linkIndex, ledgerEntryId: link.ledgerEntryId });
  });
  const [first, ...rest] = input.evidence;
  if (first === undefined || first.relation !== "supports") errors.push({ code: "first_evidence_not_supporting" });
  if ("statedRule" in input.source) {
    const quote = input.source.statedRule.exactQuote;
    if (!input.evidence.some((e) => e.relation === "supports" && containsQuote(e.exactQuote, quote)))
      errors.push({ code: "stated_quote_not_in_evidence" });
  }
  const confirming = ledger.get(input.confirmation.ledgerEntryId);
  if (confirming === undefined || !isEvidenceEligible(confirming))
    errors.push({ code: "confirmation_missing", ledgerEntryId: input.confirmation.ledgerEntryId });
  if (errors.length > 0 || first === undefined) return { ok: false, errors };

  const kind = input.kind ?? ("statedRule" in input.source ? input.source.statedRule.kind : "decision");
  const effect = input.effect ?? ("statedRule" in input.source ? input.source.statedRule.effect : { type: "recommend", action });
  const parsed = ConfirmedRuleSchema.safeParse({
    id: input.ruleId,
    decisionFamily: input.decisionFamily,
    kind,
    predicate,
    effect,
    priority: input.priority,
    overrides: input.overrides,
    evidence: [first, ...rest, ...(input.links ?? [])],
    confirmedBy: [input.confirmation],
    revision: 1,
    schemaVersion: input.schemaVersion,
    expertId: input.expertId,
  });
  if (!parsed.success)
    return { ok: false, errors: [{ code: "schema_invalid", issues: parsed.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`) }] };
  return { ok: true, rule: parsed.data };
}
