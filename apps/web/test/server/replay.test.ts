/**
 * P11 verified replay: run bundles (export → bundle → verify), tamper refusal, hash-chain determinism,
 * read-only derivation, and parity — the replay's derived views, ticker lines, compliance strip and
 * CaseDesk equal what the live code computes for the same recorded session.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@vashistha/core";
import { kycCases } from "@vashistha/core/domains/kyc";
import { compileProcedure, exportWorkMapJson } from "@vashistha/mcp-guardrails";
import { computeCompliance } from "../../lib/client/judge/compliance";
import { tickerLines } from "../../lib/client/judge/ticker";
import { replayCaseDesk } from "../../lib/client/replay/casedesk";
import { summariseLedger } from "../../lib/client/session-state";
import { DebriefStateSchema, type DebriefState } from "../../lib/contracts/debrief";
import { ReplayViewsResponseSchema } from "../../lib/contracts/replay";
import { TutorStateSchema } from "../../lib/contracts/tutor";
import { CHAIN_GENESIS, buildBundle, chainHead, chainLinks, sha256Hex, verifyBundle, writeBundle, type BundleInput } from "../../lib/replay/bundle";
import { REPLAY_FORMAT, compareTimeline, framePath, ledgerPath } from "../../lib/replay/format";
import { createDebriefStore } from "../../lib/server/debrief/deps";
import { createWitnessSolver } from "../../lib/server/debrief/solver";
import { createPrefix } from "../../lib/server/replay/derive";
import { handleImportCommit } from "../../lib/server/replay/handlers";
import { REPLAYS_DIR, createReplayService, rewriteMedia } from "../../lib/server/replay/service";
import { getState, rebuild, world } from "../support/debrief-harness";
import { QUOTES, createTutorHarness, demoRules } from "../support/tutor-harness";

const engines = { solver: createWitnessSolver(), exports: { workMapJson: exportWorkMapJson, procedure: compileProcedure } };
const SOURCE = { baseUrl: "https://vashistha.example", version: "0.1.0", commit: null };
const EXPORTER = { tool: "test", gitCommit: null };

function bundleInput(sessions: BundleInput["sessions"], files: BundleInput["files"] = []): BundleInput {
  return { exportedAt: 1_760_000_100_000, source: SOURCE, exporter: EXPORTER, sessions, files, missing: [] };
}

async function dataDir(): Promise<{ root: string; replays: string }> {
  const root = await mkdtemp(join(tmpdir(), "replay-"));
  return { root, replays: join(root, REPLAYS_DIR) };
}

/** A recorded tutor run: an expert's confirmed rules, then a novice who selects a forbidden outcome, hears the intervention, and decides correctly. */
async function tutorRun() {
  const h = createTutorHarness();
  const ruleEntries = await h.seedRules(demoRules());
  const expert = h.ledger.get([...ruleEntries.values()][0] ?? "")?.sessionId ?? "";
  const novice = await h.session("heldout");
  await h.events(novice, [{ kind: "open_case", caseId: "NS-2026-0201" }]);
  await h.intent(novice, "NS-2026-0201", "approve");
  const atIntervention = { tutor: TutorStateSchema.parse((await h.state(novice)).body), entries: h.entries(novice) };
  const queue = (await h.questions(novice)).body as { queue: { id: string }[]; contextVersion: number };
  const top = queue.queue[0];
  if (top === undefined) throw new Error("the intervention was not queued");
  expect((await h.authorize(novice, top.id, queue.contextVersion)).status).toBe(200);
  await h.intent(novice, "NS-2026-0201", "enhancedReview");
  await h.save(novice, "NS-2026-0201", "enhancedReview");
  return { h, expert, novice, atIntervention };
}

function sessionsOf(h: ReturnType<typeof createTutorHarness>, ids: readonly string[]): BundleInput["sessions"] {
  return ids.map((id) => {
    const entries = h.entries(id);
    const mode = entries.find((e) => e.kind === "session.started")?.payload as { caseSet: "training" | "heldout" };
    return { entries, cases: { cases: kycCases(mode.caseSet) }, views: {} };
  });
}

