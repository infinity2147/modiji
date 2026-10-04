/**
 * Every number the deck, the narration and the video cards show is read here, from a committed evidence
 * file, together with the repo-relative path it came from. Nothing is typed in by hand: re-running the
 * story scripts after new evidence lands updates the numbers. A missing file or an unmatched pattern
 * fails loudly instead of falling back to a default.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE, REPO, VIDEO_DIR, grab, isTracked, must, newest, readCommitted, readJson, readText, rel } from "./repo";

/** A shown value and the file it came from. */
export type Fact = { text: string; source: string };
const fact = (text: string, source: string): Fact => ({ text, source });

const pct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;
const f3 = (x: number): string => x.toFixed(3);
const f2 = (x: number): string => x.toFixed(2);

type Metrics = { fidelity: number; unsafeFnRate: number; guardrailRecall: number; questions: number; interruptions: number; rulesRecovered: number };
type BenchRow = { strategy: string; seed: number; budget: number; expert: { noise: number; vagueness: number }; metrics: Metrics };
type BenchMain = { strategy: string; budget: number; n: number; mean: Metrics; std: Metrics };
type BenchResults = { simulatedExpert: boolean; config: { seeds: number[]; heldoutSize: number; trainingSize: number }; oracle: { policy: string }; rows: BenchRow[]; main: BenchMain[] };
type Check = { metric: string; value: number; comparator: string; threshold: number; pass: boolean };
type EvalReport = { report: { checks: Check[]; nonCritical: { f1: number } } };
type PreflightResult = { id: string; status: string; detail: string; facts?: Record<string, unknown> };
type Preflight = { startedAt: string; target: string; exitCode: number; summary: { pass: number; fail: number }; results: PreflightResult[] };
type Manifest = {
  manifest: {
    bundleId: string;
    exportedAt: number;
    source: { baseUrl: string };
    sessions: { id: string; entries: number; conversationIds: string[] }[];
    timeline: { entries: number; head: string };
    files: Record<string, { bytes: number }>;
    missing: { ref: string; reason: string }[];
  };
};

function benchFacts() {
  const file = must(join(EVIDENCE, "bench/results.json"));
  const src = rel(file);
  const r = readJson<BenchResults>(file);
  const main = (strategy: string, budget: number): BenchMain => {
    const row = r.main.find((m) => m.strategy === strategy && m.budget === budget);
    if (row === undefined) throw new Error(`bench: no main row ${strategy}@${budget} in ${src}`);
    return row;
  };
  const unsafeSeeds = (strategy: string, budget: number): string => {
    const rows = r.rows.filter((x) => x.strategy === strategy && x.budget === budget && x.expert.noise === 0 && x.expert.vagueness === 0);
    return `${rows.filter((x) => x.metrics.unsafeFnRate > 0).length}/${rows.length}`;
  };
  const a0 = main("A", 0);
  const d8 = main("D", 8);
  const d24 = main("D", 24);
  const b16 = main("B", 16);
  const b24 = main("B", 24);
  const c24 = main("C", 24);
  const d2 = main("D", 2);
  return {
    source: src,
    simulated: r.simulatedExpert,
    seeds: fact(String(r.config.seeds.length), src),
    heldout: fact(String(r.config.heldoutSize), src),
    observed: fact(String(r.config.trainingSize), src),
    policy: fact(r.oracle.policy, src),
    floorFidelity: fact(f3(a0.mean.fidelity), src),
    floorUnsafe: fact(pct(a0.mean.unsafeFnRate), src),
    floorGuardrail: fact(pct(a0.mean.guardrailRecall), src),
    d8Fidelity: fact(f3(d8.mean.fidelity), src),
    d8Unsafe: fact(pct(d8.mean.unsafeFnRate), src),
    d8Questions: fact(d8.mean.questions.toFixed(0), src),
    dPlateauQuestions: fact(d24.mean.questions.toFixed(1), src),
    dPlateauInterruptions: fact(d24.mean.interruptions.toFixed(1), src),
    dPlateauFidelity: fact(f3(d24.mean.fidelity), src),
    dPlateauUnsafe: fact(pct(d24.mean.unsafeFnRate), src),
    b16Questions: fact(b16.mean.questions.toFixed(0), src),
    b24Questions: fact(b24.mean.questions.toFixed(0), src),
    bFidelity: fact(f3(b24.mean.fidelity), src),
    bUnsafe: fact(pct(b16.mean.unsafeFnRate), src),
    cFidelity: fact(f3(c24.mean.fidelity), src),
    cUnsafe: fact(pct(c24.mean.unsafeFnRate), src),
    d2Guardrail: fact(pct(d2.mean.guardrailRecall), src),
    unsafeSeedsD24: fact(unsafeSeeds("D", 24), src),
    unsafeSeedsB24: fact(unsafeSeeds("B", 24), src),
    chartUnsafe: must(join(EVIDENCE, "bench/unsafe-vs-questions.svg")),
    chartFidelity: must(join(EVIDENCE, "bench/fidelity-vs-questions.svg")),
    report: rel(must(join(EVIDENCE, "bench/report.md"))),
  };
}

