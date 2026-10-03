/**
 * Shapes of a hidden policy (plan §6.2, §9). Types only, so safe to import anywhere; the policies
 * themselves live in `*.oracle.server.ts` modules (server/bench only).
 */
import type { FeatureLookup } from "../logic/evaluate";
import type { Predicate } from "../schemas/predicate";
import type { ActionId } from "../schemas/primitives";
import type { RuleEffect } from "../schemas/rules";

/** Like a ConfirmedRule but without evidence or confirmation: the oracle is ground truth for the bench, not expert-confirmed. */
export type OracleRule = {
  id: string;
  decisionFamily: string;
  kind: "decision" | "guardrail" | "escalation" | "exception";
  predicate: Predicate;
  effect: RuleEffect;
  /** Higher wins within a family. */
  priority: number;
  /** Ids of rules this rule overrides: an overridden rule does not fire when this rule fires. */
  overrides: string[];
  summary: string;
};

export type OracleResult = {
  /** Per decision family: the oracle's action and the ids of every rule of that family that fired (priority desc, then id). */
  decisions: Record<string, { action: ActionId; firedRuleIds: string[] }>;
  /** Actions forbidden by a firing `forbid` rule (sorted). */
  forbidden: ActionId[];
};

export type HiddenPolicy = {
  /** The module's ORACLE_MARKER: a serialised policy carries it, so a leak is detectable. */
  marker: string;
  domainId: string;
  rules: OracleRule[];
  /** Defined on complete cases only: throws if any rule evaluates to unknown. */
  evaluate(features: FeatureLookup): OracleResult;
};