describe("hash chain", () => {
  const entries = [
    { id: "a", sessionId: "s", sequence: 0, kind: "x", payload: { b: 1, a: [1, { d: 2, c: 3 }] } },
    { id: "b", sessionId: "s", sequence: 1, kind: "y", payload: null },
  ];

  it("link_i = sha256(link_{i-1} ‖ canonicalJson(entry_i)), from sha256(format)", () => {
    expect(CHAIN_GENESIS).toBe(sha256Hex(REPLAY_FORMAT));
    const [l1, l2] = chainLinks(entries);
    expect(l1).toBe(sha256Hex(CHAIN_GENESIS + canonicalJson(entries[0])));
    expect(l2).toBe(sha256Hex(l1 + canonicalJson(entries[1])));
  });

  it("is deterministic and independent of key order, but not of entry order or content", () => {
    const shuffled = entries.map((e) => JSON.parse(JSON.stringify({ payload: e.payload, kind: e.kind, sequence: e.sequence, sessionId: e.sessionId, id: e.id })) as unknown);
    expect(chainHead(entries)).toBe(chainHead(entries));
    expect(chainHead(shuffled)).toBe(chainHead(entries));
    expect(chainHead([...entries].reverse())).not.toBe(chainHead(entries));
    expect(chainHead([entries[0], { ...entries[1], payload: 0 }])).not.toBe(chainHead(entries));
  });
});

describe("run bundle: export → bundle → verify", () => {
  it("writes an immutable bundle whose id ends in the chain head, and verifies it from disk", async () => {
    const { h, novice } = await tutorRun();
    const input = bundleInput(sessionsOf(h, [novice]));
    const { replays } = await dataDir();
    const { dir, manifest } = await writeBundle(replays, input);
    expect(manifest.bundleId.endsWith(manifest.timeline.head.slice(0, 12))).toBe(true);
    expect(manifest.timeline.entries).toBe(h.entries(novice).length);
    const verified = await verifyBundle(dir, manifest.bundleId);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.bundle.entries.map((e) => e.id)).toEqual([...h.entries(novice)].sort(compareTimeline).map((e) => e.id));
    // Immutable: the same run cannot be written over.
    await expect(writeBundle(replays, input)).rejects.toThrow(/already exists/);
    // Deterministic: the same recorded entries always give the same id and chain.
    expect(buildBundle(input).manifest.timeline.head).toBe(manifest.timeline.head);
  });

  it("refuses an incomplete session ledger", () => {
    const entries = createTutorHarness().entries("none");
    expect(() => buildBundle(bundleInput([{ entries, cases: {}, views: {} }]))).toThrow();
  });
});

describe("tamper → refusal", () => {
  async function exported() {
    const { h, novice } = await tutorRun();
    const frameId = randomUUID();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const { root, replays } = await dataDir();
    const { dir, manifest } = await writeBundle(replays, bundleInput(sessionsOf(h, [novice]), [{ path: framePath(novice, frameId), bytes: png }]));
    return { root, dir, manifest, novice, frameId };
  }

  it("one byte changed in a ledger entry: refused (file hash), and the replay service refuses to play it", async () => {
    const { root, dir, manifest, novice } = await exported();
    const service = createReplayService({ dataDir: root, engines });
    expect((await service.open(manifest.bundleId)).ok).toBe(true);
    const path = join(dir, ledgerPath(novice));
    // Exactly one byte: a case id inside one recorded entry.
    const bytes = await readFile(path);
    const at = bytes.indexOf("NS-2026-0201") + "NS-2026-020".length;
    bytes[at] = "2".charCodeAt(0);
    await writeFile(path, bytes);
    const verified = await verifyBundle(dir);
    expect(verified).toMatchObject({ ok: false, reason: expect.stringMatching(/sha256 mismatch/) });
    const opened = await service.open(manifest.bundleId);
    expect(opened).toMatchObject({ ok: false, status: 409, code: "integrity_failed" });
    expect(await service.views(manifest.bundleId, 3)).toBeNull();
  });

  it("an entry changed AND its file hash updated in the manifest: refused by the hash chain", async () => {
    const { dir, novice } = await exported();
    const path = join(dir, ledgerPath(novice));
    const altered = (await readFile(path, "utf8")).replace('"enhancedReview"', '"approve"');
    await writeFile(path, altered);
    const manifestPath = join(dir, "manifest.json");
    const m = JSON.parse(await readFile(manifestPath, "utf8")) as { files: Record<string, { sha256: string; bytes: number }> };
    m.files[ledgerPath(novice)] = { sha256: sha256Hex(altered), bytes: Buffer.byteLength(altered) };
    await writeFile(manifestPath, JSON.stringify(m));
    expect(await verifyBundle(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/hash chain mismatch/) });
  });

  it("one byte changed in a frame: refused; and a frame is served only while it still hashes", async () => {
    const { root, dir, manifest, novice, frameId } = await exported();
    const service = createReplayService({ dataDir: root, engines });
    expect((await service.open(manifest.bundleId)).ok).toBe(true);
    const rel = framePath(novice, frameId);
    expect(await service.file(manifest.bundleId, rel)).not.toBeNull();
    expect(await service.file(manifest.bundleId, "manifest.json")).toBeNull();
    const bytes = await readFile(join(dir, rel));
    bytes[5] = (bytes[5] ?? 0) ^ 0xff;
    await writeFile(join(dir, rel), bytes);
    expect(await service.file(manifest.bundleId, rel)).toBeNull();
    expect(await verifyBundle(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(new RegExp(`${rel}: sha256 mismatch`)) });
  });
});

