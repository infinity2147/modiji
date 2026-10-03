import { z } from "zod";
import { FeatureSchema, PredicateSchema, unknown, type Feature, type FeatureLookup, type FeatureValue, type Predicate, type Truth } from "../src";

/** Parses (and so validates) a predicate written as a plain literal. */
export const pred = (p: unknown): Predicate => PredicateSchema.parse(p);

export const features = (fs: unknown[]): Feature[] => z.array(FeatureSchema).parse(fs);

/** Lookup over a plain record; reading an absent id is a test bug, so it throws. */
export function lookupFrom(values: Readonly<Record<string, FeatureValue>>): FeatureLookup {
  return (id) => {
    const v = values[id];
    if (v === undefined) throw new Error(`test lookup: no value for ${id}`);
    return v;
  };
}

export const TRUTHS: readonly Truth[] = [true, false, "unknown"];

/** A feature value that makes the leaf `{"==": [{var}, true]}` evaluate to `t`. */
export const forcing = (t: Truth): FeatureValue => (t === "unknown" ? unknown("not_visible") : t);

export const leaf = (id: string): Predicate => pred({ "==": [{ var: id }, true] });