function liveFacts() {
  const summary = must(join(EVIDENCE, "live/SUMMARY.txt"));
  const s = readText(summary);
  const src = rel(summary);
  const [interruptions, threshold] = grab(s, /TOTAL interruptions across the 5 runs: (\d+) \(threshold (\d+)\)/, src);
  const [gP50, gP95, gMax, gN] = grab(s, /Gate decision latency \(decidedAt − becameValidAt\), all 5 runs: p50 (\d+) · p95 (\d+) · max (\d+) ms \(n=(\d+)\)/, src);
  const [rP50, rP95, rMax] = grab(s, /Including the gate\/authorize round trip to production: p50 (\d+) · p95 (\d+) · max (\d+) ms/, src);
  const [aP50, aP95, aMax, aN] = grab(s, /First audio \(control message sent → agent audio on the WebRTC track\): p50 (\d+) · p95 (\d+) · max (\d+) ms \(n=(\d+)\)/, src);
  const [authorized, spoken] = grab(s, /Questions authorized (\d+), spoken (\d+)/, src);
  const acceptance = must(join(EVIDENCE, "live/ACCEPTANCE.txt"));
  const acc = readText(acceptance);
  const accSrc = rel(acceptance);
  const [window] = grab(acc, /LIVE acceptance runs against production \(.*?\), (2026-10-04 [0-9:–]+ UTC)/, accSrc);
  const [voice] = grab(acc, /voice "([^"]+)"/, accSrc);
  const p4checks = must(join(EVIDENCE, "live/p4/p4-checks-f77499f8-9078-4ea1-9beb-00fd5a335d93.txt"));
  const p4 = readText(p4checks);
  const p4Src = rel(p4checks);
  const [pepQuote] = grab(p4, /require_approval.*\n.*\n\s+quote="([^"]+)"/, p4Src);
  const [thresholdQuote] = grab(p4, /quote="(Anything over 25%[^"]+)"/, p4Src);
  const allTrue = /guardrail\/exception confirmed: true/.test(p4) && /unresolved concept surfaced: true/.test(p4) && /every promoted rule passes evidence validation: true/.test(p4);
  const agent = must(join(EVIDENCE, "live/p8/agent-blocked-live.txt"));
  const ag = readText(agent);
  const agSrc = rel(agent);
  const [agentStarted] = grab(ag, /# started (\S+) against/, agSrc);
  const [agentModel] = grab(ag, /^Claude \(([^)]+)\):/m, agSrc);
  const [blockedQuote] = grab(ag, /^BLOCKED: "([^"]+)"/m, agSrc);
  const [blockedRule, revision] = grab(ag, /← forbid \(rulebook revision (\d+)\): Blocked by rule (\S+):/, agSrc).reverse();
  const [agentCase] = grab(ag, /^Case (NS-\d{4}-\d{4})/m, agSrc);
  const roundtrip = must(join(EVIDENCE, "live/p8/exports-roundtrip.txt"));
  const rt = readText(roundtrip);
  const [agree] = grab(rt, /MCP check_action vs local checkAction over \/api\/rulebook: (\d+\/\d+) agree/, rel(roundtrip));
  return {
    window: fact(window ?? "", accSrc),
    syntheticVoice: fact(`synthetic voice input (ElevenLabs TTS, voice “${voice ?? ""}”)`, accSrc),
    interruptions: fact(interruptions ?? "", src),
    interruptionThreshold: fact(threshold ?? "", src),
    gateDecision: fact(`p50 ${gP50} · p95 ${gP95} · max ${gMax} ms (n=${gN})`, src),
    gateP95: fact(`${gP95} ms`, src),
    roundTrip: fact(`p50 ${rP50} · p95 ${rP95} · max ${rMax} ms`, src),
    roundTripP95: fact(`${rP95} ms`, src),
    firstAudio: fact(`p50 ${aP50} · p95 ${aP95} · max ${aMax} ms (n=${aN})`, src),
    firstAudioP50: fact(`${aP50} ms`, src),
    asked: fact(`${authorized} authorized · ${spoken} spoken`, src),
    p4Met: fact(allTrue ? "met by voice on all four criteria" : "NOT met", p4Src),
    pepQuote: fact(pepQuote ?? "", p4Src),
    thresholdQuote: fact(thresholdQuote ?? "", p4Src),
    agentStarted: fact(agentStarted ?? "", agSrc),
    agentModel: fact(agentModel ?? "", agSrc),
    agentCase: fact(agentCase ?? "", agSrc),
    blockedQuote: fact(blockedQuote ?? "", agSrc),
    blockedRule: fact(blockedRule ?? "", agSrc),
    rulebookRevision: fact(revision ?? "", agSrc),
    agentTranscript: ag,
    agentSource: agSrc,
    mcpAgree: fact(agree ?? "", rel(roundtrip)),
  };
}

