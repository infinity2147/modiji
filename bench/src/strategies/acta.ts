import { canonicalJson, evaluatePredicate, recordLookup, type ActionId, type Assignment, type Feature, type Value } from "@vashistha/core";
import { DOMAIN } from "../domain";
import type { Strategy } from "./session";

/**
 * (C) ACTA-style templates (Applied Cognitive Task Analysis), fixed and non-adaptive:
 *   1. live: a why-probe after the FIRST occurrence of each action in the stream;
 *   2. debrief: "what would make you decide differently?" as counterfactuals in a fixed
 *      perturbation pattern — stream cases in order, each feature in domain order moved by
 *      `perturb` — skipping moves that leave the valid domain or repeat a case already decided.
 */
export const actaTemplates: Strategy = async (session) => {
  const seen = new Set<ActionId>();
  session.stream.forEach((_, i) => {
    const { caseId, action } = session.decide(i);
    if (seen.has(action)) return;
    seen.add(action);
    if (session.canAsk) session.ask({ kind: "why", caseId }, { phase: "live", pause: i });
  });

  const decided = new Set(session.stream.map((c) => canonicalJson(c.features)));
  for (const c of session.stream)
    for (const f of DOMAIN.features) {
      if (!session.canAsk) return;
      const features = perturb(c.features, f);
      if (features === undefined || decided.has(canonicalJson(features))) continue;
      decided.add(canonicalJson(features));
      session.ask({ kind: "counterfactual", caseId: `${c.caseId}~${f.id}`, features }, { phase: "debrief" });
    }
};

/**
 * The template's fixed move of one feature: booleans flip, enums take the next declared value
 * (cyclically), numbers halve when above the middle of their range and double otherwise (rounded
 * for integer features, clamped). Undefined when the move is a no-op or breaks a domain constraint.
 */
export function perturb(features: Assignment, f: Feature): Assignment | undefined {
  const v = features[f.id];
  if (v === undefined) return undefined;
  let next: Value;
  switch (f.type) {
    case "boolean":
      next = !v;
      break;
    case "enum":
      next = f.values[(f.values.indexOf(String(v)) + 1) % f.values.length] ?? v;
      break;
    case "string":
      return undefined;
    case "number": {
      const x = Number(v);
      const moved = x > (f.min + f.max) / 2 ? x / 2 : x * 2;
      next = Math.min(f.max, Math.max(f.min, f.integer ? Math.round(moved) : moved));
      break;
    }
  }
  if (next === v) return undefined;
  const out = { ...features, [f.id]: next };
  const lookup = recordLookup(out);
  return DOMAIN.domainConstraints.every((c) => evaluatePredicate(c, lookup).truth === true) ? out : undefined;
}
