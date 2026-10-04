/**
 * `pnpm replay:export --base <url> --sessions <id,id,…> --out <dir> [--audio] [--manifest-copy <dir>]`
 *
 * Exports a GENUINE recorded run into an immutable, integrity-checked run bundle (format:
 * apps/web/lib/replay/format.ts) for the labelled verified replay mode (plan §10–12, P11):
 *
 * - `GET /api/health` (version, commit) of the live server;
 * - per session: every ledger entry (`GET /api/sessions/:id/ledger`, paged), the cases the UI listed
 *   (`GET /api/cases`), the read-only server view at export (`GET …/debrief` for expert sessions,
 *   `GET …/tutor` for novice sessions) and every redacted frame its `frame.received` entries reference
 *   (`GET /api/media/:id/frames/:frame.png`);
 * - with `--audio`, the recorded conversation audio from ElevenLabs (`ELEVENLABS_API_KEY`), only if the
 *   provider still has it. Nothing is ever synthesised; whatever is unavailable is listed in the
 *   manifest's `missing` with the reason.
 *
 * Only read APIs are called. The ledger is re-read at the end: if the run grew during the export, the
 * export is refused (export when the run is idle). The bundle is written to `<out>/<bundleId>` (use
 * `--out $DATA_DIR/replays` to serve it from a local server) and verified from disk before exiting.
 * Relative paths resolve against the directory `pnpm` was started in. A bearer (CUSTOM_LLM_SECRET) is
 * sent only if a route answers 401. `--manifest-copy docs/replay` also writes the manifest there (the
 * small file that is committed for the demo bundle).
 */
import { execFileSync } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MANIFEST_FILE, bundledRuleIds, verifyBundle, writeBundle, type BundleInput } from "../apps/web/lib/replay/bundle";
import { audioPath, framePath } from "../apps/web/lib/replay/format";

// Prefer IPv4: on networks with broken IPv6 routes, Node's fetch otherwise hits its 10 s connect timeout.
setDefaultResultOrder("ipv4first");

const PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry = { id: string; sessionId: string; sequence: number; source: string; kind: string; receivedAt: number; payload: unknown } & Record<string, unknown>;

