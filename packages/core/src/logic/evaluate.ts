import type { Truth } from "../schemas/guardrail";
import { isUnknown, type FeatureId, type FeatureValue, type Value } from "../schemas/primitives";
import { isVarRef, type ComparisonOp, type Operand, type Predicate } from "../schemas/predicate";
import { and, not, or } from "./kleene";
import { predicateNode, sortedUnique } from "./node";

export type FeatureLookup = (id: FeatureId) => FeatureValue;

/**
 * `unknownFeatures` lists the features whose unknown-ness the result depends on: empty when
 * `truth` is boolean, otherwise the union over the unknown children that kept it unknown.
 * Supplying all of them always yields a boolean result.
 */
export type Evaluation = { truth: Truth; unknownFeatures: FeatureId[] };

/** A runtime type mismatch that `typecheckPredicate` should have rejected. `path` is a JSON pointer into the predicate. */
export class PredicateEvaluationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message} (at ${path})`);
    this.name = "PredicateEvaluationError";
    this.path = path;
  }
}

/**
 * Three-valued (strong Kleene) evaluation of a predicate. Every node is evaluated (no
 * short-circuit), so a type mismatch throws regardless of sibling values.
 */
export function evaluatePredicate(p: Predicate, lookup: FeatureLookup): Evaluation {
  const { truth, unknownFeatures } = evaluateAt(p, lookup, "");
  return { truth, unknownFeatures: sortedUnique(unknownFeatures) };
}

function evaluateAt(p: Predicate, lookup: FeatureLookup, path: string): Evaluation {
  const node = predicateNode(p);
  const at = `${path}/${node.key}`;
  switch (node.key) {
    case "and":
    case "or": {
      const children = node.args.map((c, i) => evaluateAt(c, lookup, `${at}/${i}`));
      const truth = (node.key === "and" ? and : or)(...children.map((c) => c.truth));
      // Boolean children carry no unknown features, so the union is over the unknown ones.
      return { truth, unknownFeatures: truth === "unknown" ? children.flatMap((c) => c.unknownFeatures) : [] };
    }
    case "!": {
      const child = evaluateAt(node.args[0], lookup, `${at}/0`);
      return { truth: not(child.truth), unknownFeatures: child.unknownFeatures };
    }
    case "in": {
      const [operand, list] = node.args;
      const value = operandValue(operand, lookup);
      if (isUnknown(value)) return { truth: "unknown", unknownFeatures: unknownVar(operand, value) };
      list.forEach((item, i) => {
        if (typeof item !== typeof value)
          throw new PredicateEvaluationError(`${at}/1/${i}`, `"in" list element is a ${typeof item}, operand is a ${typeof value}`);
      });
      return { truth: list.some((item) => item === value), unknownFeatures: [] };
    }
    default: {
      const [left, right] = node.args;
      const l = operandValue(left, lookup);
      const r = operandValue(right, lookup);
      if (isUnknown(l) || isUnknown(r))
        return { truth: "unknown", unknownFeatures: [...unknownVar(left, l), ...unknownVar(right, r)] };
      return { truth: compare(node.key, l, r, at), unknownFeatures: [] };
    }
  }
}

function operandValue(o: Operand, lookup: FeatureLookup): FeatureValue {
  return isVarRef(o) ? lookup(o.var) : o;
}

function unknownVar(o: Operand, v: FeatureValue): FeatureId[] {
  return isVarRef(o) && isUnknown(v) ? [o.var] : [];
}

function compare(op: ComparisonOp, a: Value, b: Value, at: string): boolean {
  if (op === "==" || op === "!=") {
    if (typeof a !== typeof b) throw new PredicateEvaluationError(at, `"${op}" between a ${typeof a} and a ${typeof b}`);
    return op === "==" ? a === b : a !== b;
  }
  const x = requireNumber(a, op, `${at}/0`);
  const y = requireNumber(b, op, `${at}/1`);
  switch (op) {
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
  }
}

function requireNumber(v: Value, op: ComparisonOp, path: string): number {
  if (typeof v !== "number") throw new PredicateEvaluationError(path, `"${op}" requires numbers, got a ${typeof v}`);
  return v;
}
