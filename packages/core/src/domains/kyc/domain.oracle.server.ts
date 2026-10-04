import "server-only";
/**
 * HIDDEN POLICY: server/bench only. Never import from client code, never put into a model prompt
 * (plan §6.2, §9). Next.js refuses to bundle this module for the browser (`server-only`), and the
 * ORACLE_MARKER canary embedded in the policy makes any leak into a bundle or prompt detectable.
 *
 * "NSRP-1", the Northstar Bank Synthetic Review Policy: a FICTIONAL policy for a fictional bank
 * with fictional jurisdictions and thresholds. It is not, and must never be presented as, real law
 * or real KYC guidance. Designed interactions: threshold (UBO > 25 %), exception (long-standing
 * customer in a high-risk country), escalation (PEP), missing-data condition (no source of funds at
 * high volume), multi-factor conjunction (adverse media outside low-risk countries).
 *
 * Judgment a reviewer must bring (each has on-screen evidence that does not state the rule):
 * a cash-intensive business is sent to enhanced review unless established and consistent (an exception);
 * a nominee shareholder needs a nominator declaration, a holding company above the customer is looked
 * through; activity far above the declared turnover needs documents; serious adverse media escalates
 * even in a low-risk country; a strong sanctions name-match is never cleared at the desk, a weak one
 * only matters outside low-risk countries. Priorities are distinct per action so no two recommendations
 * with different actions ever share a level.
 */
import { evaluatePredicate, type FeatureLookup } from "../../logic/evaluate";
import { typecheckPredicate } from "../../logic/typecheck";
import { PredicateSchema } from "../../schemas/predicate";
import { ActionIdSchema, type ActionId } from "../../schemas/primitives";
import { RuleEffectSchema } from "../../schemas/rules";
import type { HiddenPolicy, OracleResult, OracleRule } from "../oracle-types";
import { KYC_DOMAIN } from "./domain.public";

export type { HiddenPolicy, OracleResult, OracleRule } from "../oracle-types";

export const ORACLE_MARKER = "oracle:kycNorthstar:ae833993b04a31cf8e4b540f";

type RawRule = Omit<OracleRule, "predicate" | "effect"> & { predicate: unknown; effect: unknown };

