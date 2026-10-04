/**
 * `pnpm story:deck` — the judges' deck, built from the committed evidence.
 *
 * Reads docs/evidence/** (bench results + SVG charts, live acceptance summaries, preflight JSON, p1–p11
 * screenshots), docs/replay/*.manifest.json, PROGRESS.md and plan.md through lib/evidence.ts, and writes:
 *   docs/deck/deck.html          one self-contained file (inline CSS, fonts, SVG, images as data URIs; light/dark)
 *   docs/deck/deck.pdf           16:9 at 1920×1080, printed by Playwright's Chromium (light theme)
 *   docs/deck/speaker-notes.md   talking points per slide, with every source file cited
 * Re-running after new evidence updates every number. `--no-pdf` skips the PDF.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { architectureSvg } from "./lib/architecture";
import { loadEvidence, type Fact } from "./lib/evidence";
import { TOKENS, esc, fontFaces, md, productName } from "./lib/html";
import { playwright } from "./lib/playwright";
import { DECK_DIR, EVIDENCE, dataUri, must, rel } from "./lib/repo";

type Slide = { id: string; title: string; body: string; notes: string[]; sources: Set<string> };

const ev = loadEvidence();
const NAME = productName();
const slides: Slide[] = [];
let current: Slide | undefined;

function slide(id: string, title: string, build: () => { body: string; notes: string[] }): void {
  current = { id, title, body: "", notes: [], sources: new Set() };
  const { body, notes } = build();
  current.body = body;
  current.notes = notes;
  slides.push(current);
  current = undefined;
}
/** A fact's text, with its source recorded on the slide being built. */
function c(f: Fact): string {
  current?.sources.add(f.source.replace(/ §.*$/, ""));
  return esc(f.text);
}
function src(path: string): string {
  current?.sources.add(path);
  return path;
}
function img(path: string, alt: string, cls = "shot"): string {
  const abs = must(join(EVIDENCE, path));
  src(rel(abs));
  return `<figure class="${cls}"><img src="${dataUri(abs)}" alt="${esc(alt)}"/><figcaption>${esc(alt)} · <span class="mono">${esc(rel(abs))}</span></figcaption></figure>`;
}
const badge = (kind: "ok" | "bad" | "warn" | "violet" | "accent", text: string): string => {
  const icon = kind === "ok" ? "✓" : kind === "bad" ? "✗" : kind === "warn" ? "!" : kind === "violet" ? "↺" : "•";
  return `<span class="badge ${kind}"><span aria-hidden="true">${icon}</span> ${esc(text)}</span>`;
};
const stat = (value: string, label: string, sub = ""): string => `<div class="stat"><div class="v">${value}</div><div class="l">${label}</div>${sub === "" ? "" : `<div class="s">${sub}</div>`}</div>`;

/* ---------------------------------------------------------------------------------------------- */

slide("hook", "The problem", () => ({
  body: `
  <div class="kicker">Hack-Nation · Challenge 01 · “The AI Apprentice” · ElevenLabs</div>
  <h1 class="brand">${esc(NAME)}</h1>
  <p class="lede">${c(ev.plan.oneLiner)}</p>
  <div class="grid3 macro">
    ${ev.plan.macro.map((m) => `<div class="card big"><div class="num">${c(m)}</div></div>`).join("")}
  </div>
  <p class="foot-note">The brief's macro story (as recorded in plan.md §2.3). When a senior reviewer retires, a screen recording keeps the clicks — not the thresholds, exceptions and stop-rules behind them.</p>`,
  notes: [
    "Open with the brief's hand-over problem: a senior expert's judgment has to reach a new hire before the expert leaves.",
    "Name the gap in one line: recorders capture what happened; we learn the decision boundary behind it.",
    "The three macro numbers are the brief's own (plan.md §2.3 lists them as pitch-safe). Use no other market numbers here.",
    "TODO (team): the brief's exact Sabine/Lena wording is not in the repo; insert it here verbatim if you want it on the slide.",
  ],
}));

slide("thesis", "Thesis", () => ({
  body: `
  <h2 class="thesis">${c(ev.plan.thesis).replace(/\. /g, ".<br/>")}</h2>
  <div class="grid3">
    <div class="card"><h3><span class="tag model">LLMs infer</span></h3><p>Candidate rules and latent concepts, answer parsing, question phrasing, teach-back prose. Never authoritative.</p></div>
    <div class="card"><h3><span class="tag ok">Experts confirm</span></h3><p>A rule is promoted only with the expert's <strong>exact words</strong>, tied to the screen frame they were said over.</p></div>
    <div class="card"><h3><span class="tag accent">Code enforces</span></h3><p>When to speak (gate + nonce), three-valued rule evaluation, Z3 counterexamples, the Save interlock, exports.</p></div>
  </div>
  <h3 class="sub">What we claim — precisely (plan.md §0)</h3>
  <ul class="claims">${ev.plan.claims.map((x) => `<li><strong>${esc(x.title)}.</strong> ${md(x.body)}</li>`).join("")}</ul>`,
  notes: [
    "The thesis is the architecture: models propose, the expert's own words confirm, deterministic code enforces.",
    "Read the coverage claim exactly: “No unresolved counterexample exists under the current feature model.” We never claim complete knowledge of the expert.",
    `Sources: ${src(ev.plan.source)} (header thesis line, §0).`,
  ],
}));

