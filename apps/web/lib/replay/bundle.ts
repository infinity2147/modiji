/**
 * Run bundles on disk (Node only; see format.ts for the layout and the integrity scheme). Used by the
 * export script, the replay service and the tests — one implementation, so writer and verifier agree.
 *
 * `writeBundle` writes into a temporary directory and renames it into place: a bundle directory is
 * either complete or absent, and an existing bundle is never overwritten (bundles are immutable).
 * `verifyBundle` re-hashes every listed file, re-derives the hash chain and checks the ledger files
 * entry by entry; any mismatch refuses the whole bundle with the reason.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RULE_EVENT_KINDS, canonicalJson, LedgerEntrySchema, rulebookFromLedger, type LedgerEntry } from "@vashistha/core";
import {
  BundleIdSchema,
  BundleLedgerFileSchema,
  BundlePathSchema,
  CHAIN_LINK,
  REPLAY_FORMAT,
  ReplayManifestSchema,
  TIMELINE_ORDER,
  casesPath,
  compareTimeline,
  ledgerPath,
  type BundleSession,
  type ReplayManifest,
} from "./format";

export const MANIFEST_FILE = "manifest.json";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const CHAIN_GENESIS = sha256Hex(REPLAY_FORMAT);

/** Every link of the chain over `entries` (already in timeline order). */
export function chainLinks(entries: readonly unknown[]): string[] {
  let prev = CHAIN_GENESIS;
  return entries.map((entry) => (prev = sha256Hex(prev + canonicalJson(entry))));
}

