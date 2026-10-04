/**
 * The verified replay service (plan §10–12, P11), built by `server.ts` beside the runtime. Bundles live
 * in DATA_DIR/replays/<bundleId> (written by `pnpm replay:export --out $DATA_DIR/replays`).
 *
 * - `open` re-verifies a bundle from disk on every call (every page load): file hashes, ledger files,
 *   hash chain. A bundle that fails is refused with the reason, and its cached state is dropped, so
 *   neither views nor media are served for it any more.
 * - `views(n)` derives the server views over the first n timeline entries (derive.ts), serially per
 *   bundle, growing one scratch database forward and rebuilding it on a backward seek. At the end of the
 *   timeline it also cross-checks the derivation against the views the live server returned at export.
 * - `file` serves only paths listed in the manifest of a verified bundle, re-hashed on every read.
 */
import "server-only";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, type LedgerEntry } from "@vashistha/core";
import { ListCasesResponseSchema } from "../../contracts/casedesk";
import { DebriefStateSchema, WorkMapResponseSchema } from "../../contracts/debrief";
import type { ReplayBundleResponse, ReplayCrossCheck, ReplaySessionViews, ReplayViewsResponse } from "../../contracts/replay";
import { TutorStateSchema } from "../../contracts/tutor";
import { MANIFEST_FILE, listBundleIds, readManifest, sha256Hex, verifyBundle, type VerifiedBundle } from "../../replay/bundle";
import { BundleIdSchema, BundlePathSchema, replayMediaUrl } from "../../replay/format";
import { createDebriefStore, type DebriefStore } from "../debrief/deps";
import { createPrefix, deriveViews, type Prefix, type ReplayEngines } from "./derive";
import type { ReplayService } from "./registry";

export const REPLAYS_DIR = "replays";
/** Largest single file a guarded import accepts (recorded conversation audio is the largest kind). */
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const VIEW_CACHE = 64;

type Open = {
  bundle: VerifiedBundle;
  dir: string;
  store: DebriefStore;
  prefix: Prefix | null;
  tail: Promise<unknown>;
  views: Map<number, ReplayViewsResponse>;
};

/** Live media URLs inside derived views → the same files served from the bundle. */
export function rewriteMedia<T>(value: T, bundleId: string): T {
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) => (typeof v === "string" && v.startsWith("/api/media/") ? replayMediaUrl(bundleId, v) : v)) as T;
}

function differences(recorded: unknown, derived: unknown, paths: readonly string[]): string[] {
  const at = (v: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);
  return paths.filter((p) => canonicalJson(at(recorded, p)) !== canonicalJson(at(derived, p))).map((p) => `${p}: recorded ${canonicalJson(at(recorded, p)).slice(0, 160)} · replayed ${canonicalJson(at(derived, p)).slice(0, 160)}`);
}

const VIEW_SCHEMAS = { debrief: DebriefStateSchema, workmap: WorkMapResponseSchema, tutor: TutorStateSchema } as const;

function validViews(v: ReplaySessionViews): boolean {
  return (["debrief", "workmap", "tutor"] as const).every((k) => v[k] === null || VIEW_SCHEMAS[k].safeParse(v[k]).success);
}

const allValid = (sessions: Record<string, ReplaySessionViews>): boolean => Object.values(sessions).every(validViews);

function dropInvalid(sessions: Record<string, ReplaySessionViews>): Record<string, ReplaySessionViews> {
  return Object.fromEntries(
    Object.entries(sessions).map(([id, v]) =>
      validViews(v) ? [id, v] : [id, { debrief: null, workmap: null, tutor: null, note: "This point falls inside one recorded write; its view is not a consistent state." }],
    ),
  );
}

function sameWrite(a: LedgerEntry | undefined, b: LedgerEntry | undefined): boolean {
  return a !== undefined && b !== undefined && a.sessionId === b.sessionId && a.traceId === b.traceId;
}