slide("loop", "The loop", () => {
  const steps = [
    ["1", "Capture", "The expert works real cases in CaseDesk while sharing the screen; voice is optional and labelled.", "screen · DOM (disclosed) · voice"],
    ["2", "Ask at the right moment", "A deterministic gate waits for silence, an idle screen and no typing; the engine picks the question with the highest expected information gain.", "invention ① surprise + EIG"],
    ["3", "Debrief", "Z3 searches the confirmed rulebook for valid cases it leaves unresolved or contradictory; the expert answers; a teach-back is confirmed or corrected.", "invention ② counterexample closure"],
    ["4", "Teach", "On an unseen case the tutor intervenes as soon as the wrong outcome is chosen; the Save interlock runs the same rules before commit.", "invention ③ hybrid interception"],
    ["5", "Guard agents", "The same rulebook is served as MCP check_action: an AI agent is blocked with the expert's quote.", "invention ④ one rulebook, two consumers"],
  ];
  return {
    body: `
    <div class="loop">${steps
      .map(
        ([n, t, d, inv]) =>
          `<div class="step"><div class="n">${n}</div><h3>${esc(t ?? "")}</h3><p>${esc(d ?? "")}</p><div class="inv">${esc(inv ?? "")}</div></div>`,
      )
      .join('<div class="arrow" aria-hidden="true">→</div>')}</div>
    <div class="grid4 inventions">${ev.plan.inventions.map((x, i) => `<div class="card"><div class="inv-n">${"①②③④"[i] ?? ""}</div><h3>${esc(x.title)}</h3><p>${md(x.body)}</p></div>`).join("")}</div>
    <p class="foot-note">Plus <strong>Apprentice-Bench</strong>: a deterministic hidden-policy oracle to measure the loop (plan.md §4, §9).</p>`,
    notes: [
      "Walk the loop left to right; each step maps to one of the four inventions (plan.md §4).",
      "Emphasise what is code: the gate, Z3, the interlock and the MCP check are deterministic; models only propose and phrase.",
      `Sources: ${src(ev.plan.source)} §1, §4, §7.`,
    ],
  };
});

slide("architecture", "How it works", () => ({
  body: `<div class="arch">${architectureSvg("auto").replace(/<svg /, '<svg class="archsvg" ')}</div>`,
  notes: [
    "Plan.md §5 flow, coloured by who decides. Blue boxes are deterministic code; orange is model output; violet is code + model where code decides.",
    "The custom-LLM wrapper is deliberately thin: without a valid, unexpired, unused nonce it streams skip_turn.",
    "Everything lands in an append-only ledger with parent provenance; control turns are system_control and never become evidence.",
    `Sources: ${src(ev.plan.source)} §5; diagram generated by scripts/story/lib/architecture.ts.`,
  ],
}));

slide("proof-gate", "Live proof · it asks at the right moment", () => ({
  body: `
  <div class="split">
    <div>${img("live/p3/run-e-budget-engineering-view-e0ca4cd6-0101-4cc0-9014-33a0720adbeb.png", "Production run E: gate conditions, question queue with EIG, live budget")}</div>
    <div class="col">
      ${stat(c(ev.live.gateP95), "gate decision p95 after conditions became valid (first live runs)", c(ev.live.gateDecision))}
      ${stat(c(ev.live.firstAudioP50), "first agent audio p50 after the authorised control message (first live runs)", c(ev.live.firstAudio))}
      ${stat(c(ev.preflight.quiet), "silence on an unauthorised turn, end to end through ElevenLabs", `preflight ${c(ev.preflight.green)} · ${c(ev.preflight.when)}`)}
      <p class="small">${c(ev.live.asked)} questions in 5 live runs, ${c(ev.live.window)}.</p>
      ${
        ev.rerun === null
          ? `<p class="small warn-text">Not met: ${c(ev.live.interruptions)} interruptions (target ${c(ev.live.interruptionThreshold)}), all in the noisy-murmur run D. See “What we missed”.</p>`
          : `<p class="small">First live runs: ${c(ev.live.interruptions)} interruptions, all in the noisy-murmur run D → fixes → <strong>re-run on the fixed build: ${c(ev.rerun.interruptions)} interruptions</strong> (${c(ev.rerun.asked)}, ${c(ev.rerun.window)}).</p>
      <p class="small warn-text">Re-run gate decision: ${c(ev.rerun.within250)} within 250 ms; 3 held or refused authorizations waited up to ${c(ev.rerun.gateMaxSec)} behind slow production round trips.</p>`
      }
      <p class="label-synth">Expert speech in these runs: ${c(ev.live.syntheticVoice)}.</p>
    </div>
  </div>`,
  notes: [
    "This is production (Railway), not a mock: the screenshot is the engineering view from live run E.",
    `Gate decision latency ${ev.live.gateDecision.text}; first audio ${ev.live.firstAudio.text}.`,
    `Preflight: ${ev.preflight.voiceDetail.text}.`,
    `Be upfront: the first live runs had ${ev.live.interruptions.text} interruptions in run D (quiet murmurs ElevenLabs VAD scored below the gate's 0.4 threshold). Fixes landed in 1b0c089/f317447.`,
    ev.rerun === null ? "The live re-run is pending." : `Re-run on the fixed build (${ev.rerun.window.text}): ${ev.rerun.interruptions.text} interruptions; gate decision ${ev.rerun.gateDecision.text} — ${ev.rerun.within250.text} within 250 ms, outliers behind slow production round trips (${ev.rerun.acceptance}).`,
    "Expert speech was synthetic voice input (ElevenLabs TTS) — say so.",
  ],
}));