export function chainHead(entries: readonly unknown[]): string {
  return chainLinks(entries).at(-1) ?? CHAIN_GENESIS;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function bundleIdFor(firstAt: number, head: string): string {
  const d = new Date(firstAt);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${head.slice(0, 12)}`;
}

export type BundleInput = {
  exportedAt: number;
  source: ReplayManifest["source"];
  exporter: ReplayManifest["exporter"];
  /** Per session: every ledger entry (sequence order, as the API returned them), the cases response, recorded views. */
  sessions: { entries: readonly LedgerEntry[]; cases: unknown; views: Partial<Record<"debrief" | "tutor", unknown>> }[];
  /** Further files (frames, audio) at their bundle paths. */
  files: { path: string; bytes: Uint8Array }[];
  missing: ReplayManifest["missing"];
};

function sessionMeta(entries: readonly LedgerEntry[]): BundleSession {
  const first = entries[0];
  const last = entries.at(-1);
  if (first === undefined || last === undefined) throw new Error("a bundled session needs at least one entry");
  const started = entries.find((e) => e.kind === "session.started" && e.source === "engine");
  const payload = started?.payload as { mode?: unknown; caseSet?: unknown; expert?: unknown } | null | undefined;
  if (started === undefined || (payload?.mode !== "expert" && payload?.mode !== "novice") || typeof payload.caseSet !== "string")
    throw new Error(`session ${first.sessionId} is not a CaseDesk session (no session.started entry)`);
  const conversationIds = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "utterance.transcript" && e.kind !== "agent.utterance") continue;
    const id = (e.payload as { conversationId?: unknown } | null)?.conversationId;
    if (typeof id === "string" && id !== "") conversationIds.add(id);
  }
  const expert = payload.expert as BundleSession["expert"] | undefined;
  return {
    id: first.sessionId,
    mode: payload.mode,
    caseSet: payload.caseSet,
    ...(expert !== undefined && { expert }),
    entries: entries.length,
    firstReceivedAt: Math.min(...entries.map((e) => e.receivedAt)),
    lastReceivedAt: Math.max(...entries.map((e) => e.receivedAt)),
    conversationIds: [...conversationIds],
  };
}

/** Pretty JSON with a trailing newline: the bytes that are hashed are the bytes on disk. */
const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** Builds the manifest and every file's bytes (no I/O). */
export function buildBundle(input: BundleInput): { manifest: ReplayManifest; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const sessions: BundleSession[] = [];
  const all: LedgerEntry[] = [];
  for (const s of input.sessions) {
    const meta = sessionMeta(s.entries);
    s.entries.forEach((e, i) => {
      if (!LedgerEntrySchema.safeParse(e).success) throw new Error(`entry ${i} of session ${meta.id} is not a ledger entry`);
      if (e.sessionId !== meta.id) throw new Error(`entry ${e.id} belongs to ${e.sessionId}, not ${meta.id}`);
      if (e.sequence !== i) throw new Error(`session ${meta.id} is incomplete: expected sequence ${i}, got ${e.sequence}`);
    });
    sessions.push(meta);
    all.push(...s.entries);
    files.set(ledgerPath(meta.id), jsonBytes({ sessionId: meta.id, entries: s.entries }));
    files.set(casesPath(meta.id), jsonBytes(s.cases));
    for (const [view, body] of Object.entries(s.views)) if (body !== undefined) files.set(`views/${meta.id}.${view}.json`, jsonBytes(body));
  }
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length) throw new Error("a session is listed twice");
  for (const f of input.files) files.set(f.path, f.bytes);
  for (const path of files.keys()) BundlePathSchema.parse(path);

  all.sort(compareTimeline);
  const first = all[0];
  const last = all.at(-1);
  if (first === undefined || last === undefined) throw new Error("the bundle has no entries");
  const head = chainHead(all);
  const manifest = ReplayManifestSchema.parse({
    format: REPLAY_FORMAT,
    bundleId: bundleIdFor(first.receivedAt, head),
    label: "verified-replay",
    exportedAt: input.exportedAt,
    source: input.source,
    exporter: input.exporter,
    sessions,
    timeline: { order: [...TIMELINE_ORDER], link: CHAIN_LINK, entries: all.length, firstAt: first.receivedAt, lastAt: last.receivedAt, genesis: CHAIN_GENESIS, head },
    files: Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => [path, { sha256: sha256Hex(bytes), bytes: bytes.byteLength }])),
    missing: input.missing,
  });
  return { manifest, files };
}

/** Writes a bundle under `parentDir/<bundleId>` atomically; refuses to replace an existing bundle. */
export async function writeBundle(parentDir: string, input: BundleInput): Promise<{ dir: string; manifest: ReplayManifest }> {
  const { manifest, files } = buildBundle(input);
  const dir = join(parentDir, manifest.bundleId);
  if (await exists(dir)) throw new Error(`bundle ${manifest.bundleId} already exists at ${dir} (bundles are immutable)`);
  const tmp = join(parentDir, `.tmp-${randomUUID()}`);
  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(tmp, path)), { recursive: true });
      await writeFile(join(tmp, path), bytes);
    }
    await writeFile(join(tmp, MANIFEST_FILE), jsonBytes(manifest));
    await rename(tmp, dir);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
  return { dir, manifest };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type VerifiedBundle = {
  manifest: ReplayManifest;
  /** sha256 of manifest.json itself (pin it out of band, e.g. in docs/replay/). */
  manifestSha256: string;
  /** Every entry of every session, in timeline order. */
  entries: LedgerEntry[];
  /** Cases response per session, as recorded. */
  cases: Map<string, unknown>;
  /** Recorded server views per session. */
  views: Map<string, Partial<Record<"debrief" | "tutor", unknown>>>;
  /** Parent ids that point outside the bundled sessions (recorded, not followed). */
  externalParents: number;
};

export type VerifyResult = { ok: true; bundle: VerifiedBundle } | { ok: false; reason: string };

const fail = (reason: string): VerifyResult => ({ ok: false, reason });

/** Re-verifies a bundle directory from scratch: manifest, every file hash, ledger files, hash chain. */
export async function verifyBundle(dir: string, expectedId?: string): Promise<VerifyResult> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(dir, MANIFEST_FILE));
  } catch {
    return fail("manifest.json is missing");
  }
  let manifest: ReplayManifest;
  try {
    manifest = ReplayManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    return fail(`manifest.json is not a valid ${REPLAY_FORMAT} manifest: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
  if (expectedId !== undefined && manifest.bundleId !== expectedId) return fail(`manifest names bundle ${manifest.bundleId}, not ${expectedId}`);
  if (!manifest.bundleId.endsWith(manifest.timeline.head.slice(0, 12))) return fail("the bundle id does not match the chain head");
  if (manifest.timeline.genesis !== CHAIN_GENESIS) return fail("unexpected chain genesis");

  // Every listed file, byte for byte; nothing unlisted is ever served (the media route reads only listed paths).
  const contents = new Map<string, Buffer>();
  for (const [path, expected] of Object.entries(manifest.files)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, path));
    } catch {
      return fail(`${path} is missing`);
    }
    if (bytes.byteLength !== expected.bytes) return fail(`${path}: size ${bytes.byteLength} ≠ ${expected.bytes} recorded`);
    if (sha256Hex(bytes) !== expected.sha256) return fail(`${path}: sha256 mismatch (file altered after export)`);
    if (!path.startsWith("media/") && !path.startsWith("audio/")) contents.set(path, bytes);
  }

  const entries: LedgerEntry[] = [];
  const cases = new Map<string, unknown>();
  const views = new Map<string, Partial<Record<"debrief" | "tutor", unknown>>>();
  for (const session of manifest.sessions) {
    const raw = contents.get(ledgerPath(session.id));
    if (raw === undefined) return fail(`ledger of session ${session.id} is not listed`);
    let file: { sessionId: string; entries: unknown[] };
    try {
      file = BundleLedgerFileSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      return fail(`${ledgerPath(session.id)} is not a ledger file`);
    }
    if (file.sessionId !== session.id) return fail(`${ledgerPath(session.id)} holds session ${file.sessionId}`);
    if (file.entries.length !== session.entries) return fail(`session ${session.id}: ${file.entries.length} entries, manifest says ${session.entries}`);
    for (const [i, value] of file.entries.entries()) {
      const parsed = LedgerEntrySchema.safeParse(value);
      if (!parsed.success) return fail(`session ${session.id} entry ${i} is not a ledger entry`);
      if (parsed.data.sessionId !== session.id || parsed.data.sequence !== i) return fail(`session ${session.id}: entry ${i} is out of place (sequence ${parsed.data.sequence})`);
      // Hash the entry exactly as stored (zod would drop nothing here: the entry schema is strict).
      entries.push(value as LedgerEntry);
    }
    const casesRaw = contents.get(casesPath(session.id));
    if (casesRaw === undefined) return fail(`cases of session ${session.id} are not listed`);
    cases.set(session.id, JSON.parse(casesRaw.toString("utf8")) as unknown);
    const sessionViews: Partial<Record<"debrief" | "tutor", unknown>> = {};
    for (const view of ["debrief", "tutor"] as const) {
      const v = contents.get(`views/${session.id}.${view}.json`);
      if (v !== undefined) sessionViews[view] = JSON.parse(v.toString("utf8")) as unknown;
    }
    views.set(session.id, sessionViews);
  }
  const listedLedgers = Object.keys(manifest.files).filter((p) => p.startsWith("ledger/")).length;
  if (listedLedgers !== manifest.sessions.length) return fail("the manifest lists a ledger file for a session it does not declare");

  entries.sort(compareTimeline);
  if (entries.length !== manifest.timeline.entries) return fail(`timeline has ${entries.length} entries, manifest says ${manifest.timeline.entries}`);
  const head = chainHead(entries);
  if (head !== manifest.timeline.head) return fail(`hash chain mismatch: recomputed head ${head.slice(0, 12)}…, manifest ${manifest.timeline.head.slice(0, 12)}…`);
  const ids = new Set(entries.map((e) => e.id));
  const externalParents = entries.reduce((n, e) => n + e.parentIds.filter((p) => !ids.has(p)).length, 0);

  return { ok: true, bundle: { manifest, manifestSha256: sha256Hex(manifestBytes), entries, cases, views, externalParents } };
}