function preflightFacts() {
  const file = newest(EVIDENCE, /^preflight-.*\.json$/, (abs) => {
    const p = readJson<Preflight>(abs);
    // The newest FULL green run (every check, not a partial `--only` re-run).
    return p.exitCode === 0 && p.results.length >= 9 && p.results.some((r) => r.id === "voice-skip-turn" && r.status === "pass");
  });
  const src = rel(file);
  const p = readJson<Preflight>(file);
  const byId = (id: string): PreflightResult => {
    const r = p.results.find((x) => x.id === id);
    if (r === undefined) throw new Error(`preflight ${src}: no ${id}`);
    return r;
  };
  const voice = byId("voice-skip-turn");
  const [quietMs, textMs, audioMs] = grab(voice.detail, /silent for (\d+) ms on an unauthorised turn; authorised text after (\d+) ms, first audio after (\d+) ms/, src);
  const llm = byId("public-llm");
  const loop = /event-loop delay p99 ([0-9.]+) ms/.exec(byId("server-deep").detail);
  return {
    when: fact(p.startedAt, src),
    target: fact(p.target, src),
    green: fact(`${p.summary.pass}/${p.summary.pass + p.summary.fail} checks pass`, src),
    quiet: fact(`${Number(quietMs) / 1000} s`, src),
    authorisedText: fact(`${textMs} ms`, src),
    firstAudio: fact(`${audioMs} ms`, src),
    publicLlm: fact(llm.detail, src),
    voiceDetail: fact(voice.detail, src),
    eventLoopP99: loop?.[1] === undefined ? null : fact(`${loop[1]} ms`, src),
    results: p.results.map((r) => ({ id: r.id, status: r.status, detail: r.detail })),
    source: src,
  };
}