slide("proof-rules", "Live proof · the expert's words become rules", () => ({
  body: `
  <div class="split">
    <div class="col">
      <p class="small">Promoted live, by voice, from the expert's exact words (P4 ${c(ev.live.p4Met)}):</p>
      <blockquote>“${c(ev.live.thresholdQuote)}.” <span class="rule">→ uboOwnershipPct &gt; 25 ∧ ¬uboVerified ⇒ enhanced review</span></blockquote>
      <blockquote>“${c(ev.live.pepQuote)}” <span class="rule">→ require compliance sign-off when PEP</span></blockquote>
      <blockquote>“${c(ev.live.blockedQuote)}” <span class="rule">→ forbid approve when high-risk ∧ &lt; 24 months</span></blockquote>
      <p class="small">Debrief (e2e): ${c(ev.progress.witnesses)} from Z3 → typed answers → teach-back corrected (rule revised, solver reran) → coverage closed. Live teach-back smoke: ${c(ev.progress.teachback)}.</p>
      <p class="label-synth">Coverage closure on the right is the e2e run (typed answers, template teach-back). In the recorded live run the debrief was not completed.</p>
    </div>
    <div class="stack2">
      ${img("p5/debrief-coverage-closed.png", "Debrief: coverage under current model, closed", "shot crop-top")}
      ${img("p5/workmap-lineage.png", "Work Map lineage: frame → event → decision → candidate → witness → question → rule", "shot crop-top")}
    </div>
  </div>`,
  notes: [
    "Left: three rules promoted in production from spoken answers. Each carries the exact quote, a real frame and provenance human_voice.",
    "Right: the debrief closes coverage only when all four criteria hold; then and only then the UI says “No unresolved counterexample exists under the current feature model.”",
    "Honest scope: coverage closure is shown from the e2e run with typed answers; the live voice debrief has not been run end to end.",
    "The Work Map is built by code; the lineage trace walks the ledger's parent links.",
  ],
}));

slide("proof-transfer", "Live proof · transfer to a novice and to an agent", () => ({
  body: `
  <div class="split">
    <div>${img("p6/intervention-card-before-save.png", "Unseen case NS-2026-0201: the tutor intervenes on selection, before Save")}</div>
    <div class="col">
      <div class="terminal"><div class="term-h">Real Claude (${c(ev.live.agentModel)}) → production /mcp · ${c(ev.live.agentStarted)}</div>
<pre>→ check_action {"proposedAction":"approve", case ${c(ev.live.agentCase)} …}
← forbid (rulebook revision ${c(ev.live.rulebookRevision)}) by ${c(ev.live.blockedRule)}

BLOCKED: "${c(ev.live.blockedQuote)}"</pre></div>
      ${stat(c(ev.progress.interlock), "violating commits blocked by the Save interlock (property test, end to end)")}
      ${stat(c(ev.live.mcpAgree), "MCP check_action agrees with the local interlock (11 demo cases × 5 outcomes, production)")}
      <p class="small">The quote the agent receives is the production utterance from the live capture run.</p>
    </div>
  </div>`,
  notes: [
    "Left: the novice picks “Approve onboarding” on an unseen case; the guardrail monitor intervenes before Save; Save is then blocked by the deterministic interlock. Screenshot from the real stop-rule e2e flow (nothing intercepted).",
    `Right: a real Claude agent (${ev.live.agentModel.text}) calls check_action on production and is blocked with the expert's verbatim quote.`,
    `Interlock property test ${ev.progress.interlock.text}; MCP vs local check ${ev.live.mcpAgree.text}.`,
  ],
}));