/**
 * Ids of the rules in force over the bundled expert sessions alone (the same fold the server's rulebook
 * store runs, in the same order). The export compares it with the live rulebook: rules confirmed in
 * sessions outside the bundle are reported, since the replay derives with the bundled rules only.
 */
export function bundledRuleIds(sessions: readonly { entries: readonly LedgerEntry[] }[]): Set<string> {
  const kinds = new Set<string>(Object.values(RULE_EVENT_KINDS));
  const expert = sessions.filter((s) => s.entries.some((e) => e.kind === "session.started" && (e.payload as { mode?: unknown } | null)?.mode === "expert"));
  const events = expert.flatMap((s) => s.entries.filter((e) => kinds.has(e.kind))).sort(compareTimeline);
  return new Set(rulebookFromLedger(events).rules.map((r) => r.id));
}

/** Bundle ids present under `replaysDir` (directory names that look like bundle ids). */
export async function listBundleIds(replaysDir: string): Promise<string[]> {
  try {
    const names = await readdir(replaysDir, { withFileTypes: true });
    return names.filter((d) => d.isDirectory() && BundleIdSchema.safeParse(d.name).success).map((d) => d.name).sort().reverse();
  } catch {
    return [];
  }
}

export async function readManifest(dir: string): Promise<ReplayManifest | undefined> {
  try {
    return ReplayManifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")));
  } catch {
    return undefined;
  }
}
