import { z } from "zod";
import { ActionIdSchema, EpochMsSchema, FeatureIdSchema, IdSchema, ValueSchema } from "./primitives";

export const ActivitySignalSchema = z.strictObject({
  kind: z.enum(["typing", "pointer", "focus_change", "screen_motion", "idle"]),
  t: EpochMsSchema,
  value: z.number().optional(),
});
export type ActivitySignal = z.infer<typeof ActivitySignalSchema>;

/**
 * Voice-side gate inputs. `vad` (provider VAD score), `user_speaking` (explicit channel),
 * `local_speech` (the browser's own microphone-level detector, value 0 = silent) and `agent_speaking`
 * are levels; `tentative_transcript` (provider ASR in progress) and `user_transcript` (the provider's
 * final transcript of a user turn) are point events: evidence that the expert spoke, the final one
 * also closing their turn; `turn_end` = the user's turn ended.
 */
export const VoiceSignalSchema = z.strictObject({
  kind: z.enum(["vad", "user_speaking", "local_speech", "tentative_transcript", "user_transcript", "agent_speaking", "turn_end"]),
  t: EpochMsSchema,
  value: z.number().optional(),
});
export type VoiceSignal = z.infer<typeof VoiceSignalSchema>;

/** Semantic screen event, produced by vision (or by the CaseDesk DOM channel, labelled `source: "dom"`). */
export const ScreenEventSchema = z
  .strictObject({
    id: IdSchema,
    frameSeq: z.int().nonnegative(),
    captureTime: EpochMsSchema,
    sessionEpoch: z.int().nonnegative(),
    kind: z.enum(["open_case", "field_change", "action", "navigate"]),
    caseId: z.string().min(1).optional(),
    field: FeatureIdSchema.optional(),
    from: ValueSchema.optional(),
    to: ValueSchema.optional(),
    action: ActionIdSchema.optional(),
    confidence: z.number().min(0).max(1),
    source: z.enum(["vision", "dom"]),
    critical: z.boolean(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "open_case" && e.caseId === undefined) ctx.addIssue({ code: "custom", message: "open_case requires caseId" });
    if (e.kind === "field_change" && (e.field === undefined || e.to === undefined))
      ctx.addIssue({ code: "custom", message: "field_change requires field and to" });
    if (e.kind === "action" && e.action === undefined) ctx.addIssue({ code: "custom", message: "action requires action" });
  });
export type ScreenEvent = z.infer<typeof ScreenEventSchema>;