const RAW_RULES = [
  // reviewOutcome — higher priority wins among firing rules.
  {
    id: "nsrp.sanctions.reject",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { "==": [{ var: "sanctionsHit" }, true] },
    effect: { type: "recommend", action: "reject" },
    priority: 100,
    overrides: [],
    summary: "A sanctions screening match means the application is rejected.",
  },
  {
    id: "nsrp.sanctions.no_approve",
    decisionFamily: "reviewOutcome",
    kind: "guardrail",
    predicate: { "==": [{ var: "sanctionsHit" }, true] },
    effect: { type: "forbid", action: "approve" },
    priority: 100,
    overrides: [],
    summary: "Never approve a customer with a sanctions screening match.",
  },
  {
    id: "nsrp.name.strong.escalate",
    decisionFamily: "reviewOutcome",
    kind: "escalation",
    predicate: { "==": [{ var: "nameMatch" }, "strong"] },
    effect: { type: "recommend", action: "escalateCompliance" },
    priority: 95,
    overrides: [],
    summary: "A strong name match to a sanctions-list entry (date of birth and nationality align) goes to the compliance officer; it is never cleared at the desk.",
  },
  {
    id: "nsrp.name.strong.no_approve",
    decisionFamily: "reviewOutcome",
    kind: "guardrail",
    predicate: { "==": [{ var: "nameMatch" }, "strong"] },
    effect: { type: "forbid", action: "approve" },
    priority: 95,
    overrides: [],
    summary: "Never approve a customer with an unresolved strong sanctions name match.",
  },
  {
    id: "nsrp.pep.escalate",
    decisionFamily: "reviewOutcome",
    kind: "escalation",
    predicate: { "==": [{ var: "pep" }, true] },
    effect: { type: "recommend", action: "escalateCompliance" },
    priority: 90,
    overrides: [],
    summary: "Any politically exposed person among the owners goes to the compliance officer.",
  },
  {
    id: "nsrp.pep.approval",
    decisionFamily: "reviewOutcome",
    kind: "guardrail",
    predicate: { "==": [{ var: "pep" }, true] },
    effect: { type: "require_approval", role: "compliance_officer" },
    priority: 90,
    overrides: [],
    summary: "Approving a politically exposed person needs compliance officer sign-off.",
  },
  {
    id: "nsrp.media.serious",
    decisionFamily: "reviewOutcome",
    kind: "escalation",
    predicate: { "==": [{ var: "mediaSeverity" }, "serious"] },
    effect: { type: "recommend", action: "escalateCompliance" },
    priority: 85,
    overrides: [],
    summary: "Serious adverse media (fraud, bribery, corruption, criminal conduct) goes to the compliance officer, in any country and for any customer age.",
  },
  {
    id: "nsrp.funds.missing",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: {
      and: [{ "==": [{ var: "sourceOfFunds" }, "not_provided"] }, { ">=": [{ var: "expectedMonthlyVolume" }, 50000] }],
    },
    effect: { type: "recommend", action: "requestDocuments" },
    priority: 80,
    overrides: [],
    summary: "No source of funds at an expected volume of EUR 50,000 a month or more: request documents.",
  },
  {
    id: "nsrp.volume.inconsistent",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { "==": [{ var: "volumeConsistency" }, "inconsistent"] },
    effect: { type: "recommend", action: "requestDocuments" },
    priority: 78,
    overrides: [],
    summary: "Expected activity of more than 2.5 times the declared annual turnover does not fit the business: request documents.",
  },
  {
    id: "nsrp.structure.nominee",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { "==": [{ var: "ownershipTransparency" }, "nominee"] },
    effect: { type: "recommend", action: "requestDocuments" },
    priority: 75,
    overrides: [],
    summary: "A nominee shareholder hides the party behind the shares: request the nominator declaration before anything else.",
  },
  {
    id: "nsrp.structure.layered",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: {
      and: [{ "==": [{ var: "ownershipTransparency" }, "layered"] }, { "!=": [{ var: "jurisdictionRisk" }, "low"] }],
    },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 65,
    overrides: [],
    summary: "A holding company above the customer, outside a low-risk country, goes to enhanced review so the people behind it are looked through.",
  },
  {
    id: "nsrp.volume.elevated",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: {
      and: [{ "==": [{ var: "volumeConsistency" }, "elevated"] }, { "==": [{ var: "sectorRisk" }, "high"] }],
    },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 62,
    overrides: [],
    summary: "Activity above the declared turnover in a high-risk sector goes to enhanced review.",
  },
  {
    id: "nsrp.name.weak.edd",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { and: [{ "==": [{ var: "nameMatch" }, "weak"] }, { "!=": [{ var: "jurisdictionRisk" }, "low"] }] },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 61,
    overrides: [],
    summary: "A weak name match (the name alone is similar) outside a low-risk country goes to enhanced review; in a low-risk country it is a routine false positive.",
  },
  {
    id: "nsrp.sector.cash",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: {
      and: [{ "==": [{ var: "sectorRisk" }, "high"] }, { ">=": [{ var: "expectedMonthlyVolume" }, 25000] }],
    },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 60,
    overrides: [],
    summary: "A business in a high-risk sector (cash-heavy, value transfer) expecting EUR 25,000 a month or more goes to enhanced review.",
  },
  {
    id: "nsrp.sector.cash.established",
    decisionFamily: "reviewOutcome",
    kind: "exception",
    // Like every exception here, it carries the conditions of the rule it lifts (a high-risk sector, EUR 25,000 or more),
    // so it only fires where that rule would have.
    predicate: {
      and: [
        { "==": [{ var: "sectorRisk" }, "high"] },
        { ">=": [{ var: "expectedMonthlyVolume" }, 25000] },
        { "==": [{ var: "customerStatus" }, "existing"] },
        { ">=": [{ var: "accountAgeMonths" }, 12] },
        { "==": [{ var: "sourceOfFunds" }, "verified"] },
        { "==": [{ var: "volumeConsistency" }, "consistent"] },
      ],
    },
    effect: { type: "recommend", action: "approve" },
    // Below every enhanced-review trigger: it lifts only the sector rule it overrides, so a PEP, serious media,
    // an unverified large owner or a holding-company structure still send the case on.
    priority: 50,
    overrides: ["nsrp.sector.cash"],
    summary:
      "Exception: an established customer (12 months or more) with verified source of funds and activity consistent with its declared turnover is not sent to enhanced review for its sector alone.",
  },
  {
    id: "nsrp.highrisk.longstanding",
    decisionFamily: "reviewOutcome",
    kind: "exception",
    predicate: {
      and: [
        { "==": [{ var: "customerStatus" }, "existing"] },
        { ">=": [{ var: "accountAgeMonths" }, 24] },
        { "==": [{ var: "sourceOfFunds" }, "verified"] },
        { "==": [{ var: "jurisdictionRisk" }, "high"] },
      ],
    },
    effect: { type: "recommend", action: "approve" },
    // Below the other enhanced-review triggers (60): the exception lifts only the jurisdiction rule it
    // overrides, so an unverified large owner or adverse media still sends the case to enhanced review.
    priority: 50,
    overrides: ["nsrp.highrisk.edd"],
    summary:
      "Exception: an existing customer of at least 24 months with verified source of funds in a high-risk country is not sent to enhanced review for the country alone.",
  },
  {
    id: "nsrp.highrisk.edd",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 60,
    overrides: [],
    summary: "A customer in a high-risk country goes to enhanced review.",
  },
  {
    id: "nsrp.ubo.threshold",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: {
      and: [
        { "!=": [{ var: "entityType" }, "individual"] },
        { ">": [{ var: "uboOwnershipPct" }, 25] },
        { "==": [{ var: "uboVerified" }, false] },
      ],
    },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 60,
    overrides: [],
    summary: "A company or trust whose largest owner holds more than 25 % and is not identity-verified goes to enhanced review.",
  },
  {
    id: "nsrp.media.edd",
    decisionFamily: "reviewOutcome",
    kind: "decision",
    predicate: { and: [{ "==": [{ var: "adverseMedia" }, true] }, { "!=": [{ var: "jurisdictionRisk" }, "low"] }] },
    effect: { type: "recommend", action: "enhancedReview" },
    priority: 60,
    overrides: [],
    summary: "Adverse media outside a low-risk country goes to enhanced review.",
  },
  // riskRating
  {
    id: "nsrp.rating.high",
    decisionFamily: "riskRating",
    kind: "decision",
    predicate: {
      or: [
        { "==": [{ var: "sanctionsHit" }, true] },
        { "==": [{ var: "pep" }, true] },
        { "==": [{ var: "jurisdictionRisk" }, "high"] },
        { "==": [{ var: "nameMatch" }, "strong"] },
        { "==": [{ var: "mediaSeverity" }, "serious"] },
        { "==": [{ var: "ownershipTransparency" }, "nominee"] },
      ],
    },
    effect: { type: "recommend", action: "rateHigh" },
    priority: 20,
    overrides: [],
    summary:
      "Sanctions match, strong name match, politically exposed person, high-risk country, serious adverse media or a nominee shareholder: high risk.",
  },
  {
    id: "nsrp.rating.medium",
    decisionFamily: "riskRating",
    kind: "decision",
    predicate: {
      or: [
        { "==": [{ var: "jurisdictionRisk" }, "medium"] },
        { "==": [{ var: "adverseMedia" }, true] },
        { and: [{ "!=": [{ var: "entityType" }, "individual"] }, { ">": [{ var: "uboOwnershipPct" }, 25] }] },
        { "==": [{ var: "sectorRisk" }, "high"] },
        { "==": [{ var: "ownershipTransparency" }, "layered"] },
        { "!=": [{ var: "volumeConsistency" }, "consistent"] },
        { "==": [{ var: "nameMatch" }, "weak"] },
      ],
    },
    effect: { type: "recommend", action: "rateMedium" },
    priority: 10,
    overrides: [],
    summary:
      "Medium-risk country, adverse media, a company/trust with an owner above 25 %, a high-risk sector, a holding-company structure, activity above the declared turnover or a weak name match: medium risk.",
  },
] as const satisfies readonly RawRule[];

