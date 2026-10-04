/**
 * Verified replay (plan §10–12, P11): the format of a RUN BUNDLE — an immutable snapshot of a genuine
 * recorded run, fetched from a live server through its public read APIs (`pnpm replay:export`).
 * Browser-safe: schemas and ordering only; hashing and file access live in `bundle.ts` (Node).
 *
 * Layout of `<DATA_DIR>/replays/<bundleId>/`:
 *
 *   manifest.json                       this schema (the only file not listed in `files`)
 *   ledger/<sessionId>.json             { sessionId, entries } — every entry of the session, as GET /ledger returned it
 *   cases/<sessionId>.json              GET /api/cases?set=&session= at export (the cases the UI listed)
 *   views/<sessionId>.<view>.json       read-only server views at export (debrief | tutor), for the end-of-run cross-check
 *   media/<sessionId>/frames/<id>.png   redacted frames referenced by `frame.received` entries
 *   audio/<conversationId>.mp3          recorded conversation audio, only when the provider still had it (never synthesised)
 *
 * Integrity: `files` holds the sha256 and size of every other file; `timeline.head` is the last link of
 * a hash chain over all entries in timeline order, link_i = sha256(link_{i-1} ‖ canonicalJson(entry_i))
 * with link_0 = sha256("vashistha.replay/1") and links as lower-case hex (UTF-8 concatenation). The
 * bundle id ends in the first 12 hex digits of the head, so an id names exactly one recorded history.
 */
import { z } from "zod";
import { EpochMsSchema, IdSchema, type LedgerEntry } from "@vashistha/core";

export const REPLAY_FORMAT = "vashistha.replay/1";
export const CHAIN_LINK = "sha256(prev ‖ canonicalJson(entry))";
/** Timeline order: the order the server received entries (the same order the rulebook folds rule events in). */
export const TIMELINE_ORDER = ["receivedAt", "sessionId", "sequence"] as const;

/** `<yyyymmdd>-<hhmm>-<12 hex of the chain head>` (UTC time of the first recorded entry). */
export const BundleIdSchema = z.string().regex(/^\d{8}-\d{4}-[0-9a-f]{12}$/, "bundle id: yyyymmdd-hhmm-<12 hex>");
export type BundleId = z.infer<typeof BundleIdSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");

/** Paths a bundle may contain (relative, no traversal, one shape per kind). */
export const BundlePathSchema = z
  .string()
  .regex(
    /^(?:ledger\/[0-9a-f-]{36}\.json|cases\/[0-9a-f-]{36}\.json|views\/[0-9a-f-]{36}\.(?:debrief|tutor)\.json|media\/[0-9a-f-]{36}\/frames\/[0-9a-f-]{36}\.png|audio\/[A-Za-z0-9_-]{1,128}\.mp3)$/,
    "not a bundle path",
  );

export const BundleSessionSchema = z.strictObject({
  id: IdSchema,
  mode: z.enum(["expert", "novice"]),
  caseSet: z.string().min(1),
  /** The expert named at session start (P10), when the session recorded one. */
  expert: z.looseObject({ id: z.string(), name: z.string().optional() }).optional(),
  entries: z.int().nonnegative(),
  firstReceivedAt: EpochMsSchema,
  lastReceivedAt: EpochMsSchema,
  /** ElevenLabs conversation ids seen in this session's utterances. */
  conversationIds: z.array(z.string().min(1)),
});
export type BundleSession = z.infer<typeof BundleSessionSchema>;

export const ReplayManifestSchema = z.strictObject({
  format: z.literal(REPLAY_FORMAT),
  bundleId: BundleIdSchema,
  /** Always shown with the replay: this is a recording, not a live run. */
  label: z.literal("verified-replay"),
  exportedAt: EpochMsSchema,
  source: z.strictObject({
    baseUrl: z.string().url(),
    /** From GET /api/health at export time. */
    version: z.string().min(1),
    commit: z.string().min(1).nullable(),
  }),
  exporter: z.strictObject({ tool: z.string().min(1), gitCommit: z.string().nullable() }),
  sessions: z.array(BundleSessionSchema).min(1),
  timeline: z.strictObject({
    order: z.tuple([z.literal("receivedAt"), z.literal("sessionId"), z.literal("sequence")]),
    link: z.literal(CHAIN_LINK),
    entries: z.int().positive(),
    firstAt: EpochMsSchema,
    lastAt: EpochMsSchema,
    genesis: Sha256Schema,
    head: Sha256Schema,
  }),
  files: z.record(BundlePathSchema, z.strictObject({ sha256: Sha256Schema, bytes: z.int().nonnegative() })),
  /** Referenced media the export could not include, and why (stated, never filled in). */
  missing: z.array(z.strictObject({ ref: z.string().min(1), reason: z.string().min(1) })),
});
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

export const BundleLedgerFileSchema = z.strictObject({ sessionId: IdSchema, entries: z.array(z.unknown()) });

/** Timeline comparator (see TIMELINE_ORDER). */
export function compareTimeline(a: LedgerEntry, b: LedgerEntry): number {
  return a.receivedAt - b.receivedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || a.sequence - b.sequence;
}

export const ledgerPath = (sessionId: string): string => `ledger/${sessionId}.json`;
export const casesPath = (sessionId: string): string => `cases/${sessionId}.json`;
export const viewPath = (sessionId: string, view: "debrief" | "tutor"): string => `views/${sessionId}.${view}.json`;
export const framePath = (sessionId: string, frameId: string): string => `media/${sessionId}/frames/${frameId}.png`;
export const audioPath = (conversationId: string): string => `audio/${conversationId}.mp3`;

/** `/api/media/<sid>/frames/<id>.png` (live) → the same frame served from the bundle. */
export function replayMediaUrl(bundleId: string, liveUrl: string): string {
  return liveUrl.replace(/^\/api\/media\//, `/api/replays/${encodeURIComponent(bundleId)}/media/`);
}