function perceptionFacts() {
  const run4 = must(join(EVIDENCE, "p2/eval-live-4.json"));
  const base = must(join(EVIDENCE, "p2/eval-live.json"));
  const checks4 = readJson<EvalReport>(run4).report.checks;
  const checks0 = readJson<EvalReport>(base).report.checks;
  const fmt = (c: Check): string => (c.metric.includes("ms") ? `${(c.value / 1000).toFixed(1)} s` : f3(c.value));
  const thr = (c: Check): string => `${c.comparator === ">=" ? "≥" : "≤"} ${c.metric.includes("ms") ? `${c.threshold / 1000} s` : c.threshold}`;
  const rows = checks4.map((c, i) => {
    const b = checks0[i];
    return { metric: c.metric, baseline: b === undefined ? "—" : fmt(b), final: fmt(c), threshold: thr(c), pass: c.pass };
  });
  const e2e = must(join(EVIDENCE, "p2/e2e-latency.json"));
  const mc = readJson<{ monteCarlo: { p95: number } }>(e2e).monteCarlo;
  return { rows, source: rel(run4), baselineSource: rel(base), passed: rows.filter((r) => r.pass).length, total: rows.length, e2eP95: fact(`${(mc.p95 / 1000).toFixed(1)} s`, rel(e2e)) };
}

function replayFacts() {
  const file = newest(join(REPO, "docs/replay"), /\.manifest\.json$/);
  const src = rel(file);
  const m = readJson<Manifest>(file).manifest;
  const audio = Object.keys(m.files).filter((p) => p.startsWith("audio/"));
  return {
    bundleId: fact(m.bundleId, src),
    entries: fact(String(m.timeline.entries), src),
    head: fact(m.timeline.head.slice(0, 12), src),
    sessions: fact(String(m.sessions.length), src),
    files: fact(String(Object.keys(m.files).length), src),
    audio: fact(`${audio.length} recorded conversation${audio.length === 1 ? "" : "s"}`, src),
    host: fact(new URL(m.source.baseUrl).host, src),
    missing: m.missing,
    source: src,
  };
}