describe("guarded import", () => {
  it("stages every file, verifies on commit, refuses a tampered or existing bundle, and requires the bearer", async () => {
    const { h, novice } = await tutorRun();
    const source = await dataDir();
    const { dir, manifest } = await writeBundle(source.replays, bundleInput(sessionsOf(h, [novice])));
    const target = await dataDir();
    const service = createReplayService({ dataDir: target.root, engines });
    const paths = [...Object.keys(manifest.files), "manifest.json"];
    const upload = async (tamper: boolean) => {
      for (const path of paths) {
        const bytes = await readFile(join(dir, path));
        if (tamper && path.startsWith("ledger/")) bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 1;
        expect((await service.stage(manifest.bundleId, path, bytes)).ok).toBe(true);
      }
    };
    await upload(true);
    expect(await service.commit(manifest.bundleId)).toMatchObject({ ok: false, status: 422, code: "integrity_failed" });
    expect((await service.open(manifest.bundleId)).ok).toBe(false);
    await upload(false);
    expect(await service.commit(manifest.bundleId)).toMatchObject({ ok: true });
    expect((await service.open(manifest.bundleId)).ok).toBe(true);
    expect(await service.stage(manifest.bundleId, "manifest.json", new Uint8Array([1]))).toMatchObject({ ok: false, status: 409 });
    expect(await service.stage(manifest.bundleId.replace(/.$/, "0"), "../x", new Uint8Array([1]))).toMatchObject({ ok: false, status: 400 });
    const unauthorised = await handleImportCommit(new Request("http://x/api/replays/x/import", { method: "POST" }), service, "s3cret-s3cret-s3cret", manifest.bundleId, { info: () => undefined, warn: () => undefined, error: () => undefined });
    expect(unauthorised.status).toBe(401);
  }, 30_000);
});