slide("bench", "Apprentice-Bench · the money chart", () => ({
  body: `
  <div class="split wide-left">
    <figure class="chart"><img src="${dataUri(ev.bench.chartUnsafe)}" alt="Unsafe error rate vs number of expert questions, strategies A–D"/><figcaption>${esc(src(rel(ev.bench.chartUnsafe)))}</figcaption></figure>
    <div class="col">
      ${stat(`${c(ev.bench.floorUnsafe)} → ${c(ev.bench.d8Unsafe)}`, `unsafe approvals: record-only floor → ours (D) after ${c(ev.bench.d8Questions)} questions`, `fidelity ${c(ev.bench.floorFidelity)} → ${c(ev.bench.d8Fidelity)}`)}
      <div class="card honest"><h3>${badge("warn", "D vs B, honestly")}</h3>
        <p>Generic “why” after every step (B) reaches ${c(ev.bench.bUnsafe)} unsafe — but needs ${c(ev.bench.b16Questions)}–${c(ev.bench.b24Questions)} questions and as many interruptions. D plateaus at ${c(ev.bench.dPlateauQuestions)} questions (${c(ev.bench.dPlateauInterruptions)} interruptions) with ${c(ev.bench.dPlateauUnsafe)} unsafe and the best fidelity (${c(ev.bench.dPlateauFidelity)} vs ${c(ev.bench.bFidelity)}).</p>
        <p>B is safer than D at budgets ≥ 12. On ${c(ev.bench.unsafeSeedsD24)} seeds D never learns the adverse-media rule (it only co-fires with the high-risk rule): the schema-relative limit we state. With 2 questions guardrail recall dips below the floor (${c(ev.bench.d2Guardrail)} vs ${c(ev.bench.floorGuardrail)}).</p></div>
      <p class="label-synth">Simulated expert: a deterministic oracle (${c(ev.bench.policy)}, fictional) answers; ${c(ev.bench.seeds)} seeds × ${c(ev.bench.heldout)} held-out cases. Not a human-subject result.</p>
    </div>
  </div>`,
  notes: [
    "Unsafe false-negative rate (would approve when the hidden policy does not) versus expert questions asked, mean ± 1 s.d. over 5 seeds.",
    `Floor: record-only ${ev.bench.floorUnsafe.text}. Ours: ${ev.bench.d8Unsafe.text} after ${ev.bench.d8Questions.text} questions.`,
    `Say the loss out loud: B reaches ${ev.bench.bUnsafe.text} but costs ${ev.bench.b16Questions.text}–${ev.bench.b24Questions.text} questions/interruptions; seeds with any unsafe approval at budget 24: D ${ev.bench.unsafeSeedsD24.text}, B ${ev.bench.unsafeSeedsB24.text}.`,
    `Why-answers at vagueness 0 are exact rules — an upper bound that favours B (disclosed in ${ev.bench.report}).`,
  ],
}));

slide("trust", "Trust, privacy and verified replay", () => ({
  body: `
  <div class="grid2">
    <div class="col">
    <div class="card"><h3>Off the record</h3>
      <p>Mutes the mic first, stops frame capture, cancels queued uploads and advances the privacy epoch; the server refuses stale uploads (409).</p>
      <blockquote class="claim">“${c(ev.plan.trustClaim)}”</blockquote>
      <p class="small">The trigger phrase itself may reach the voice provider; only a marker is stored, never the words. Our agents set 30-day retention.</p></div>
    <div class="card"><h3>PII and data</h3>
      <p>Best-effort OCR blur on the client before upload. The sandbox is fully synthetic (fictional bank, people, countries) — that is the real privacy guarantee for the demo. Every rule needs expert sign-off; evidence is the expert's own words.</p></div>
    </div>
    <div class="col">
    <div class="card"><h3>Verified replay of a recorded run</h3>
      <p>Bundle <span class="mono">${c(ev.replay.bundleId)}</span>: ${c(ev.replay.entries)} ledger entries from ${c(ev.replay.sessions)} live sessions on ${c(ev.replay.host)}, ${c(ev.replay.audio)}. sha256 per file + hash chain (head <span class="mono">${c(ev.replay.head)}…</span>), re-verified on every load; one changed byte ⇒ refused. Same UI; nothing is written, no model or voice call.</p></div>
    ${img("p11/replay-intervention.png", "Verified replay UI (e2e bundle): violet banner, integrity ✓, the live components", "shot crop-top")}
    </div>
  </div>`,
  notes: [
    "Use the exact privacy claim from plan.md §7.8; do not say more.",
    "PII redaction is best-effort; the real guarantee here is that all data is synthetic.",
    `The replay bundle is a genuine production run (manifest ${ev.replay.source}); it is labelled “Verified replay of a recorded run” everywhere it appears.`,
    `Disclosed in its manifest: ${ev.replay.missing.map((m) => `${m.ref} — ${m.reason}`).join("; ")}.`,
  ],
}));