function fromInvocationDir(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function makeClient(base: string, bearer: string | undefined) {
  async function get(path: string): Promise<Response> {
    const url = new URL(path, base).toString();
    let response = await fetch(url, { headers: { Accept: "*/*" }, signal: AbortSignal.timeout(60_000) });
    if (response.status === 401 && bearer !== undefined)
      response = await fetch(url, { headers: { Accept: "*/*", Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(60_000) });
    return response;
  }
  async function json<T>(path: string): Promise<T> {
    const response = await get(path);
    if (!response.ok) throw new Error(`GET ${path} → ${response.status} ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as T;
  }
  return { get, json };
}

async function ledger(client: ReturnType<typeof makeClient>, sessionId: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (;;) {
    const after = entries.at(-1)?.sequence;
    const query = `limit=${PAGE}${after === undefined ? "" : `&after=${after}`}`;
    const page = await client.json<{ entries: Entry[] }>(`/api/sessions/${sessionId}/ledger?${query}`);
    entries.push(...page.entries);
    if (page.entries.length < PAGE) return entries;
  }
}

function localGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      sessions: { type: "string" },
      out: { type: "string" },
      audio: { type: "boolean", default: false },
      "manifest-copy": { type: "string" },
    },
    strict: true,
  });
  if (values.base === undefined || values.sessions === undefined || values.out === undefined)
    throw new Error("usage: pnpm replay:export --base <url> --sessions <id,id,…> --out <dir> [--audio] [--manifest-copy <dir>]");
  const base = new URL(values.base).toString();
  const sessionIds = [...new Set(values.sessions.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  const bad = sessionIds.filter((id) => !UUID.test(id));
  if (sessionIds.length === 0 || bad.length > 0) throw new Error(`--sessions must be session UUIDs (bad: ${bad.join(", ") || "none given"})`);
  const outDir = fromInvocationDir(values.out);

  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const client = makeClient(base, process.env.CUSTOM_LLM_SECRET);

  const health = await client.json<{ ok: boolean; version: string; commit?: string | null }>("/api/health");
  console.info(`source ${base} · version ${health.version} · commit ${health.commit ?? "unknown"}`);

  const sessions: BundleInput["sessions"] = [];
  const files: BundleInput["files"] = [];
  const missing: BundleInput["missing"] = [];
  const conversations = new Set<string>();
  for (const sessionId of sessionIds) {
    const entries = await ledger(client, sessionId);
    const started = entries.find((e) => e.kind === "session.started" && e.source === "engine")?.payload as { mode?: string; caseSet?: string } | undefined;
    if (started?.mode === undefined || started.caseSet === undefined) throw new Error(`session ${sessionId} is not a CaseDesk session`);
    const cases = await client.json<unknown>(`/api/cases?set=${encodeURIComponent(started.caseSet)}&session=${sessionId}`);
    const view = started.mode === "expert" ? "debrief" : "tutor";
    const views: BundleInput["sessions"][number]["views"] = {};
    const viewResponse = await client.get(`/api/sessions/${sessionId}/${view}`);
    if (viewResponse.ok) views[view] = (await viewResponse.json()) as unknown;
    else missing.push({ ref: `views/${sessionId}.${view}.json`, reason: `GET /${view} → ${viewResponse.status}` });

    let frames = 0;
    for (const e of entries) {
      if (e.kind === "utterance.transcript" || e.kind === "agent.utterance") {
        const conversationId = (e.payload as { conversationId?: unknown }).conversationId;
        if (typeof conversationId === "string") conversations.add(conversationId);
      }
      if (e.kind !== "frame.received" || e.source !== "client") continue;
      const frameId = (e.payload as { frameId?: unknown }).frameId;
      if (typeof frameId !== "string" || !UUID.test(frameId)) {
        missing.push({ ref: `frame of entry ${e.id}`, reason: "frame id is not a UUID" });
        continue;
      }
      const response = await client.get(`/api/media/${sessionId}/frames/${frameId}.png`);
      if (!response.ok) {
        missing.push({ ref: framePath(sessionId, frameId), reason: `media route → ${response.status}` });
        continue;
      }
      files.push({ path: framePath(sessionId, frameId), bytes: new Uint8Array(await response.arrayBuffer()) });
      frames += 1;
    }
    sessions.push({ entries: entries as never, cases, views });
    console.info(`session ${sessionId} · ${started.mode} · ${started.caseSet} · ${entries.length} entries · ${frames} frame(s)`);
  }

  for (const conversationId of conversations) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) {
      missing.push({ ref: `audio of ${conversationId}`, reason: "conversation id is not a safe file name" });
      continue;
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!values.audio || apiKey === undefined) {
      missing.push({ ref: audioPath(conversationId), reason: values.audio ? "ELEVENLABS_API_KEY is not set" : "not requested (export with --audio)" });
      continue;
    }
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}/audio`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      missing.push({ ref: audioPath(conversationId), reason: `voice provider → ${response.status}` });
      continue;
    }
    files.push({ path: audioPath(conversationId), bytes: new Uint8Array(await response.arrayBuffer()) });
    console.info(`audio ${conversationId} · recorded conversation audio included`);
  }

  // Rules in force on the live server that no bundled session confirmed: the replay cannot show them (stated, not hidden).
  const live = await client.json<{ revision: number; rules: { id: string }[] }>("/api/rulebook");
  const bundled = bundledRuleIds(sessions as never);
  const outside = live.rules.filter((r) => !bundled.has(r.id));
  if (outside.length > 0) {
    const reason = `the live rulebook (revision ${live.revision}) also holds ${outside.length} rule(s) confirmed in sessions not in this bundle; the replay derives with the bundled sessions' rules only`;
    missing.push({ ref: "rulebook", reason });
    console.warn(`warning: ${reason} (add those expert sessions to --sessions to include them)`);
  }

  // The run must not have moved while it was being exported.
  for (const s of sessions) {
    const sessionId = s.entries[0]?.sessionId ?? "";
    const now = await ledger(client, sessionId);
    if (now.length !== s.entries.length)
      throw new Error(`session ${sessionId} grew from ${s.entries.length} to ${now.length} entries during the export; export again when the run is idle`);
  }

  await mkdir(outDir, { recursive: true });
  const { dir, manifest } = await writeBundle(outDir, {
    exportedAt: Date.now(),
    source: { baseUrl: base, version: health.version, commit: health.commit ?? null },
    exporter: { tool: "scripts/replay-export.ts", gitCommit: localGitCommit() },
    sessions,
    files,
    missing,
  });
  const verified = await verifyBundle(dir, manifest.bundleId);
  if (!verified.ok) throw new Error(`the bundle written to ${dir} does not verify: ${verified.reason}`);
  console.info(`\nbundle ${manifest.bundleId} → ${dir}`);
  console.info(`  ${manifest.timeline.entries} entries · chain head ${manifest.timeline.head} · ${Object.keys(manifest.files).length} files`);
  console.info(`  manifest sha256 ${verified.bundle.manifestSha256}`);
  if (missing.length > 0) console.info(`  not included (${missing.length}): ${missing.map((m) => `${m.ref} — ${m.reason}`).join("; ")}`);
  if (values["manifest-copy"] !== undefined) {
    const copyDir = fromInvocationDir(values["manifest-copy"]);
    await mkdir(copyDir, { recursive: true });
    const copy = join(copyDir, `${manifest.bundleId}.${MANIFEST_FILE}`);
    await writeFile(copy, `${JSON.stringify({ manifestSha256: verified.bundle.manifestSha256, manifest }, null, 2)}\n`);
    console.info(`  manifest copy → ${copy}`);
  }
  console.info(`  replay: /replay/${manifest.bundleId}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`replay:export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
