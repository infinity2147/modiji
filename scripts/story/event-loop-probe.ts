/**
 * Event-loop numbers after the worker-thread fix (live bug #6, commit 1b0c089), measured on THIS machine
 * against a local production build of HEAD — not on the deployed service. Writes
 * docs/video/evidence/event-loop-local.{json,txt}, which the deck and the tech video read.
 *
 * 1. Runs the repo's own event-loop test (apps/web/test/server/event-loop.test.ts) and keeps its measured line.
 * 2. Starts the local server, builds up expert sessions through the public APIs (decisions + frames +
 *    confirmed rules + Z3 witness runs), then requests a COLD Work Map export while sampling /api/health
 *    every 250 ms from this process — the same shape as the production probe that found the stall
 *    (docs/evidence/live/bugs/event-loop-stall-probe.txt, probe 2) — and reads /api/health/deep's event-loop delay.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { VIDEO_DIR, rel } from "./lib/repo";
import { api, createSession, debrief, debriefAction, decide, openCase, schematicPng, uploadFrame } from "./lib/seed";
import { OPERATOR_SECRET, prepareTree, startServer } from "./lib/server";

const SESSIONS = 6;
const DECISIONS: [string, string][] = [
  ["NS-2026-0101", "requestDocuments"],
  ["NS-2026-0102", "approve"],
  ["NS-2026-0103", "enhancedReview"],
];

const pctl = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
};

async function main(): Promise<void> {
  const tree = prepareTree();
  const out = join(VIDEO_DIR, "evidence");
  mkdirSync(out, { recursive: true });

  let test: { p99Ms: number; maxMs: number; samples: number } | null = null;
  try {
    const log = execFileSync("npx", ["vitest", "run", "--project", "web", "apps/web/test/server/event-loop.test.ts", "--reporter=verbose", "--silent=false"], {
      cwd: tree.dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const m = /event-loop delay over the heavy flow: p99 ([0-9.]+) ms, max ([0-9.]+) ms \((\d+) samples\)/.exec(log);
    if (m !== null) test = { p99Ms: Number(m[1]), maxMs: Number(m[2]), samples: Number(m[3]) };
  } catch (error) {
    console.error("event-loop test failed:", error);
  }

  const server = await startServer({ tree, port: Number(process.env.STORY_PROBE_PORT ?? 4610) });
  try {
    const base = server.baseUrl;
    let last = "";
    for (let s = 0; s < SESSIONS; s += 1) {
      const sessionId = await createSession(base, "expert", "training", { name: "Probe Expert", language: "en" });
      let seq = 0;
      for (const [caseId, action] of DECISIONS) {
        seq += 1;
        await openCase(base, sessionId, caseId, seq);
        await uploadFrame(base, sessionId, seq, schematicPng(640, 360, seq + s), 640, 360);
        await decide(base, sessionId, caseId, action);
      }
      const state = await debrief(base, sessionId);
      for (const p of state.proposals.slice(0, 2)) {
        await debriefAction(base, sessionId, { action: "confirm_candidate", candidateId: p.candidateId, decisionFamily: p.decisionFamily, quote: `Yes — ${p.text}, ${p.action}.` });
      }
      await api(base, `/api/sessions/${sessionId}/witnesses`, { method: "POST" });
      last = sessionId;
    }

    // Cold export of the last session (never exported before) while /api/health is sampled.
    const samples: number[] = [];
    let exporting = true;
    const sampler = (async () => {
      while (exporting) {
        const t = performance.now();
        await fetch(`${base}/api/health`).then((r) => r.text());
        samples.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const t0 = performance.now();
    await fetch(`${base}/api/sessions/${last}/workmap/export?format=json`).then((r) => r.text());
    const coldExportMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 1000));
    exporting = false;
    await sampler;

    const deepBody = await api<{ eventLoop?: { p50Ms: number; p99Ms: number; maxMs: number; samples: number; sinceMs: number } }>(base, "/api/health/deep", {
      headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
    });
    const cpu = cpus();
    const result = {
      measuredAt: new Date().toISOString(),
      commit: tree.commit,
      machine: `${cpu.length}× ${(cpu[0]?.model ?? "unknown CPU").trim()}`,
      where: "local production build (NODE_ENV=production, LLM_CALLS=off) on this machine — not the deployed service",
      test,
      probe: {
        sessions: SESSIONS,
        coldExportMs: Math.round(coldExportMs),
        healthSamples: samples.length,
        healthP50Ms: Math.round(pctl(samples, 50)),
        healthMaxMs: Math.round(Math.max(...samples)),
        deep: deepBody.eventLoop ?? null,
      },
      before: "docs/evidence/live/bugs/event-loop-stall-probe.txt (production, commit 1da6e3c)",
    };
    writeFileSync(join(out, "event-loop-local.json"), `${JSON.stringify(result, null, 2)}\n`);
    const txt = [
      `Event loop after the worker-thread fix — ${result.where}`,
      `measured ${result.measuredAt} · commit ${result.commit} · ${result.machine}`,
      "",
      test === null ? "event-loop test: no measurement line" : `apps/web/test/server/event-loop.test.ts (heavy flow through the real composition root): p99 ${test.p99Ms} ms, max ${test.maxMs} ms (${test.samples} samples), bound < 100 ms`,
      `HTTP probe: ${SESSIONS} expert sessions seeded (decisions, frames, confirmed rules, Z3 witness runs), then a cold Work Map export: ${result.probe.coldExportMs} ms`,
      `/api/health sampled every 250 ms during the export: n=${result.probe.healthSamples}, p50 ${result.probe.healthP50Ms} ms, max ${result.probe.healthMaxMs} ms`,
      result.probe.deep === null ? "/api/health/deep: no eventLoop field" : `/api/health/deep eventLoop since boot: p50 ${result.probe.deep.p50Ms} · p99 ${result.probe.deep.p99Ms} · max ${result.probe.deep.maxMs} ms (${result.probe.deep.samples} samples)`,
      "",
      `Before the fix (production): ${result.before}`,
    ].join("\n");
    writeFileSync(join(out, "event-loop-local.txt"), `${txt}\n`);
    console.info(txt);
    console.info(`→ ${rel(join(out, "event-loop-local.json"))}`);
  } finally {
    await server.stop();
  }
}

await main();
