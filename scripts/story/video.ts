/**
 * `pnpm story:video [--only demo|tech]` — records and assembles docs/video/demo.mp4 and docs/video/tech.mp4
 * (H.264/AAC, 1920×1080, with soft English subtitles) plus .srt sidecars.
 *
 * Pipeline (nothing touches the deployed service):
 *   1. evidence + narration (docs/video/narration.md) → ElevenLabs TTS, cached outside the repo;
 *   2. a production build of HEAD in a cache dir (lib/server.ts), two LOCAL servers with fresh DATA_DIRs,
 *      LLM_CALLS=off; server A also holds a copy of the verified replay bundle (re-verified by the server on load);
 *   3. Playwright `recordVideo` per beat (demo.ts / tech.ts), narration cued live;
 *   4. ffmpeg (fetched from the npm registry tarball into the cache, not a dependency) muxes picture, narration
 *      and the bundle's recorded conversation audio, and embeds the SRT.
 * Env: STORY_CACHE (default $TMPDIR/vashistha-story), STORY_TREE (reuse a built tree), FFMPEG, STORY_BUNDLE.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDemo } from "./demo";
import { architectureSvg } from "./lib/architecture";
import { loadEvidence, type Evidence } from "./lib/evidence";
import { durationOf, ensureFfmpeg, playwrightBrowsers } from "./lib/ffmpeg";
import { productName } from "./lib/html";
import { NARRATOR, loadNarration, voice, type Voiced } from "./lib/narration";
import { Production } from "./lib/production";
import type { Browser } from "./lib/playwright";
import { REPO, VIDEO_DIR, rel } from "./lib/repo";
import { prepareTree, startServer, type LocalServer } from "./lib/server";
import { recordTech } from "./tech";

export type ReplayInfo = {
  bundleId: string;
  recordedAt: string;
  debriefAt: number;
  tamperFile: string;
  audio: { file: string; from: number; to: number; answerEnd: number; lines: { at: number; until: number; text: string }[] };
};

export type StoryContext = {
  prod: Production;
  ev: Evidence;
  name: string;
  browser: Browser;
  serverA: LocalServer;
  serverB: LocalServer;
  commit: string;
  voiced: Map<string, Voiced>;
  replay: ReplayInfo;
  closedDebriefSession: string;
};

type Entry = { sessionId: string; sequence: number; receivedAt: number; kind: string; payload: Record<string, unknown> };
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The local bundle, checked against the committed manifest pin before any of it is used. */
function replayInfo(ev: Evidence, dataDir: string): ReplayInfo {
  const bundleId = ev.replay.bundleId.text;
  const source = process.env.STORY_BUNDLE ?? join(REPO, "apps/web/data/replays", bundleId);
  const pin = JSON.parse(readFileSync(join(REPO, ev.replay.source), "utf8")) as {
    manifestSha256: string;
    manifest: { files: Record<string, { sha256: string }>; timeline: { firstAt: number }; sessions: { id: string; conversationIds: string[] }[] };
  };
  if (sha(join(source, "manifest.json")) !== pin.manifestSha256) throw new Error(`replay bundle at ${source} does not match the committed manifest ${ev.replay.source}`);
  const copy = join(dataDir, "replays", bundleId);
  const entries: Entry[] = [];
  for (const f of readdirSync(join(copy, "ledger"))) entries.push(...(JSON.parse(readFileSync(join(copy, "ledger", f), "utf8")) as { entries: Entry[] }).entries);
  entries.sort((a, b) => a.receivedAt - b.receivedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || a.sequence - b.sequence);
  const first = pin.manifest.sessions[0];
  if (first === undefined) throw new Error("bundle has no sessions");
  const conv = first.conversationIds[0] ?? "";
  const answer = entries.find((e) => e.sessionId === first.id && e.kind === "utterance.transcript" && String(e.payload.text ?? "").startsWith("Never approve a customer from a high-risk country"));
  const asked = entries.filter((e) => e.sessionId === first.id && e.kind === "agent.utterance" && answer !== undefined && e.receivedAt < answer.receivedAt).at(-1);
  if (answer === undefined || asked === undefined) throw new Error("bundle: the stop-rule answer or its question is missing");
  const audioRel = `audio/${conv}.mp3`;
  const audioFile = join(copy, audioRel);
  if (sha(audioFile) !== pin.manifest.files[audioRel]?.sha256) throw new Error(`${audioRel}: sha256 differs from the committed manifest`);
  const t0 = Number(answer.payload.t0Ms) / 1000;
  const t1 = Number(answer.payload.t1Ms) / 1000;
  // The agent's question starts at 55 s in ElevenLabs' turn record (docs/video/evidence/conversation-turns.txt); the answer's times are the ledger's.
  const from = 55.0;
  const debriefAt = entries.findIndex((e) => e.sessionId === first.id && e.kind === "workmap.generated") + 1;
  const frame = Object.keys(pin.manifest.files).find((p) => p.startsWith("media/"));
  if (frame === undefined) throw new Error("bundle has no frame");
  return {
    bundleId,
    recordedAt: `${new Date(pin.manifest.timeline.firstAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    debriefAt,
    tamperFile: join(copy, frame),
    audio: {
      file: audioFile,
      from,
      to: t1 + 0.6,
      answerEnd: t1,
      lines: [
        { at: 0.2, until: t0 - from - 0.4, text: `[Agent, recorded] ${String(asked.payload.text)}` },
        { at: t0 - from, until: t1 - from + 0.4, text: `[Expert, recorded · synthetic voice] ${String(answer.payload.text)}` },
      ],
    },
  };
}

async function main(): Promise<void> {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  const assembleOnly = process.argv.includes("--assemble-only");
  const cache = process.env.STORY_CACHE ?? join(tmpdir(), "vashistha-story");
  mkdirSync(cache, { recursive: true });
  const ev = loadEvidence();
  const name = productName();
  const ffmpeg = ensureFfmpeg(cache);
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers(cache, ffmpeg);
  const { playwright } = await import("./lib/playwright");

  mkdirSync(VIDEO_DIR, { recursive: true });
  writeFileSync(join(VIDEO_DIR, "architecture.svg"), architectureSvg("auto"));

  const voiced = new Map<string, Voiced>();
  for (const prefix of ["demo", "tech"]) {
    for (const seg of loadNarration(ev, prefix)) voiced.set(seg.id, await voice(seg, join(cache, "tts"), (f) => durationOf(ffmpeg, f)));
  }
  console.info(`narration: ${voiced.size} segments, ${[...voiced.values()].reduce((s, v) => s + v.duration, 0).toFixed(1)} s (AI narration, ElevenLabs “${NARRATOR.voiceName}”)`);

  const tree = prepareTree();
  const bundleSrc = process.env.STORY_BUNDLE ?? join(REPO, "apps/web/data/replays", ev.replay.bundleId.text);
  const serverA = await startServer({ tree, port: Number(process.env.STORY_PORT_A ?? 4631), replays: [bundleSrc], log: join(cache, "server-a.log") });
  const serverB = await startServer({ tree, port: Number(process.env.STORY_PORT_B ?? 4632), log: join(cache, "server-b.log") });
  const browser = await playwright.chromium.launch();
  const results: { file: string; duration: number }[] = [];
  try {
    const replay = replayInfo(ev, serverA.dataDir);
    const base = { ev, name, browser, serverA, serverB, commit: tree.commit, voiced, replay, closedDebriefSession: "" };
    const runs: { id: "demo" | "tech"; title: string }[] = [
      { id: "demo", title: `${name} — demo` },
      { id: "tech", title: `${name} — how it works` },
    ];
    for (const run of runs) {
      if (only !== undefined && only !== run.id && !(run.id === "demo" && only === "tech")) continue;
      const rawDir = join(cache, `raw-${run.id}`);
      const prod = new Production(browser, rawDir, voiced);
      if (assembleOnly) {
        if (only !== undefined && only !== run.id) continue;
        prod.load();
      } else {
        rmSync(rawDir, { recursive: true, force: true });
        mkdirSync(rawDir, { recursive: true });
        // A tech-only run still needs a closed debrief: the demo is recorded into a scratch production and discarded.
        console.info(`recording ${run.id}…`);
        if (run.id === "demo") {
          base.closedDebriefSession = await recordDemo({ ...base, prod });
          prod.save();
          if (only === "tech") continue;
        } else {
          await recordTech({ ...base, prod });
          prod.save();
        }
      }
      const mp4 = join(VIDEO_DIR, `${run.id}.mp4`);
      const { duration } = prod.assemble(ffmpeg, { mp4, srt: join(VIDEO_DIR, `${run.id}.srt`), title: run.title });
      results.push({ file: mp4, duration });
      console.info(`${rel(mp4)}: ${duration.toFixed(1)} s, ${(statSync(mp4).size / 1e6).toFixed(1)} MB`);
    }
  } finally {
    await browser.close();
    await serverA.stop();
    await serverB.stop();
  }

  const lines = ["# sha256 of the story videos (scripts/story/video.ts). Each video's end card names the commit of the local build it was recorded on."];
  for (const f of ["demo.mp4", "demo.srt", "tech.mp4", "tech.srt", "architecture.svg"]) {
    const abs = join(VIDEO_DIR, f);
    if (!existsSync(abs)) continue;
    const seconds = f.endsWith(".mp4") ? `  ${durationOf(ffmpeg, abs).toFixed(1)} s` : "";
    const built = results.some((r) => r.file === abs || r.file.replace(/\.mp4$/, ".srt") === abs) ? `  recorded on ${tree.commit}` : "";
    lines.push(`${sha(abs)}  ${f}  ${statSync(abs).size} bytes${seconds}${built}`);
  }
  writeFileSync(join(VIDEO_DIR, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

await main();
