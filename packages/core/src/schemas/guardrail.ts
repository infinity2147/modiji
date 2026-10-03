import { z } from "zod";
import { FeatureIdSchema, IdSchema } from "./primitives";
import { ExpertQuoteEvidenceSchema } from "./rules";

/** Kleene three-valued truth. */
export type Truth = true | false | "unknown";
export const TruthSchema = z.union([z.boolean(), z.literal("unknown")]);

export const GuardrailDecisionSchema = z.enum(["allow", "forbid", "needs_approval", "insufficient_information"]);
export type GuardrailDecision = z.infer<typeof GuardrailDecisionSchema>;

export const GuardrailResultSchema = z.strictObject({
  decision: GuardrailDecisionSchema,
  matchedRules: z.array(IdSchema),
  missingFeatures: z.array(FeatureIdSchema),
  evidence: z.array(ExpertQuoteEvidenceSchema),
});
export type GuardrailResult = z.infer<typeof GuardrailResultSchema>;