function progressFacts() {
  const src = "PROGRESS.md";
  const t = readCommitted(src);
  const [interlock] = grab(t, /blocked \*\*(\d+\/\d+) violating commits\*\*/, src);
  const [practice] = grab(t, /Z3 generated cases at ([0-9.]+ \/ [0-9.]+ \/ [0-9.]+%) owner share/, src);
  const [teachbackLatency, teachbackWords] = grab(readText(must(join(EVIDENCE, "p5/teachback-live.txt"))), /latency: (\d+) ms[\s\S]*?words: (\d+)/, "docs/evidence/p5/teachback-live.txt");
  const [witnesses] = grab(t, /Z3 found (3 unresolved cells and 1 boundary)/, src);
  const hindiPending = /The live ASR run \(`docs\/evidence\/p10\/hindi-run\.\{json,txt\}`\) is pending/.test(t);
  const hygiene = must(join(EVIDENCE, "hygiene/e2e-isolated-2x.txt"));
  const hy = readText(hygiene);
  const passes = [...hy.matchAll(/^(\d+) passed \(/gm)].map((m) => m[1] ?? "");
  return {
    interlock: fact(interlock ?? "", src),
    practice: fact(practice ?? "", src),
    witnesses: fact(witnesses ?? "", src),
    teachback: fact(`Opus, ${Number(teachbackLatency) / 1000} s, ${teachbackWords} words`, "docs/evidence/p5/teachback-live.txt"),
    hindiPending,
    e2e: fact(`${passes.join(" + ")} e2e tests passed in two back-to-back isolated runs`, rel(hygiene)),
  };
}

function eventLoopFacts() {
  const probe = must(join(EVIDENCE, "live/bugs/event-loop-stall-probe.txt"));
  const t = readText(probe);
  const src = rel(probe);
  const [coldExport] = grab(t, /COLD Work Map export[\s\S]*?export json 200 total ([0-9.]+)s/, src);
  const probe2 = t.slice(t.indexOf("# Probe 2"));
  const samples = [...probe2.matchAll(/^\d{13} 200 ([0-9.]+)$/gm)].map((m) => Number(m[1]));
  const worst = [...samples].sort((a, b) => b - a).slice(0, 2);
  const bugs = must(join(EVIDENCE, "live/bugs/BUGS.txt"));
  const [gaps] = grab(readText(bugs), /in-handler gaps between the gate\.authorized row timestamp and nonce issuance: ([0-9, ]+) ms/, rel(bugs));
  const gapMax = Math.max(...(gaps ?? "").split(",").map((x) => Number(x.trim())));
  const before = {
    coldExport: fact(`${Number(coldExport).toFixed(1)} s`, src),
    healthWorst: fact(worst.map((x) => `${x.toFixed(1)} s`).join(" and "), src),
    handlerGapMax: fact(`${(gapMax / 1000).toFixed(1)} s`, rel(bugs)),
  };
  // After the worker-thread fix (commit 1b0c089): measured on this machine by scripts/story/event-loop-probe.ts.
  const localFile = join(VIDEO_DIR, "evidence/event-loop-local.json");
  if (!existsSync(localFile)) return { before, after: null };
  type Local = {
    measuredAt: string;
    commit: string;
    machine: string;
    test: { p99Ms: number; maxMs: number; samples: number } | null;
    probe: { coldExportMs: number; healthMaxMs: number; healthP50Ms: number; healthSamples: number; deep: { p50Ms: number; p99Ms: number; maxMs: number } | null };
  };
  const l = readJson<Local>(localFile);
  const lsrc = rel(localFile);
  return {
    before,
    after: {
      measuredAt: fact(l.measuredAt, lsrc),
      commit: fact(l.commit, lsrc),
      machine: fact(l.machine, lsrc),
      test: l.test === null ? null : fact(`p99 ${l.test.p99Ms} ms · max ${l.test.maxMs} ms (${l.test.samples} samples)`, lsrc),
      testMax: l.test === null ? null : fact(`${l.test.maxMs} ms`, lsrc),
      coldExport: fact(`${(l.probe.coldExportMs / 1000).toFixed(2)} s`, lsrc),
      healthMax: fact(`${l.probe.healthMaxMs} ms`, lsrc),
      healthP50: fact(`${l.probe.healthP50Ms} ms`, lsrc),
      healthSamples: fact(String(l.probe.healthSamples), lsrc),
      deep: l.probe.deep === null ? null : fact(`p50 ${l.probe.deep.p50Ms} · p99 ${l.probe.deep.p99Ms} · max ${l.probe.deep.maxMs} ms`, lsrc),
    },
  };
}

/** The live re-run on the fixed build (docs/evidence/live/rerun-*), if committed; null otherwise. */
function rerunFacts() {
  const live = join(EVIDENCE, "live");
  const name = readdirSync(live)
    .filter((n) => n.startsWith("rerun-") && isTracked(join(live, n, "SUMMARY.txt")))
    .sort()
    .at(-1);
  if (name === undefined) return null;
  const dir = join(live, name);
  const sum = join(dir, "SUMMARY.txt");
  const acc = join(dir, "ACCEPTANCE.txt");
  const s = readText(sum);
  const a = readText(acc);
  const src = rel(sum);
  const asrc = rel(acc);
  const [interruptions, authorized, spoken] = grab(s, /ALL 5 P3 runs: interruptions (\d+); authorized (\d+), spoken (\d+)/, src);
  const all = s.slice(s.indexOf("ALL 5 P3 runs"));
  const [gP50, gP95, gMax, gN] = grab(all, /gate decision \(decidedAt − becameValidAt\) p50 (\d+) · p95 (\d+) · max (\d+) ms \(n=(\d+)\)/, src);
  const [aP50, aP95, aN] = grab(all, /first audio \(control sent → agent audio on track\) p50 (\d+) · p95 (\d+) · max \d+ ms \(n=(\d+)\)/, src);
  const [within] = grab(a, /NOT MET strictly\. (\d+ of \d+) within the bound/, asrc);
  const [window] = grab(a, /(2026-10-04 [0-9:–]+ UTC)/, asrc);
  const hindiLive = /Hindi → English, live[\s\S]*?The chain WORKED end to end/.test(a);
  const progress = readCommitted("PROGRESS.md");
  const stall = /`eventLoop`: \*\*p50 ([0-9.]+) ms · p99 ([0-9.]+) ms · max ([0-9,]+) ms\*\*/.exec(progress);
  return {
    source: src,
    acceptance: asrc,
    window: fact(window ?? "", asrc),
    interruptions: fact(interruptions ?? "", src),
    asked: fact(`${authorized} authorized · ${spoken} spoken`, src),
    gateDecision: fact(`p50 ${gP50} · p95 ${gP95} · max ${gMax} ms (n=${gN})`, src),
    gateMaxSec: fact(`${(Number(gMax) / 1000).toFixed(1)} s`, src),
    within250: fact(within ?? "", asrc),
    firstAudio: fact(`p50 ${aP50} · p95 ${aP95} ms (n=${aN})`, src),
    firstAudioP50: fact(`${aP50} ms`, src),
    hindiLive,
    prodLoopP99: stall === null ? null : fact(`${stall[2]} ms`, "PROGRESS.md"),
    prodLoopMax: stall === null ? null : fact(`${(Number((stall[3] ?? "0").replace(/,/g, "")) / 1000).toFixed(1)} s`, "PROGRESS.md"),
  };
}

/** Plan text the deck quotes (thesis, claims, inventions, positioning matrix, pitch-safe numbers, moonshot). */
function planFacts() {
  const file = must(join(REPO, "plan.md"));
  const t = readText(file);
  const src = rel(file);
  const section = (heading: RegExp): string => {
    const start = t.search(heading);
    if (start < 0) throw new Error(`plan.md: no section ${heading}`);
    const rest = t.slice(start);
    const next = rest.slice(1).search(/\n#{2,3} /);
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  const [thesis] = grab(t, /\*\*Thesis line:\*\* \*([^*]+)\*/, src);
  const [oneLiner] = grab(t, /\*\*One-liner:\*\* (.+)/, src);
  const claims = [...section(/## 0\. Technical thesis/).matchAll(/^- \*\*([^*]+)\*\*:? ?(.+)$/gm)].map((m) => ({ title: (m[1] ?? "").replace(/:$/, ""), body: (m[2] ?? "").replace(/^:\s*/, "") }));
  const inventions = [...section(/## 4\. The product — four inventions/).matchAll(/^\d\. \*\*([^*]+)\*\*(.*)$/gm)].map((m) => ({ title: m[1] ?? "", body: (m[2] ?? "").replace(/^[:\s]+/, "") }));
  const [macro] = grab(section(/### 2\.3 Pitch-safe numbers/), /^- Brief's own macro story: (.+)$/m, src);
  const [adjacency] = grab(section(/### 2\.3 Pitch-safe numbers/), /^- At most one adjacency slide: (.+)$/m, src);
  const matrixLines = section(/### 2\.4 Positioning matrix/)
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[-| ]+\|$/.test(l));
  const cells = (l: string): string[] => l.split("|").slice(1, -1).map((c) => c.trim().replace(/\*\*/g, ""));
  const [header, ...rows] = matrixLines.map(cells);
  const moonshot = section(/## 14\. Moonshot/).split("\n").slice(1).join(" ").trim();
  const [trustClaim] = grab(t, /Claim: \*"([^"]+)"\*/, src);
  return {
    source: src,
    thesis: fact(thesis ?? "", src),
    oneLiner: fact(oneLiner ?? "", src),
    claims,
    inventions,
    macro: (macro ?? "").replace(/\.$/, "").split("; ").map((m) => fact(m, `${src} §2.3 (the brief's macro story)`)),
    adjacency: fact(adjacency ?? "", `${src} §2.3`),
    matrix: { header: header ?? [], rows },
    moonshot: fact(moonshot, `${src} §14`),
    trustClaim: fact(trustClaim ?? "", `${src} §7.8`),
  };
}

export function loadEvidence() {
  return {
    plan: planFacts(),
    bench: benchFacts(),
    live: liveFacts(),
    preflight: preflightFacts(),
    perception: perceptionFacts(),
    replay: replayFacts(),
    progress: progressFacts(),
    eventLoop: eventLoopFacts(),
    rerun: rerunFacts(),
  };
}
export type Evidence = ReturnType<typeof loadEvidence>;

/** Short helpers for the renderers. */
export const fmt = { pct, f2, f3 };