slide("stretch", "Stretch · two experts and Hindi → English", () => ({
  body: `
  <div class="split">
    <div>${img("p10/two-experts-disagreement.png", "Two experts: Z3 finds a valid case where their rulebooks disagree", "shot crop-top")}</div>
    <div class="col">
      <div class="card"><h3>Two experts</h3><p>Z3 searches both rulebooks for a valid case where they decide differently; each expert is asked; the resolution is a rule revision carrying <strong>both</strong> quotes. While open, only decision rules are held back — a forbid from either expert always applies (monotonic safety, property-tested).</p></div>
      <div class="card"><h3>Hindi → English</h3><p>Language detection is code; Sonnet translates; code checks the translation segments are verbatim and complete. Quotes are stored in the original with a labelled machine translation; the tutor speaks English.</p>
      <p>${ev.rerun?.hindiLive === true ? `${badge("ok", "Live Hindi run on production: end to end")} <span class="small">Synthetic Hindi voice → ElevenLabs ASR → verified translation → Hindi-quoted rule → MCP block (${esc(src(ev.rerun.acceptance))}).</span>` : `${badge("warn", "Live Hindi ASR run: pending")} <span class="small">Done: local build with real Sonnet on a scripted transcript + synthetic Hindi TTS audio.</span>`}</p></div>
    </div>
  </div>`,
  notes: [
    "Two experts: shown end to end in e2e through public APIs; screenshot from that run.",
    "Hindi: the local production build with real Sonnet ran on a scripted transcript with synthetic Hindi TTS; the live ASR run is still pending — say so.",
    `Source: ${src("PROGRESS.md")} (P10), docs/evidence/p10/**.`,
  ],
}));

