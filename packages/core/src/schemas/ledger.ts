import { z } from "zod";
import { EpochMsSchema, IdSchema, SchemaVersionSchema } from "./primitives";

export const LEDGER_SOURCES = ["client", "vision", "dom", "voice", "engine", "solver", "expert", "system_control"] as const;
export const LedgerSourceSchema = z.enum(LEDGER_SOURCES);
export type LedgerSource = z.infer<typeof LedgerSourceSchema>;

/** Sources that capture what happened on the expert's screen or microphone; subject to the privacy epoch. */
export const CAPTURE_SOURCES: readonly LedgerSource[] = ["client", "vision", "dom", "voice"];

/** Dotted lower-case kind, e.g. "frame.received", "question.asked". */
export const LedgerKindSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/, "dotted lower-case kind");

/** An entry as submitted for appending; the store assigns id, sequence and receivedAt. */
export const NewLedgerEntrySchema = z.strictObject({
  sessionId: IdSchema,
  source: LedgerSourceSchema,
  kind: LedgerKindSchema,
  occurredAt: EpochMsSchema,
  traceId: IdSchema,
  parentIds: z.array(IdSchema),
  schemaVersion: SchemaVersionSchema,
  privacyEpoch: z.int().nonnegative(),
  payload: z.unknown(),
});
export type NewLedgerEntry = z.infer<typeof NewLedgerEntrySchema>;

export const LedgerEntrySchema = NewLedgerEntrySchema.extend({
  id: IdSchema,
  sequence: z.int().nonnegative(),
  receivedAt: EpochMsSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** `system_control` traffic (e.g. gate control messages) never becomes evidence. */
export function isEvidenceEligible(entry: Pick<LedgerEntry, "source">): boolean {
  return entry.source !== "system_control";
}
