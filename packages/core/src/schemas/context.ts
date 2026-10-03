import { z } from "zod";
import { ActionIdSchema, FeatureIdSchema, FeatureValueSchema, SchemaVersionSchema } from "./primitives";

const FeatureMapSchema = z.record(FeatureIdSchema, FeatureValueSchema);

export const DecisionContextSchema = z.strictObject({
  case: FeatureMapSchema,
  workflow: z.strictObject({
    stepId: z.string().optional(),
    priorActions: z.array(ActionIdSchema),
    reviewerHistory: z.array(z.unknown()).optional(),
  }),
  history: z.strictObject({ derived: FeatureMapSchema }),
  actor: z.strictObject({ role: z.string().min(1), id: z.string().min(1) }),
  environment: z.strictObject({ date: z.iso.date(), periodEnd: z.boolean().optional() }),
  schemaVersion: SchemaVersionSchema,
});
export type DecisionContext = z.infer<typeof DecisionContextSchema>;
