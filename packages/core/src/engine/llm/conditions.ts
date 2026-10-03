import { z } from "zod";
import { COMPARISON_OPS, type Predicate } from "../../schemas/predicate";
import { FeatureIdSchema } from "../../schemas/primitives";
import { comparison } from "../enumerate";

/**
 * Flat, non-recursive predicate form for LLM structured output (recursive schemas are not
 * supported by constrained decoding): a single all/any list of comparisons. Code converts it to a
 * `Predicate`; the domain type-check happens where the predicate is used (answers.ts).
 */
export const LlmConditionSchema = z.strictObject({
  feature: z.string().describe("A feature id from the domain, exactly as listed"),
  op: z.enum(COMPARISON_OPS),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("Enum values exactly as listed; numbers without units"),
});
export type LlmCondition = z.infer<typeof LlmConditionSchema>;

export const LlmConditionListSchema = z.strictObject({
  combinator: z.enum(["all", "any"]).describe("all = every condition must hold (and); any = at least one (or)"),
  conditions: z.array(LlmConditionSchema).min(1),
});
export type LlmConditionList = z.infer<typeof LlmConditionListSchema>;

export type ConversionResult = { ok: true; predicate: Predicate } | { ok: false; reasons: string[] };

/** `{combinator, conditions}` → `{and|or: [...]}` (a single condition stays bare). Structural checks only. */
export function conditionListToPredicate(list: LlmConditionList): ConversionResult {
  const reasons: string[] = [];
  const atoms: Predicate[] = [];
  list.conditions.forEach((c, i) => {
    const feature = FeatureIdSchema.safeParse(c.feature);
    if (!feature.success) reasons.push(`condition ${i}: "${c.feature}" is not a feature identifier`);
    else atoms.push(comparison(c.op, feature.data, c.value));
  });
  const [first, ...rest] = atoms;
  if (reasons.length > 0 || first === undefined) return { ok: false, reasons: reasons.length > 0 ? reasons : ["no conditions"] };
  if (rest.length === 0) return { ok: true, predicate: first };
  return { ok: true, predicate: list.combinator === "all" ? { and: [first, ...rest] } : { or: [first, ...rest] } };
}