describe("replay derivations equal live derivations", () => {
  it("debrief: the replayed state at the end equals the live GET /debrief (coverage included), and cross-checks against the recorded view", async () => {
    const w = await world();
    await rebuild(w);
    const live = await getState(w);
    const entries = w.ledger.list(w.sessionId);
    const { root, replays } = await dataDir();
    const { manifest } = await writeBundle(replays, bundleInput([{ entries, cases: { cases: kycCases("training") }, views: { debrief: live } }]));
    const service = createReplayService({ dataDir: root, engines });
    expect((await service.open(manifest.bundleId)).ok).toBe(true);
    const views = await service.views(manifest.bundleId, entries.length);
    // The HTTP contract the browser validates.
    ReplayViewsResponseSchema.parse(views);
    const replayed = DebriefStateSchema.parse(views?.sessions[w.sessionId]?.debrief);
    const strip = ({ llmAvailable: _, ...rest }: DebriefState) => rest;
    expect(strip(replayed)).toEqual(strip(live));
    expect(replayed.coverage).toEqual(live.coverage);
    expect(views?.crossCheck).toEqual([{ sessionId: w.sessionId, view: "debrief", match: true, differences: [] }]);
    // The Work Map is built from the same snapshot: same coverage, steps for every observed decision, template prose.
    const wm = views?.sessions[w.sessionId]?.workmap;
    expect(wm?.workMap.coverage).toEqual(live.coverage);
    expect(wm?.workMap.steps.length).toBe(live.decisions.length);
    expect(wm?.proseOrigin).toBe("template");
    // Nothing was written: the live ledger did not grow.
    expect(w.ledger.list(w.sessionId).length).toBe(entries.length);
  }, 60_000);

  it("tutor, ticker, compliance strip and CaseDesk: equal at the end and at the moment of the intervention", async () => {
    const { h, expert, novice, atIntervention } = await tutorRun();
    const sessions = sessionsOf(h, [expert, novice]);
    const liveTutor = TutorStateSchema.parse((await h.state(novice)).body);
    const { root, replays } = await dataDir();
    const { manifest } = await writeBundle(replays, bundleInput(sessions.map((s) => (s.entries[0]?.sessionId === novice ? { ...s, views: { tutor: liveTutor } } : s))));
    const service = createReplayService({ dataDir: root, engines });
    const opened = await service.open(manifest.bundleId);
    if (!opened.ok) throw new Error(opened.detail);
    const timeline = opened.body.entries;

    // End of the recording.
    const end = await service.views(manifest.bundleId, timeline.length);
    ReplayViewsResponseSchema.parse(end);
    // Frames are served from the bundle: the only difference is the media URL prefix.
    expect(end?.sessions[novice]?.tutor).toEqual(rewriteMedia(liveTutor, manifest.bundleId));
    expect(JSON.stringify(end?.sessions[novice]?.tutor)).not.toContain('"/api/media/');
    expect(end?.crossCheck.every((c) => c.match)).toBe(true);
    const liveEntries = h.entries(novice);
    const replayEntries = timeline.filter((e) => e.sessionId === novice);
    expect(tickerLines(replayEntries, 500)).toEqual(tickerLines(liveEntries, 500));
    expect(computeCompliance(replayEntries)).toEqual(computeCompliance(liveEntries));
    expect(computeCompliance(replayEntries).unseenCaseIntercepted).toBe(true);
    const desk = replayCaseDesk(replayEntries, kycCases("heldout"), new Set());
    expect(desk?.session).toEqual(summariseLedger(liveEntries));
    expect(desk?.selectedId).toBe("NS-2026-0201");

    // The moment the tutor intervened (before the novice changed their outcome): the replay shows what the live UI showed then.
    const lastId = atIntervention.entries.at(-1)?.id;
    const n = timeline.findIndex((e) => e.id === lastId) + 1;
    const then = await service.views(manifest.bundleId, n);
    expect(then?.sessions[novice]?.tutor).toEqual(rewriteMedia(atIntervention.tutor, manifest.bundleId));
    const intervention = then?.sessions[novice]?.tutor?.cases.find((c) => c.caseId === "NS-2026-0201")?.interventions[0];
    expect(intervention?.text).toContain(QUOTES.neverApprove);
    // Inside that recorded write (the intervention appended, its spoken question not yet): not a state any reader saw,
    // so the views run to the end of the write — the same state as above — and say so.
    const split = timeline.findIndex((e) => e.kind === "tutor.intervention") + 1;
    expect(split).toBe(n - 1);
    const inside = ReplayViewsResponseSchema.parse(await service.views(manifest.bundleId, split));
    expect(inside.derivedThrough).toBe(n);
    expect(inside.sessions[novice]?.tutor).toEqual(then?.sessions[novice]?.tutor);
    const prefix = timeline.slice(0, n).filter((e) => e.sessionId === novice);
    expect(computeCompliance(prefix)).toEqual(computeCompliance(atIntervention.entries));
    expect(replayCaseDesk(prefix, kycCases("heldout"), new Set())?.drafts.get("NS-2026-0201")?.outcome).toBe("approve");
  }, 60_000);

  it("the derivation is read-only: its ledger refuses every write", () => {
    const prefix = createPrefix(engines, createDebriefStore(), 0);
    expect(() => prefix.debrief.ledger.createSession()).toThrow(/read-only/);
    expect(() => prefix.tutor.ledger.append({} as never)).toThrow(/read-only/);
    prefix.opened.close();
  });
});
