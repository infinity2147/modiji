/**
 * Every interview ledger write goes through `entry()`: kind, source and payload are validated against
 * the ledger kind registry (`parseLedgerPayload`) before anything is appended, so a writer bug fails
 * loudly here instead of producing an entry the ticker, Work Map or lineage cannot read.
 */
import "server-only";
import type { z } from "zod";
import { parseLedgerPayload, type LEDGER_KINDS, type LedgerKind, type LedgerSource, type NewLedgerEntry } from "@vashistha/core";

/** Schema version of every payload the interview layer writes. */
export const INTERVIEW_PAYLOAD_SCHEMA_VERSION = 1;

export type PayloadInput<K extends LedgerKind> = z.input<(typeof LEDGER_KINDS)[K]["payload"]>;

/** Where and when: shared by every entry one request (or one engine step) writes. */
export type EntryContext = { sessionId: string; occurredAt: number; traceId: string; privacyEpoch: number };

export function entry<K extends LedgerKind>(
  ctx: EntryContext,
  kind: K,
  source: LedgerSource,
  parentIds: readonly string[],
  payload: PayloadInput<K>,
): NewLedgerEntry {
  return {
    ...ctx,
    kind,
    source,
    parentIds: [...parentIds],
    schemaVersion: INTERVIEW_PAYLOAD_SCHEMA_VERSION,
    payload: parseLedgerPayload({ kind, source, payload }, kind),
  };
}
