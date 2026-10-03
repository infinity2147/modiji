import { z } from "zod";

/**
 * Identifiers used as JSON-Logic `var` names and Z3 symbol names.
 * No dots: JSON-Logic treats dots as path separators.
 */
export const SymbolIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "must be an identifier: letter, then letters/digits/_ (max 64)");

export const FeatureIdSchema = SymbolIdSchema.brand<"FeatureId">();
export type FeatureId = z.infer<typeof FeatureIdSchema>;

export const ActionIdSchema = SymbolIdSchema.brand<"ActionId">();
export type ActionId = z.infer<typeof ActionIdSchema>;

/** Opaque record identifier (ledger entries, rules, frames, utterances, …). */
export const IdSchema = z.string().min(1).max(128);

/** Epoch milliseconds. */
export const EpochMsSchema = z.int().nonnegative();

export const ValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type Value = z.infer<typeof ValueSchema>;

export const UnknownReasonSchema = z.enum(["not_visible", "not_extracted", "backfill_failed", "off_record"]);
export type UnknownReason = z.infer<typeof UnknownReasonSchema>;

export const UnknownSchema = z.strictObject({ unknown: z.literal(true), reason: UnknownReasonSchema });
export type Unknown = z.infer<typeof UnknownSchema>;

export const FeatureValueSchema = z.union([ValueSchema, UnknownSchema]);
export type FeatureValue = z.infer<typeof FeatureValueSchema>;

export function isUnknown(v: FeatureValue): v is Unknown {
  return typeof v === "object" && v !== null && v.unknown === true;
}

export function unknown(reason: UnknownReason): Unknown {
  return { unknown: true, reason };
}

export const SchemaVersionSchema = z.int().min(1);
