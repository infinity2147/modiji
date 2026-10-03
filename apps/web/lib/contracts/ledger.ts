/**
 * HTTP contract for reading a session's ledger (judge-view event ticker, lineage trace). Entries of
 * every source are returned, each labelled with its `source`: a `system_control` entry is never
 * evidence, and clients must filter on `source` rather than infer it. Browser-safe.
 */
import { z } from "zod";
import { LedgerEntrySchema } from "@vashistha/core";

export const LEDGER_PAGE_MAX = 500;
export const LEDGER_PAGE_DEFAULT = 100;

const DecimalIntSchema = z.string().regex(/^\d{1,15}$/, "must be a non-negative decimal integer").transform(Number);

/** GET /api/sessions/:sessionId/ledger?after=<sequence>&limit=<n> — entries with sequence > after (all when absent), oldest first. */
export const LedgerPageQuerySchema = z.strictObject({
  after: DecimalIntSchema.optional(),
  limit: DecimalIntSchema.pipe(z.int().min(1).max(LEDGER_PAGE_MAX)).default(LEDGER_PAGE_DEFAULT),
});

export const LedgerPageResponseSchema = z.strictObject({ entries: z.array(LedgerEntrySchema) });
