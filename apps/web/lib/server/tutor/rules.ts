/**
 * The confirmed rules as the tutor teaches them (plan §7.7): which rules it teaches, their plain
 * wording, the expert's exact quote with attribution, the expert's moment behind it
 * (`replay_moment`), and the precomputed text of a spoken intervention. Deterministic: no model
 * writes any of this; quotes are copied verbatim from the rule's evidence.
 */
import "server-only";
import {
  actionPhrase,
  describePredicate,
  findFeature,
  featurePhrase,
  parseLedgerPayload,
  supportingQuotes,
  wordCount,
  type ActionId,
  type ConfirmedRule,
  type ExpertQuoteEvidence,
  type FeatureId,
  type LedgerEntry,
} from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { frameMediaUrl } from "../../contracts/frames";
import type { ExpertQuoteView, ReplayMoment } from "../../contracts/tutor";
import { REVIEW_OUTCOME_ACTIONS } from "../casedesk/session";

/** The decision family the novice works in CaseDesk. */
export const REVIEW_FAMILY = "reviewOutcome";

/** Spoken interventions stay short enough to say before Save (plan §7.7). */
export const MAX_INTERVENTION_WORDS = 40;

/**
 * Rules the tutor teaches: the review outcome's decision rules, and the guardrails on review outcomes
 * (`forbid` of an outcome, `require_approval` in the family). Risk-rating rules belong to a field the
 * novice edits, not to a decision the tutor asks about.
 */
export function taughtRules(rules: readonly ConfirmedRule[]): ConfirmedRule[] {
  return rules.filter(
    (r) =>
      (r.effect.type === "forbid" && REVIEW_OUTCOME_ACTIONS.has(r.effect.action)) ||
      (r.decisionFamily === REVIEW_FAMILY && r.effect.type !== "forbid"),
  );
}

/** A stop-rule forbids an outcome outright: the Save interlock blocks it and the monitor intervenes. */
export function isStopRule(rule: ConfirmedRule): boolean {
  return rule.effect.type === "forbid";
}

/** "never approve onboarding", "send to enhanced review", "get approval from a compliance officer". */
export function thenText(rule: ConfirmedRule): string {
  const { effect } = rule;
  switch (effect.type) {
    case "recommend":
      return actionPhrase(KYC_DOMAIN, effect.action);
    case "forbid":
      return `never ${actionPhrase(KYC_DOMAIN, effect.action)}`;
    case "require_approval":
      return `get approval from a ${effect.role.replaceAll("_", " ")}`;
    case "route":
      return `route to ${effect.destination.replaceAll("_", " ")}`;
  }
}

export function whenText(rule: ConfirmedRule): string {
  return describePredicate(rule.predicate, KYC_DOMAIN);
}

/** The rule's first supporting expert quote (structurally guaranteed by ConfirmedRuleSchema). */
export function primaryQuote(rule: ConfirmedRule): ExpertQuoteEvidence {
  const [first] = supportingQuotes(rule);
  return first ?? rule.evidence[0];
}

function attribution(quote: ExpertQuoteEvidence): string {
  return quote.provenance === "human_voice" ? "The expert, by voice" : "The expert, typed during the debrief";
}

function screenLine(entry: LedgerEntry): string {
  const e = parseLedgerPayload(entry, "screen.event");
  switch (e.kind) {
    case "open_case":
      return `Opened case ${e.caseId ?? ""}`.trim();
    case "navigate":
      return "Returned to the case queue";
    case "field_change":
      return `${findFeature(KYC_DOMAIN, e.field ?? "")?.label ?? e.field ?? "Field"}: ${e.from === undefined ? "" : `${String(e.from)} → `}${String(e.to)}`;
    case "action":
      return `Decided ${e.caseId ?? ""}: ${e.action === undefined ? "" : actionPhrase(KYC_DOMAIN, e.action)}`.trim();
  }
}

/**
 * The expert's moment behind a quote: the redacted frame (the latest of the quote's frames) when
 * perception captured one, else the DOM events the quote is tied to, and an honest note on what is
 * missing. Conversation audio is never stored, so playback is always unavailable, with the reason.
 */
export function replayMoment(ledger: Pick<Ledger, "get">, quote: ExpertQuoteEvidence): ReplayMoment {
  const moments = quote.frameIds.map((id) => ledger.get(id)).filter((e): e is LedgerEntry => e !== undefined);
  const frame = moments.findLast((e) => e.kind === "frame.received" && e.source === "client");
  const screen = moments.filter((e) => e.kind === "screen.event" && e.source === "dom").map(screenLine);
  const frameNote =
    frame !== undefined
      ? null
      : screen.length > 0
        ? "Frame unavailable: the expert's session recorded DOM events only (no screen capture)."
        : "Frame unavailable: no screen moment of this quote is on record.";
  return {
    frameUrl: frame === undefined ? null : frameMediaUrl(frame.sessionId, parseLedgerPayload(frame, "frame.received").frameId),
    frameNote,
    screen,
    audioNote:
      quote.provenance === "human_text"
        ? "No audio: the expert typed these words during the debrief."
        : "Audio playback unavailable: conversation audio is not stored, only the transcript quote.",
  };
}

export function quoteView(ledger: Pick<Ledger, "get">, rule: ConfirmedRule): ExpertQuoteView {
  const quote = primaryQuote(rule);
  return { text: quote.exactQuote, attribution: attribution(quote), replay: replayMoment(ledger, quote) };
}

function featureList(features: readonly FeatureId[]): string {
  const names = features.map((f) => {
    const feature = findFeature(KYC_DOMAIN, f);
    return feature === undefined ? f : featurePhrase(feature);
  });
  return names.length <= 1 ? (names[0] ?? "the missing details") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** First of the candidates within the word budget; the last one is the fallback. */
function within(candidates: readonly [string, ...string[]]): string {
  return candidates.find((c) => wordCount(c) <= MAX_INTERVENTION_WORDS) ?? candidates[candidates.length - 1] ?? candidates[0];
}

/**
 * What the tutor says (plan §7.7): "Careful — <rule in plain words>. The expert said: '<exact quote>'",
 * at most ~40 words. The quote is never shortened: when it does not fit, the plain wording goes first,
 * and when even the quote alone is too long, the novice is pointed to the quote on screen.
 */
export function interventionText(input: {
  rule: ConfirmedRule;
  trigger: "guardrail_violation" | "insufficient_information";
  proposedAction: ActionId;
  missingFeatures: readonly FeatureId[];
}): string {
  const { rule, trigger } = input;
  const quote = primaryQuote(rule).exactQuote;
  const plain =
    trigger === "guardrail_violation"
      ? `Careful — ${thenText(rule)} when ${whenText(rule)}.`
      : `Careful — before you ${actionPhrase(KYC_DOMAIN, input.proposedAction)}, check ${featureList(input.missingFeatures)}: the expert's rule depends on it.`;
  return within([
    `${plain} The expert said: "${quote}"`,
    `Careful — the expert said: "${quote}"`,
    `${plain} The expert's words are on your screen.`,
    `Careful — ${thenText(rule)} here. The expert's words are on your screen.`,
  ]);
}