/**
 * The action of a family when none of its recommend rules fires. These are NSRP-1's default rules
 * (e.g. `nsrp.default.approve`, priority 0): an always-true condition is not expressible as a
 * predicate (no constant predicates), so the defaults live here and fire with `firedRuleIds: []`.
 */
const DEFAULT_ACTIONS: Readonly<Record<string, ActionId>> = {
  reviewOutcome: ActionIdSchema.parse("approve"),
  riskRating: ActionIdSchema.parse("rateLow"),
};

const RULES: OracleRule[] = RAW_RULES.map((r) => ({
  ...r,
  overrides: [...r.overrides],
  predicate: PredicateSchema.parse(r.predicate),
  effect: RuleEffectSchema.parse(r.effect),
})).sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

assertWellFormed(RULES);

function evaluate(features: FeatureLookup): OracleResult {
  const truth = new Map<string, boolean>();
  for (const r of RULES) {
    const t = evaluatePredicate(r.predicate, features).truth;
    if (t === "unknown") throw new Error(`NSRP-1 is defined on complete cases only; rule "${r.id}" is unknown`);
    truth.set(r.id, t);
  }
  // Overriders are never themselves overridden (asserted at load), so "fires" is "true and not overridden by a true rule".
  const fired = RULES.filter((r) => truth.get(r.id) === true && !RULES.some((o) => o.overrides.includes(r.id) && truth.get(o.id) === true));

  const decisions: OracleResult["decisions"] = {};
  for (const family of KYC_DOMAIN.decisionFamilies) {
    const firedInFamily = fired.filter((r) => r.decisionFamily === family.id);
    const recommended = firedInFamily.flatMap((r) => (r.effect.type === "recommend" ? [{ rule: r, action: r.effect.action }] : []));
    const [top] = recommended;
    const clash = recommended.find((c) => top !== undefined && c.rule.priority === top.rule.priority && c.action !== top.action);
    if (top !== undefined && clash !== undefined)
      throw new Error(`NSRP-1 conflict: "${top.rule.id}" and "${clash.rule.id}" fire at priority ${top.rule.priority} with different actions`);
    decisions[family.id] = { action: top?.action ?? defaultAction(family.id), firedRuleIds: firedInFamily.map((r) => r.id) };
  }

  const forbidden = fired.flatMap((r) => (r.effect.type === "forbid" ? [r.effect.action] : []));
  return { decisions, forbidden: [...new Set(forbidden)].sort() };
}

