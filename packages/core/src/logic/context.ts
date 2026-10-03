import type { DecisionContext } from "../schemas/context";
import type { Feature } from "../schemas/domain";
import { unknown, type FeatureId } from "../schemas/primitives";
import type { FeatureLookup } from "./evaluate";

/**
 * Reads "case" features from `ctx.case` and "derived" features from `ctx.history.derived`.
 * A value absent from the context is `unknown("not_extracted")`; an undeclared feature id throws.
 */
export function contextLookup(ctx: DecisionContext, features: readonly Feature[]): FeatureLookup {
  const sources = new Map<FeatureId, Feature["source"]>(features.map((f) => [f.id, f.source]));
  return (id) => {
    const source = sources.get(id);
    if (source === undefined) throw new Error(`feature "${id}" is not declared in the domain`);
    const values = source === "case" ? ctx.case : ctx.history.derived;
    const value = Object.hasOwn(values, id) ? values[id] : undefined;
    return value ?? unknown("not_extracted");
  };
}
