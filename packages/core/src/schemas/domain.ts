import { z } from "zod";
import { ActionIdSchema, FeatureIdSchema, SymbolIdSchema } from "./primitives";
import { PredicateSchema } from "./predicate";

/**
 * Raw shape of a domain config (plan §6.2). Cross-reference and predicate type checks
 * live in `parseDomainConfig`; always load configs through it.
 *
 * Feature `source`: "case" values are read from DecisionContext.case; "derived" values from
 * DecisionContext.history.derived (computed by domain code from workflow/history/actor/environment).
 */
export const FeatureSourceSchema = z.enum(["case", "derived"]);

const featureBase = {
  id: FeatureIdSchema,
  label: z.string().min(1),
  description: z.string().optional(),
  source: FeatureSourceSchema,
};

export const NumberFeatureSchema = z.strictObject({
  ...featureBase,
  type: z.literal("number"),
  min: z.number(),
  max: z.number(),
  integer: z.boolean().default(false),
  unit: z.string().optional(),
});
export const BooleanFeatureSchema = z.strictObject({ ...featureBase, type: z.literal("boolean") });
export const EnumFeatureSchema = z.strictObject({
  ...featureBase,
  type: z.literal("enum"),
  values: z.array(z.string().min(1)).min(1),
});
/** Free text (e.g. names). Only ==, != and `in` apply. */
export const StringFeatureSchema = z.strictObject({ ...featureBase, type: z.literal("string") });

export const FeatureSchema = z.discriminatedUnion("type", [
  NumberFeatureSchema,
  BooleanFeatureSchema,
  EnumFeatureSchema,
  StringFeatureSchema,
]);
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureType = Feature["type"];

export const ActionParamSchema = z.strictObject({
  id: SymbolIdSchema,
  label: z.string().min(1),
  type: z.enum(["string", "enum"]),
  values: z.array(z.string().min(1)).min(1).optional(),
  required: z.boolean().default(true),
});
export type ActionParam = z.infer<typeof ActionParamSchema>;

export const ActionDefSchema = z.strictObject({
  id: ActionIdSchema,
  label: z.string().min(1),
  terminal: z.boolean(),
  params: z.array(ActionParamSchema).optional(),
});
export type ActionDef = z.infer<typeof ActionDefSchema>;

export const DecisionFamilySchema = z.strictObject({
  id: SymbolIdSchema,
  label: z.string().min(1),
  actions: z.array(ActionIdSchema).min(1),
});
export type DecisionFamily = z.infer<typeof DecisionFamilySchema>;

export const DomainConfigSchema = z.strictObject({
  id: SymbolIdSchema,
  title: z.string().min(1),
  features: z.array(FeatureSchema).min(1),
  actions: z.array(ActionDefSchema).min(1),
  decisionFamilies: z.array(DecisionFamilySchema).min(1),
  domainConstraints: z.array(PredicateSchema),
  criticalFields: z.array(FeatureIdSchema),
});
export type DomainConfig = z.infer<typeof DomainConfigSchema>;
export type DomainConfigInput = z.input<typeof DomainConfigSchema>;