function defaultAction(familyId: string): ActionId {
  const action = DEFAULT_ACTIONS[familyId];
  if (action === undefined) throw new Error(`NSRP-1 has no default for decision family "${familyId}"`);
  return action;
}

/** Load-time self-check: every rule fits KYC_DOMAIN, every family has a default, override edges are one level deep. */
function assertWellFormed(rules: readonly OracleRule[]): void {
  const issues: string[] = [];
  const ids = new Set(rules.map((r) => r.id));
  const overridden = new Set(rules.flatMap((r) => r.overrides));
  for (const family of KYC_DOMAIN.decisionFamilies)
    if (DEFAULT_ACTIONS[family.id] === undefined) issues.push(`family "${family.id}" has no default action`);
  for (const r of rules) {
    const { effect } = r;
    const family = KYC_DOMAIN.decisionFamilies.find((f) => f.id === r.decisionFamily);
    if (family === undefined) issues.push(`${r.id}: unknown family "${r.decisionFamily}"`);
    if (effect.type === "recommend" && !family?.actions.includes(effect.action))
      issues.push(`${r.id}: recommends "${effect.action}" outside its family`);
    if (effect.type === "forbid" && !KYC_DOMAIN.actions.some((a) => a.id === effect.action))
      issues.push(`${r.id}: forbids unknown action "${effect.action}"`);
    for (const o of r.overrides) if (!ids.has(o)) issues.push(`${r.id}: overrides unknown rule "${o}"`);
    if (r.overrides.length > 0 && overridden.has(r.id)) issues.push(`${r.id}: an overrider must not itself be overridden`);
    for (const issue of typecheckPredicate(r.predicate, KYC_DOMAIN.features)) issues.push(`${r.id}${issue.path}: ${issue.message}`);
  }
  if (issues.length > 0) throw new Error(`NSRP-1 is malformed:\n  ${issues.join("\n  ")}`);
}

export const KYC_HIDDEN_POLICY: HiddenPolicy = {
  marker: ORACLE_MARKER,
  domainId: KYC_DOMAIN.id,
  /** A copy: callers cannot alter what `evaluate` uses. */
  rules: structuredClone(RULES),
  evaluate,
};