slide("positioning", "Where we sit", () => {
  const { header, rows } = ev.plan.matrix;
  src(`${ev.plan.source}`);
  const cell = (v: string): string => (v === "✅" ? `<td class="yes">✓</td>` : v === "—" ? `<td class="no">—</td>` : `<td class="part">${esc(v)}</td>`);
  return {
    body: `
    <table class="matrix"><thead><tr>${header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r[0] === "Us" ? "us" : ""}"><th>${esc(r[0] === "Us" ? NAME : (r[0] ?? ""))}</th>${r.slice(1).map(cell).join("")}</tr>`).join("")}</tbody></table>
    <p class="foot-note">Adjacent categories are real and funded: ${c(ev.plan.adjacency)} We explore a different acquisition mechanism: active, screen-grounded interrogation of a live decision, counterexamples verified by the expert, and transfer tests.</p>`,
    notes: [
      "Matrix copied from plan.md §2.4 (pitch slide). Skan and Tacit are useful to our story, not threats to hide.",
      "Only the adjacency numbers listed in plan.md §2.3; no TAM forecasts or vendor self-reported metrics.",
    ],
  };
});

slide("measured", "What we measured — and what we missed", () => {
  const p2 = ev.perception;
  src(p2.source);
  src(p2.baselineSource);
  const el = ev.eventLoop;
  const after = el.after;
  type Row = [string, string, "ok" | "bad" | "warn", string];
  const rows: Row[] = [
    ["P2 vision (live, Haiku 4.5)", `${p2.passed}/${p2.total} thresholds met`, "bad", `${p2.rows.map((r) => `${r.metric.replace(" (ms)", "")} ${r.baseline} → ${r.final} (target ${r.threshold})`).join(" · ")}. Tutor and interlock use the disclosed DOM channel; team decision on options pending.`],
    ev.rerun === null
      ? ["P3 zero interruptions (5 live runs)", `${c(ev.live.interruptions)} interruptions`, "bad", "All in run D: quiet murmurs below the VAD threshold; a control message swallowed by an open user turn. Fixes landed; live re-run pending."]
      : ["P3 zero interruptions (5 live runs)", `${c(ev.rerun.interruptions)} in the re-run`, "ok", `First live runs: ${c(ev.live.interruptions)}, all in run D (quiet murmurs below the VAD threshold; a control message swallowed by an open user turn). Fixed (local onset detector, open-turn tracking, re-queue); re-run on the fixed build: ${c(ev.rerun.interruptions)} across 5 runs, ${c(ev.rerun.asked)}.`],
    ev.rerun === null
      ? ["P3 authorise ≤ 250 ms", `gate p95 ${c(ev.live.gateP95)}`, "ok", `Decision met; incl. the production round trip p95 ${c(ev.live.roundTripP95)}.`]
      : ["P3 authorise ≤ 250 ms", `${c(ev.rerun.within250)} in the re-run`, "warn", `First runs: p95 ${c(ev.live.gateP95)}. Re-run: ${c(ev.rerun.gateDecision)} — 3 held or refused authorizations behind slow production round trips. Not met strictly.`],
    ["P4 hypothesis engine, live by voice", "met", "ok", "Threshold rule, PEP guardrail, unresolved concept; every promoted rule passes evidence validation. Attempts 1–3 kept, with the bugs they found."],
    ["P5 counterexample closure", "met (e2e, typed)", "warn", "Live voice debrief not yet run end to end."],
    ["P6 tutor + Save interlock", `${c(ev.progress.interlock)} blocked`, "ok", "Intervention ledgered before Save; unseen case handled; Z3 practice cases."],
    ["P8 agent + exports (live)", `${c(ev.live.mcpAgree)} agree`, "ok", "Real Claude blocked with the expert's quote; Work Map/Procedure round-trip byte-identical."],
    ev.rerun?.hindiLive === true
      ? ["P10 two experts + Hindi live", "done", "ok", "Two experts in e2e; Hindi → English end to end on production (synthetic Hindi voice, real ASR, verified translation, Hindi-quoted rule, MCP block)."]
      : ["P10 Hindi live ASR", "pending", "warn", "Two experts met in e2e; Hindi done locally with real Sonnet on a scripted transcript."],
    [
      "Event loop (bug #6)",
      ev.rerun?.prodLoopMax != null ? `p99 ${c(ev.rerun.prodLoopP99 ?? ev.rerun.prodLoopMax)} · max ${c(ev.rerun.prodLoopMax)}` : ev.preflight.eventLoopP99 !== null ? `production p99 ${c(ev.preflight.eventLoopP99)}` : "fixed, not re-measured",
      ev.rerun?.prodLoopMax != null ? "warn" : "ok",
      `Before (production): /api/health stalled ${c(el.before.healthWorst)} during a cold Work Map export; handler gaps up to ${c(el.before.handlerGapMax)}. Worker threads landed in 1b0c089${ev.preflight.eventLoopP99 === null ? "" : `; production preflight ${c(ev.preflight.when)}: event-loop delay p99 ${c(ev.preflight.eventLoopP99)}`}${after === null || after.testMax === null ? "" : `; repo heavy-flow test on ${c(after.machine)}: worst block ${c(after.testMax)}`}.${ev.rerun?.prodLoopMax == null ? "" : ` After the live re-runs production showed one ${c(ev.rerun.prodLoopMax)} stall at p99 ${c(ev.rerun.prodLoopP99 ?? ev.rerun.prodLoopMax)}: diagnosed as a host-level freeze; mitigations listed, not yet verified.`}`,
    ],
  ];
  return {
    body: `
    <table class="results"><thead><tr><th>Acceptance</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>${rows.map(([what, result, kind, detail]) => `<tr><th>${esc(what)}</th><td>${badge(kind, result.replace(/<[^>]+>/g, ""))}</td><td>${detail}</td></tr>`).join("")}</tbody></table>
    <p class="foot-note">Numbers from ${esc(p2.source)}, docs/evidence/live/{ACCEPTANCE,SUMMARY}.txt, docs/evidence/live/bugs/*, PROGRESS.md${after === null ? "" : ", docs/video/evidence/event-loop-local.json"}. Thresholds were never moved to pass.</p>`,
    notes: [
      `P2 live vision missed every threshold (final run: ${p2.rows.map((r) => `${r.metric} ${r.final}`).join(", ")}). Disclose the DOM channel; the options are a team decision (PROGRESS.md P2).`,
      `P3: ${ev.live.interruptions.text} interruptions, all in run D; fixes landed after the runs, re-run pending.`,
      "Everything else listed as met has its evidence file; ‘pending’ means not yet run, not failed.",
      after === null ? "Event loop: no post-fix measurement yet." : `Event loop after the fix was measured locally (${after.measuredAt.text}, commit ${after.commit.text}), not on production.`,
    ],
  };
});

slide("moonshot", "Moonshot", () => ({
  body: `
  <div class="ladder">
    <div class="rung"><div class="when">Now</div><p>One expert → verified rulebook → tutor + agent guardrail.</p></div>
    <div class="rung"><div class="when">Next</div><p><strong>Company Memory</strong>: every expert, one rulebook that stays current; when work changes, ask only about what's new.</p></div>
    <div class="rung"><div class="when">Then</div><p><strong>Always-on apprentice</strong>: notices never-seen cases during normal work.</p></div>
    <div class="rung top"><div class="when">Moonshot</div><p><strong>The verified organisational judgment layer</strong>: every human and every agent decides routine cases from the same expert-approved rulebook — audit-ready.</p></div>
  </div>
  <h2 class="thesis close">${c(ev.plan.thesis)}</h2>`,
  notes: ["From plan.md §14. Cross-company aggregation is a distant, opt-in idea, not the pitch.", `Source: ${src(ev.plan.moonshot.source.replace(/ §.*/, ""))} §14.`],
}));

/* ---------------------------------------------------------------------------------------------- */

const CSS = `
${fontFaces()}
${TOKENS}
*{box-sizing:border-box} html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font-family:Geist,"Liberation Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.mono,code,pre{font-family:"Geist Mono","DejaVu Sans Mono",monospace}
.deck{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px 16px}
.frame{width:100%;max-width:1920px;aspect-ratio:16/9;position:relative;overflow:hidden;border-radius:10px;box-shadow:var(--shadow);border:1px solid var(--line)}
.slide{position:absolute;top:0;left:0;width:1920px;height:1080px;transform-origin:0 0;transform:scale(var(--k,1));background:var(--bg);padding:84px 104px 96px;display:flex;flex-direction:column;gap:28px}
.slide>header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--line);padding-bottom:18px}
.slide>header h2{margin:0;font-size:46px;letter-spacing:-.01em}
.slide>header .pg{font-size:20px;color:var(--faint)}
.slide>footer{position:absolute;left:104px;right:104px;bottom:30px;font-size:15px;color:var(--faint);display:flex;justify-content:space-between;gap:24px}
.slide>footer>span:first-child{white-space:nowrap;flex:none} .slide>footer .srcs{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.content{flex:1;min-height:0;display:flex;flex-direction:column;gap:26px}
h3{margin:0 0 10px;font-size:27px} p{margin:0;font-size:24px;line-height:1.42}
.kicker{font-size:24px;color:var(--accent);font-weight:600;letter-spacing:.02em}
.brand{font-size:132px;margin:0;letter-spacing:-.03em;line-height:1}
.lede{font-size:40px;line-height:1.3;max-width:1580px;font-weight:600}
.foot-note{font-size:21px;color:var(--muted)}
.small{font-size:20px;color:var(--muted)} .warn-text{color:var(--warn)}
.label-synth{font-size:19px;color:var(--violet);background:var(--violet-soft);padding:8px 14px;border-radius:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:26px;flex:1;min-height:0}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px 28px;box-shadow:var(--shadow);min-height:0}
.card p+p{margin-top:12px}
.macro .card{display:flex;align-items:center} .num{font-size:38px;font-weight:700;line-height:1.2}
.thesis{font-size:72px;line-height:1.12;margin:0;letter-spacing:-.02em}
.thesis.close{font-size:64px;text-align:center;margin-top:auto}
.tag{display:inline-block;padding:6px 14px;border-radius:999px;font-size:24px}
.tag.model{background:var(--warn-soft);color:var(--model)} .tag.ok{background:var(--ok-soft);color:var(--ok)} .tag.accent{background:var(--accent-soft);color:var(--accent)}
.sub{font-size:26px;color:var(--muted);margin-top:6px}
.claims{margin:0;padding-left:28px;font-size:23px;line-height:1.45} .claims li+li{margin-top:8px}
.loop{display:flex;align-items:stretch;gap:12px}
.step{flex:1;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:10px;box-shadow:var(--shadow)}
.step .n{width:44px;height:44px;border-radius:50%;background:var(--accent);color:var(--surface);display:grid;place-items:center;font-weight:700;font-size:22px}
.step h3{font-size:26px;margin:0} .step p{font-size:20px} .step .inv{margin-top:auto;font-size:17px;color:var(--accent);font-weight:600}
.arrow{align-self:center;font-size:34px;color:var(--faint)}
.inventions .card{padding:20px 22px} .inventions h3{font-size:23px} .inventions p{font-size:19px}
.inv-n{font-size:30px;color:var(--accent);line-height:1}
.arch{flex:1;min-height:0;display:flex;justify-content:center} .archsvg{height:100%;width:auto;max-width:100%;border-radius:12px}
.split{display:grid;grid-template-columns:1.25fr 1fr;gap:36px;flex:1;min-height:0}
.split.wide-left{grid-template-columns:1.2fr 1fr}
.col{display:flex;flex-direction:column;gap:18px;min-height:0}
.stack2{display:grid;grid-template-rows:1fr 1fr;gap:18px;min-height:0}
figure{margin:0;display:flex;flex-direction:column;gap:8px;min-height:0}
figure img{width:100%;border:1px solid var(--line);border-radius:10px;background:#fff}
figure.shot img{height:auto;max-height:780px;object-fit:contain;object-position:top left}
figure.crop-top{min-height:0;flex:1} figure.crop-top img{flex:1;min-height:0;height:100%;object-fit:cover;object-position:top left}
figcaption{font-size:15px;color:var(--faint)}
figure.chart img{border:none;background:transparent;max-height:800px;object-fit:contain}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 22px}
.stat .v{font-size:44px;font-weight:700;letter-spacing:-.01em} .stat .l{font-size:19px;color:var(--muted)} .stat .s{font-size:16px;color:var(--faint);margin-top:4px;font-family:"Geist Mono",monospace}
blockquote{margin:0;padding:14px 20px;border-left:5px solid var(--ok);background:var(--surface);border-radius:0 10px 10px 0;font-size:23px;line-height:1.4}
blockquote .rule{display:block;margin-top:6px;font-size:17px;color:var(--muted);font-family:"Geist Mono",monospace}
blockquote.claim{border-left-color:var(--accent);font-size:21px;margin:12px 0}
.terminal{background:#0f1115;color:#e6e8eb;border-radius:12px;padding:16px 20px;border:1px solid #2a2e35}
.terminal pre{margin:0;white-space:pre-wrap;font-size:17px;line-height:1.45;color:#e6e8eb}
.term-h{font-size:15px;color:#9aa1ac;margin-bottom:8px;font-family:"Geist Mono",monospace}
.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:18px;font-weight:600;white-space:nowrap}
.badge.ok{background:var(--ok-soft);color:var(--ok)} .badge.bad{background:var(--bad-soft);color:var(--bad)} .badge.warn{background:var(--warn-soft);color:var(--warn)} .badge.violet{background:var(--violet-soft);color:var(--violet)}
.honest h3{margin-bottom:12px} .honest p{font-size:20px}
table{border-collapse:collapse;width:100%}
.matrix th,.matrix td{border-bottom:1px solid var(--line);padding:16px 14px;font-size:22px;text-align:center}
.matrix thead th{font-size:19px;color:var(--muted);font-weight:600;vertical-align:bottom}
.matrix tbody th{text-align:left;font-weight:600}
.matrix .yes{color:var(--ok);font-weight:700;font-size:28px} .matrix .no{color:var(--faint)} .matrix .part{color:var(--muted);font-size:19px}
.matrix tr.us{background:var(--accent-soft)} .matrix tr.us th{color:var(--accent)}
.results th,.results td{border-bottom:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top;font-size:17.5px;line-height:1.35}
.results thead th{font-size:16px;color:var(--muted)} .results tbody th{font-size:18px;width:330px} .results td:nth-child(2){width:300px}
.ladder{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;align-items:end}
.rung{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:var(--shadow)}
.rung:nth-child(1){min-height:230px}.rung:nth-child(2){min-height:290px}.rung:nth-child(3){min-height:350px}.rung.top{min-height:420px;border-color:var(--accent);background:var(--accent-soft)}
.when{font-size:20px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
@page{size:1920px 1080px;margin:0}
@media print{html,body{background:var(--bg)} .deck{padding:0;gap:0;display:block} .frame{width:1920px;height:1080px;max-width:none;aspect-ratio:auto;border:none;border-radius:0;box-shadow:none;break-after:page;page-break-after:always} .slide{transform:none}}
`;

const SCALE_JS = `(()=>{const f=()=>document.querySelectorAll('.frame').forEach(el=>el.style.setProperty('--k',el.clientWidth/1920));f();addEventListener('resize',f);})();`;

function render(): string {
  const total = slides.length;
  const body = slides
    .map(
      (s, i) => `<section class="frame" id="${s.id}" aria-label="Slide ${i + 1}: ${esc(s.title)}"><div class="slide" style="--k:1">
  <header><h2>${esc(s.title)}</h2><span class="pg">${i + 1} / ${total}</span></header>
  <div class="content">${s.body}</div>
  <footer><span>${esc(NAME)} · Hack-Nation Challenge 01</span><span class="srcs">Sources: ${esc([...s.sources].join(" · "))}</span></footer>
</div></section>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(NAME)} Pitch Deck</title><meta name="description" content="Judges' deck generated from committed evidence by scripts/story/deck.ts"/>
<style>${CSS}</style></head><body><main class="deck">${body}</main><script>${SCALE_JS}</script></body></html>`;
}

function notesMarkdown(): string {
  const lines = [
    `# ${NAME} — speaker notes`,
    "",
    "Generated by `pnpm story:deck` (scripts/story/deck.ts) from the committed evidence; every number below and on the slides is read from the files cited. Re-run after new evidence lands. Expert speech in every live run was **synthetic voice input (ElevenLabs TTS)**.",
    "",
  ];
  slides.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.title}`, "", ...s.notes.map((n) => `- ${n}`), "", `Sources: ${[...s.sources].map((x) => `\`${x}\``).join(", ") || "—"}`, "");
  });
  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(DECK_DIR, { recursive: true });
  const html = render();
  const htmlPath = join(DECK_DIR, "deck.html");
  writeFileSync(htmlPath, html);
  writeFileSync(join(DECK_DIR, "speaker-notes.md"), notesMarkdown());
  console.info(`deck: ${slides.length} slides → ${rel(htmlPath)} (${(html.length / 1024).toFixed(0)} KiB)`);
  if (process.argv.includes("--no-pdf")) return;
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.emulateMedia({ colorScheme: "light", media: "print" });
    await page.goto(`file://${htmlPath}`);
    await page.evaluate("document.fonts.ready");
    const pdfPath = join(DECK_DIR, "deck.pdf");
    await page.pdf({ path: pdfPath, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
    console.info(`deck: PDF → ${rel(pdfPath)}`);
    if (process.argv.includes("--png")) {
      await page.emulateMedia({ colorScheme: process.argv.includes("--dark") ? "dark" : "light", media: "screen" });
      await page.setViewportSize({ width: 1952, height: 1200 });
      const frames = await page.locator(".frame").all();
      const out = process.env.STORY_PNG_DIR ?? DECK_DIR;
      for (const [i, f] of frames.entries()) await f.screenshot({ path: join(out, `slide-${String(i + 1).padStart(2, "0")}.png`) });
    }
  } finally {
    await browser.close();
  }
}

await main();
