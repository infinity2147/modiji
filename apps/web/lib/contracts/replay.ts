/**
 * HTTP contract of the verified replay mode (plan §10–12, P11). Browser-safe. Every route is a read:
 * nothing in replay mode writes to a ledger or calls a model or voice service.
 *
 * - GET /api/replays                         bundles in DATA_DIR/replays (manifest facts; not re-verified)
 * - GET /api/replays/:bundleId               re-verifies the bundle, then returns it (409 integrity_failed + reason otherwise)
 * - GET /api/replays/:bundleId/views?n=      server views derived from the first n timeline entries
 * - GET /api/replays/:bundleId/media/…       a listed, re-hashed bundle file (frames, audio)
 */
import { z } from "zod";
import { IdSchema, LedgerEntrySchema } from "@vashistha/core";
import { KycCaseSchema } from "@vashistha/core/domains/kyc";
import { ReplayManifestSchema } from "../replay/format";
import { DebriefStateSchema, WorkMapResponseSchema } from "./debrief";
import { TutorStateSchema } from "./tutor";

export const ReplayListResponseSchema = z.strictObject({
  bundles: z.array(
    z.strictObject({
      bundleId: z.string(),
      exportedAt: z.number(),
      sourceBaseUrl: z.string(),
      entries: z.int().nonnegative(),
      sessions: z.array(z.strictObject({ id: IdSchema, mode: z.enum(["expert", "novice"]) })),
      firstAt: z.number(),
    }),
  ),
});
export type ReplayListResponse = z.infer<typeof ReplayListResponseSchema>;

export const ReplayBundleResponseSchema = z.strictObject({
  manifest: ReplayManifestSchema,
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  verification: z.strictObject({
    ok: z.literal(true),
    /** When this server re-verified the bundle (this request). */
    verifiedAt: z.number(),
    files: z.int().nonnegative(),
    entries: z.int().nonnegative(),
    /** Parent links that point outside the bundled sessions (recorded, not followed). */
    externalParents: z.int().nonnegative(),
  }),
  /** Every entry of every bundled session, in timeline order. */
  entries: z.array(LedgerEntrySchema),
  /** The cases each session's CaseDesk listed, as recorded at export. */
  cases: z.record(IdSchema, z.array(KycCaseSchema)),
});
export type ReplayBundleResponse = z.infer<typeof ReplayBundleResponseSchema>;

export const ReplayViewsQuerySchema = z.strictObject({ n: z.string().regex(/^\d{1,9}$/).transform(Number) });

export const ReplaySessionViewsSchema = z.strictObject({
  debrief: DebriefStateSchema.nullable(),
  workmap: WorkMapResponseSchema.nullable(),
  tutor: TutorStateSchema.nullable(),
  /** Why a view is absent (e.g. the session had not started at this point of the recording). */
  note: z.string().nullable(),
});
export type ReplaySessionViews = z.infer<typeof ReplaySessionViewsSchema>;

/** End-of-recording cross-check: the replay's derivation against the server's own view captured at export. */
export const ReplayCrossCheckSchema = z.strictObject({
  sessionId: IdSchema,
  view: z.enum(["debrief", "tutor"]),
  match: z.boolean(),
  differences: z.array(z.string()),
});
export type ReplayCrossCheck = z.infer<typeof ReplayCrossCheckSchema>;

export const ReplayViewsResponseSchema = z.strictObject({
  n: z.int().nonnegative(),
  /**
   * The entries the views are derived from: n, or the end of the recorded write entry n belongs to when the
   * state after n alone is not a consistent view (several entries appended by one request).
   */
  derivedThrough: z.int().nonnegative(),
  sessions: z.record(IdSchema, ReplaySessionViewsSchema),
  /** Only at the end of the recording (n = all entries); empty when no view was recorded at export. */
  crossCheck: z.array(ReplayCrossCheckSchema),
  deriveMs: z.number(),
});
export type ReplayViewsResponse = z.infer<typeof ReplayViewsResponseSchema>;