/** What must agree between the server's view at export and the replay's derivation of the whole recording. */
const CHECKED = {
  debrief: ["coverage", "rulebookRevision", "gapsClosed", "debriefQuestions", "decisions", "teachBack.entryId", "teachBack.confirmedEntryId"],
  tutor: ["rulebookRevision", "rules", "cases"],
} as const;

function crossCheck(bundle: VerifiedBundle, derived: Record<string, ReplaySessionViews>): ReplayCrossCheck[] {
  const checks: ReplayCrossCheck[] = [];
  for (const s of bundle.manifest.sessions) {
    const recorded = bundle.views.get(s.id) ?? {};
    for (const view of ["debrief", "tutor"] as const) {
      const r = recorded[view];
      if (r === undefined) continue;
      const d = derived[s.id]?.[view] ?? null;
      const diff = d === null ? ["the replay could not derive this view"] : differences(rewriteMedia(r, bundle.manifest.bundleId), d, CHECKED[view]);
      checks.push({ sessionId: s.id, view, match: diff.length === 0, differences: diff });
    }
  }
  return checks;
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function createReplayService(options: { dataDir: string; engines: ReplayEngines }): ReplayService {
  const root = join(options.dataDir, REPLAYS_DIR);
  const open = new Map<string, Open>();

  function drop(bundleId: string): void {
    const o = open.get(bundleId);
    o?.prefix?.opened.close();
    open.delete(bundleId);
  }

  async function deriveAt(o: Open, n: number): Promise<Record<string, ReplaySessionViews>> {
    const { entries, manifest } = o.bundle;
    if (o.prefix === null || o.prefix.n > n) {
      o.prefix?.opened.close();
      o.prefix = createPrefix(options.engines, o.store, manifest.timeline.lastAt);
    }
    o.prefix.insert(entries.slice(o.prefix.n, n));
    return rewriteMedia(await deriveViews(o.prefix, manifest.sessions), manifest.bundleId);
  }

  async function derive(o: Open, n: number): Promise<ReplayViewsResponse> {
    const cached = o.views.get(n);
    if (cached !== undefined) return cached;
    const started = performance.now();
    const { entries } = o.bundle;
    // A position inside one recorded write (consecutive entries of one session sharing a trace id, appended
    // by one request) can be a state no live reader ever saw, e.g. an intervention before its queued
    // question. Such a state is not a valid view; the derivation then runs to the end of that write.
    let through = n;
    let sessions = await deriveAt(o, through);
    while (!allValid(sessions) && through < entries.length && sameWrite(entries[through - 1], entries[through])) {
      through += 1;
      sessions = await deriveAt(o, through);
    }
    const response: ReplayViewsResponse = {
      n,
      derivedThrough: through,
      sessions: dropInvalid(sessions),
      crossCheck: through === entries.length ? crossCheck(o.bundle, sessions) : [],
      deriveMs: Math.round(performance.now() - started),
    };
    o.views.set(n, response);
    if (o.views.size > VIEW_CACHE) o.views.delete(o.views.keys().next().value ?? n);
    return response;
  }

  return {
    async list() {
      const bundles = [];
      for (const id of await listBundleIds(root)) {
        const m = await readManifest(join(root, id));
        if (m === undefined || m.bundleId !== id) continue;
        bundles.push({
          bundleId: id,
          exportedAt: m.exportedAt,
          sourceBaseUrl: m.source.baseUrl,
          entries: m.timeline.entries,
          sessions: m.sessions.map((s) => ({ id: s.id, mode: s.mode })),
          firstAt: m.timeline.firstAt,
        });
      }
      return { bundles };
    },

    async open(bundleId) {
      if (!BundleIdSchema.safeParse(bundleId).success) return { ok: false, status: 404, code: "not_found", detail: "no such replay bundle" };
      const dir = join(root, bundleId);
      const result = await verifyBundle(dir, bundleId);
      if (!result.ok) {
        drop(bundleId);
        const absent = result.reason === "manifest.json is missing";
        return absent
          ? { ok: false, status: 404, code: "not_found", detail: "no such replay bundle" }
          : { ok: false, status: 409, code: "integrity_failed", detail: result.reason };
      }
      const { bundle } = result;
      const known = open.get(bundleId);
      if (known === undefined || known.bundle.manifestSha256 !== bundle.manifestSha256) {
        drop(bundleId);
        open.set(bundleId, { bundle, dir, store: createDebriefStore(), prefix: null, tail: Promise.resolve(), views: new Map() });
      }
      const cases: Record<string, ReplayBundleResponse["cases"][string]> = {};
      for (const [sessionId, body] of bundle.cases) cases[sessionId] = ListCasesResponseSchema.parse(body).cases;
      const body: ReplayBundleResponse = {
        manifest: bundle.manifest,
        manifestSha256: bundle.manifestSha256,
        verification: {
          ok: true,
          verifiedAt: Date.now(),
          files: Object.keys(bundle.manifest.files).length,
          entries: bundle.entries.length,
          externalParents: bundle.externalParents,
        },
        entries: bundle.entries satisfies LedgerEntry[],
        cases,
      };
      return { ok: true, body };
    },

    views(bundleId, n) {
      const o = open.get(bundleId);
      if (o === undefined) return Promise.resolve(null);
      const target = Math.max(0, Math.min(n, o.bundle.entries.length));
      // One derivation at a time per bundle: they share the scratch database.
      const run = o.tail.then(() => derive(o, target));
      o.tail = run.catch(() => undefined);
      return run;
    },

    async stage(bundleId, path, bytes) {
      if (!BundleIdSchema.safeParse(bundleId).success) return { ok: false, status: 400, code: "invalid_bundle_id", detail: "not a bundle id" };
      if (path !== MANIFEST_FILE && !BundlePathSchema.safeParse(path).success) return { ok: false, status: 400, code: "invalid_path", detail: "not a bundle path" };
      if (bytes.byteLength > IMPORT_MAX_BYTES) return { ok: false, status: 400, code: "too_large", detail: `files are limited to ${IMPORT_MAX_BYTES} bytes` };
      if (await present(join(root, bundleId))) return { ok: false, status: 409, code: "exists", detail: "bundles are immutable; this one is already here" };
      const target = join(root, `.incoming-${bundleId}`, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { ok: true, detail: `staged ${path}` };
    },

    async commit(bundleId) {
      if (!BundleIdSchema.safeParse(bundleId).success) return { ok: false, status: 400, code: "invalid_bundle_id", detail: "not a bundle id" };
      const final = join(root, bundleId);
      if (await present(final)) return { ok: false, status: 409, code: "exists", detail: "bundles are immutable; this one is already here" };
      const staging = join(root, `.incoming-${bundleId}`);
      const verified = await verifyBundle(staging, bundleId);
      if (!verified.ok) {
        await rm(staging, { recursive: true, force: true });
        return { ok: false, status: 422, code: "integrity_failed", detail: verified.reason };
      }
      await rename(staging, final);
      return { ok: true, detail: `imported ${bundleId}: ${verified.bundle.entries.length} entries, chain ${verified.bundle.manifest.timeline.head.slice(0, 12)}` };
    },

    async file(bundleId, path) {
      const o = open.get(bundleId);
      if (o === undefined || !BundlePathSchema.safeParse(path).success) return null;
      const listed = o.bundle.manifest.files[path];
      if (listed === undefined) return null;
      let bytes: Buffer;
      try {
        bytes = await readFile(join(o.dir, path));
      } catch {
        return null;
      }
      if (sha256Hex(bytes) !== listed.sha256) {
        drop(bundleId);
        return null;
      }
      return new Uint8Array(bytes);
    },
  };
}
