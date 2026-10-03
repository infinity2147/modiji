import type { Feature } from "../schemas/domain";
import type { FeatureId, Value } from "../schemas/primitives";
import { ORDERING_OPS, isVarRef, type ComparisonOp, type Operand, type Predicate } from "../schemas/predicate";
import { predicateNode, sortedUnique } from "./node";

/** `path` is a JSON pointer into the predicate, e.g. "/and/1/==/0". */
export type PredicateIssue = { path: string; message: string };

type Typed = { path: string; feature: Feature } | { path: string; literal: Value };

/** Static checks against the declared features; an empty result means the predicate can be evaluated without type errors. */
export function typecheckPredicate(p: Predicate, features: readonly Feature[]): PredicateIssue[] {
  const byId = new Map<FeatureId, Feature>();
  for (const f of features) if (!byId.has(f.id)) byId.set(f.id, f); // first declaration wins
  const issues: PredicateIssue[] = [];

  const resolve = (o: Operand, path: string): Typed | undefined => {
    if (!isVarRef(o)) return { path, literal: o };
    const feature = byId.get(o.var);
    if (feature !== undefined) return { path, feature };
    issues.push({ path, message: `undeclared feature "${o.var}"` });
    return undefined;
  };

  const visit = (q: Predicate, path: string): void => {
    const node = predicateNode(q);
    const at = `${path}/${node.key}`;
    switch (node.key) {
      case "and":
      case "or":
        node.args.forEach((c, i) => visit(c, `${at}/${i}`));
        return;
      case "!":
        visit(node.args[0], `${at}/0`);
        return;
      case "in": {
        const [operand, list] = node.args;
        if (!isVarRef(operand)) {
          issues.push({ path: `${at}/0`, message: `"in" must test a feature, not a constant` });
          return;
        }
        const t = resolve(operand, `${at}/0`);
        if (t && "feature" in t) list.forEach((v, i) => checkLiteral(t.feature, v, `${at}/1/${i}`, issues));
        return;
      }
      default: {
        const [a, b] = node.args;
        if (!isVarRef(a) && !isVarRef(b)) {
          issues.push({ path: at, message: `"${node.key}" must reference at least one feature` });
          return;
        }
        const l = resolve(a, `${at}/0`);
        const r = resolve(b, `${at}/1`);
        if (l && r) checkComparison(node.key, l, r, at, issues);
      }
    }
  };

  visit(p, "");
  return issues;
}

/** Ids of all features the predicate reads, sorted and unique. */
export function featuresReferenced(p: Predicate): FeatureId[] {
  const ids: FeatureId[] = [];
  const visit = (q: Predicate): void => {
    const node = predicateNode(q);
    switch (node.key) {
      case "and":
      case "or":
      case "!":
        node.args.forEach(visit);
        return;
      case "in":
        if (isVarRef(node.args[0])) ids.push(node.args[0].var);
        return;
      default:
        for (const o of node.args) if (isVarRef(o)) ids.push(o.var);
    }
  };
  visit(p);
  return sortedUnique(ids);
}

function checkComparison(op: ComparisonOp, l: Typed, r: Typed, at: string, issues: PredicateIssue[]): void {
  if (ORDERING_OPS.includes(op)) {
    const nonNumeric = [l, r].filter((t) => valueType(t) !== "number");
    for (const t of nonNumeric) issues.push({ path: t.path, message: `"${op}" requires a numeric operand, got ${describe(t)}` });
    if (nonNumeric.length > 0) return;
  }
  if ("feature" in l && "feature" in r) {
    if (!sameDomain(l.feature, r.feature))
      issues.push({ path: at, message: `cannot compare ${describe(l)} with ${describe(r)}` });
  } else if ("feature" in l && "literal" in r) {
    checkLiteral(l.feature, r.literal, r.path, issues);
  } else if ("literal" in l && "feature" in r) {
    checkLiteral(r.feature, l.literal, l.path, issues);
  }
}

/** Checks that `value` lies in the feature's domain (type, enum membership, numeric range and integrality). */
function checkLiteral(f: Feature, value: Value, path: string, issues: PredicateIssue[]): void {
  const message = literalProblem(f, value);
  if (message !== undefined) issues.push({ path, message });
}

function literalProblem(f: Feature, value: Value): string | undefined {
  const expected = featureValueType(f);
  if (typeof value !== expected) return `expected a ${expected} for ${f.type} feature "${f.id}", got a ${typeof value}`;
  if (f.type === "enum" && typeof value === "string" && !f.values.includes(value))
    return `"${value}" is not a value of enum feature "${f.id}" (${f.values.join(", ")})`;
  if (f.type === "number" && typeof value === "number") {
    if (value < f.min || value > f.max) return `${value} is outside the range [${f.min}, ${f.max}] of "${f.id}"`;
    if (f.integer && !Number.isInteger(value)) return `${value} is not an integer, but "${f.id}" is integer-valued`;
  }
  return undefined;
}

function sameDomain(a: Feature, b: Feature): boolean {
  if (a.type !== b.type) return false;
  if (a.type !== "enum" || b.type !== "enum") return true;
  const values = new Set(a.values);
  return values.size === new Set(b.values).size && b.values.every((v) => values.has(v));
}

function featureValueType(f: Feature): "number" | "boolean" | "string" {
  return f.type === "enum" || f.type === "string" ? "string" : f.type;
}

function valueType(t: Typed): string {
  return "feature" in t ? featureValueType(t.feature) : typeof t.literal;
}

function describe(t: Typed): string {
  return "feature" in t ? `${t.feature.type} feature "${t.feature.id}"` : `a ${typeof t.literal} literal`;
}
