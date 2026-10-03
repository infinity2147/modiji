import { z } from "zod";
import { FeatureIdSchema, ValueSchema, type FeatureId, type Value } from "./primitives";

/**
 * JSON-Logic-compatible predicate subset (plan §6.5).
 *
 * Operators: == != < <= > >= in and or !, operand `{var}`.
 * Only the canonical forms below are accepted, so every predicate is also valid JSON-Logic
 * and evaluates identically under json-logic-js whenever all referenced features are known.
 * Negation uses JSON-Logic's `!` token, always in array form: `{"!": [p]}`.
 * Three-valued (Kleene) semantics are provided by our own evaluator, not json-logic-js.
 */
export type VarRef = { var: FeatureId };
export type Operand = VarRef | Value;

export type Comparison =
  | { "==": [Operand, Operand] }
  | { "!=": [Operand, Operand] }
  | { "<": [Operand, Operand] }
  | { "<=": [Operand, Operand] }
  | { ">": [Operand, Operand] }
  | { ">=": [Operand, Operand] };

export type Membership = { in: [Operand, [Value, ...Value[]]] };

export type Predicate =
  | Comparison
  | Membership
  | { and: [Predicate, ...Predicate[]] }
  | { or: [Predicate, ...Predicate[]] }
  | { "!": [Predicate] };

export const COMPARISON_OPS = ["==", "!=", "<", "<=", ">", ">="] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];
export const ORDERING_OPS: readonly ComparisonOp[] = ["<", "<=", ">", ">="];

export const VarRefSchema = z.strictObject({ var: FeatureIdSchema });
export const OperandSchema = z.union([VarRefSchema, ValueSchema]);
const pair = z.tuple([OperandSchema, OperandSchema]);

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({ "==": pair }),
    z.strictObject({ "!=": pair }),
    z.strictObject({ "<": pair }),
    z.strictObject({ "<=": pair }),
    z.strictObject({ ">": pair }),
    z.strictObject({ ">=": pair }),
    z.strictObject({ in: z.tuple([OperandSchema, z.tuple([ValueSchema], ValueSchema)]) }),
    z.strictObject({ and: z.tuple([PredicateSchema], PredicateSchema) }),
    z.strictObject({ or: z.tuple([PredicateSchema], PredicateSchema) }),
    z.strictObject({ "!": z.tuple([PredicateSchema]) }),
  ]),
);

export function isVarRef(o: Operand): o is VarRef {
  return typeof o === "object" && o !== null && "var" in o;
}
