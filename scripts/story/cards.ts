/**
 * Full-screen title/evidence cards for the videos (1920×1080 HTML, rendered and recorded by Playwright).
 * Every value on a card comes from lib/evidence.ts, and each card prints the file it came from.
 */
import { architectureSvg } from "./lib/architecture";
import type { Evidence } from "./lib/evidence";
import { TOKENS, esc, fontFaces } from "./lib/html";
import { dataUri } from "./lib/repo";

let fonts: string | undefined;
const page = (body: string, extra = ""): string => {
  fonts ??= fontFaces();
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"/><style>${fonts}${TOKENS}
*{box-sizing:border-box} html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--bg);color:var(--ink);font-family:Geist,system-ui,sans-serif}
.wrap{position:absolute;inset:0;padding:110px 130px;display:flex;flex-direction:column;gap:34px}
.kicker{font-size:30px;color:var(--accent);font-weight:600} h1{font-size:150px;margin:0;letter-spacing:-.03em;line-height:1}
.lede{font-size:46px;line-height:1.28;font-weight:600;max-width:1600px;margin:0}
.src{position:absolute;left:130px;right:130px;bottom:44px;font-size:20px;color:var(--faint);font-family:"Geist Mono",monospace}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:28px} .tile{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:30px 34px;font-size:40px;font-weight:700;line-height:1.2;box-shadow:var(--shadow)}
.fade{opacity:0;animation:in .7s ease forwards} @keyframes in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.d1{animation-delay:.3s}.d2{animation-delay:1.1s}.d3{animation-delay:1.9s}.d4{animation-delay:2.7s}.d5{animation-delay:3.5s}.d6{animation-delay:4.3s}.d7{animation-delay:5.1s}.d8{animation-delay:5.9s}
.term{background:#0f1115;color:#e7e9ec;border-radius:18px;padding:34px 40px;font-family:"Geist Mono",monospace;font-size:25px;line-height:1.5;border:1px solid #2a2e35;white-space:pre-wrap}
.term .h{color:#9aa1ac;font-size:21px;margin-bottom:14px} .term .ok{color:#7ee2a8} .term .bad{color:#ff8a80} .term .dim{color:#9aa1ac}
.pill{display:inline-block;padding:8px 18px;border-radius:999px;font-size:24px;font-weight:600}
.pill.violet{background:var(--violet-soft);color:var(--violet)} .pill.warn{background:var(--warn-soft);color:var(--warn)} .pill.ok{background:var(--ok-soft);color:var(--ok)} .pill.bad{background:var(--bad-soft);color:var(--bad)}
h2{font-size:58px;margin:0;letter-spacing:-.015em}
.cols{display:grid;grid-template-columns:1.15fr 1fr;gap:48px;align-items:start}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px 32px;box-shadow:var(--shadow)} .card p{font-size:28px;line-height:1.4;margin:0} .card p+p{margin-top:14px}
.big{font-size:64px;font-weight:700;letter-spacing:-.01em} .card.tight p{font-size:23px;line-height:1.35} .card.tight p+p{margin-top:10px} .lbl{font-size:24px;color:var(--muted)}
${extra}</style></head><body>${body}</body></html>`;
};

export function hookCard(ev: Evidence, name: string): string {
  return page(`<div class="wrap">
  <div class="kicker fade d1">Hack-Nation · Challenge 01 · “The AI Apprentice”</div>
  <h1 class="fade d1">${esc(name)}</h1>
  <p class="lede fade d2">${esc(ev.plan.oneLiner.text)}</p>
  <div class="tiles">${ev.plan.macro.map((m, i) => `<div class="tile fade d${i + 3}">${esc(m.text)}</div>`).join("")}</div>
  </div><div class="src">The brief's macro story, as recorded in ${esc(ev.plan.source)} §2.3</div>`);
}

export function agentCard(ev: Evidence): string {
  const t = ev.live.agentTranscript;
  const call = (/^\s*→ check_action .*$/m.exec(t)?.[0] ?? "").trim();
  const reply = (/^\s*← forbid .*$/m.exec(t)?.[0] ?? "").trim();
  const said = (/^Claude \([^)]+\): (.*)$/m.exec(t)?.[1] ?? "").trim();
  const shortCall = call.length > 150 ? `${call.slice(0, 150)}…` : call;
  return page(`<div class="wrap" style="gap:26px">
  <div class="fade d1"><span class="pill violet">Recorded live run · production · ${esc(ev.live.agentStarted.text)}</span></div>
  <h2 class="fade d1">A real Claude agent tries to approve ${esc(ev.live.agentCase.text)}</h2>
  <div class="term fade d2"><div class="h">Claude (${esc(ev.live.agentModel.text)}) → MCP check_action → production rulebook revision ${esc(ev.live.rulebookRevision.text)}</div><span class="dim">${esc(shortCall)}</span>
<span class="bad fade d3">${esc(reply.length > 170 ? `${reply.slice(0, 170)}…` : reply)}</span>

<span class="fade d4">Claude: ${esc(said)}</span>

<span class="ok fade d5">BLOCKED: “${esc(ev.live.blockedQuote.text)}”</span></div>
  <div class="lbl fade d5">The quote is the expert's production utterance from the recorded capture run (synthetic test voice). MCP check_action agrees with the Save interlock on ${esc(ev.live.mcpAgree.text)} production checks.</div>
  </div><div class="src">${esc(ev.live.agentSource)} · docs/evidence/live/p8/exports-roundtrip.txt</div>`);
}

export function proofCard(ev: Evidence): string {
  const b = ev.bench;
  const p2 = ev.perception;
  return page(`<div class="wrap" style="gap:24px;padding-top:80px">
  <h2 class="fade d1">Measured — and missed</h2>
  <div class="cols">
    <div class="fade d1"><img src="${dataUri(b.chartUnsafe)}" style="width:100%;border-radius:14px;border:1px solid var(--line)" alt="Unsafe error rate vs expert questions"/>
      <div class="lbl" style="margin-top:10px">Simulated expert (deterministic ${esc(b.policy.text)} oracle) · ${esc(b.seeds.text)} seeds × ${esc(b.heldout.text)} held-out cases · not a human-subject result</div></div>
    <div style="display:flex;flex-direction:column;gap:22px">
      <div class="card fade d2"><div class="big">${esc(b.floorUnsafe.text)} → ${esc(b.d8Unsafe.text)}</div><div class="lbl">unsafe approvals: record-only → ours after ${esc(b.d8Questions.text)} questions</div></div>
      <div class="card fade d3"><p><span class="pill warn">Honest</span> “Why” after every step reaches ${esc(b.bUnsafe.text)}, but needs ${esc(b.b16Questions.text)}–${esc(b.b24Questions.text)} questions and interruptions; ours plateaus at ${esc(b.dPlateauQuestions.text)} questions with ${esc(b.dPlateauUnsafe.text)}.</p></div>
      <div class="card fade d4 tight"><p><span class="pill bad">Missed</span> Live vision: ${p2.passed}/${p2.total} thresholds met (${esc(p2.rows.map((r) => `${r.metric.replace(" (ms)", "")} ${r.final}`).join(", "))}). Tutor and interlock use the disclosed DOM channel.</p>
      ${
        ev.rerun === null
          ? `<p><span class="pill bad">Missed</span> ${esc(ev.live.interruptions.text)} interruptions in 5 live voice runs (target ${esc(ev.live.interruptionThreshold.text)}); fixes landed, live re-test pending.</p>`
          : `<p><span class="pill ok">Fixed</span> Interruptions in 5 live voice runs: ${esc(ev.live.interruptions.text)} → ${esc(ev.rerun.interruptions.text)} on the fixed build.</p>
      ${ev.rerun.prodLoopMax === null ? "" : `<p><span class="pill bad">Missed</span> One ${esc(ev.rerun.prodLoopMax.text)} production stall (event-loop p99 ${esc(ev.rerun.prodLoopP99?.text ?? "")}): a host-level freeze; mitigations not yet verified.</p>`}`
      }</div>
    </div>
  </div></div><div class="src">${esc(b.report)} · ${esc(p2.source)} · docs/evidence/live/ACCEPTANCE.txt${ev.rerun === null ? "" : ` · ${esc(ev.rerun.acceptance)} · PROGRESS.md`}</div>`);
}

export function thesisCard(ev: Evidence): string {
  const parts = ev.plan.thesis.text.split(/(?<=\.)\s+/);
  return page(`<div class="wrap" style="justify-content:center;align-items:center;text-align:center;gap:10px">
  ${parts.map((p, i) => `<div class="fade d${i * 2 + 1}" style="font-size:118px;font-weight:700;letter-spacing:-.03em;line-height:1.1">${esc(p)}</div>`).join("")}
  </div>`);
}

export function endCard(ev: Evidence, opts: { title: string; commit: string; narrator: string; lines: string[] }): string {
  return page(`<div class="wrap" style="gap:22px">
  <h2>${esc(opts.title)}</h2>
  <div class="card"><p><strong>Narration: AI narration</strong> — ElevenLabs text-to-speech, voice “${esc(opts.narrator)}”. Script and sources: docs/video/narration.md.</p>
  ${opts.lines.map((l) => `<p>${l}</p>`).join("")}
  <p>Local flows: production build of commit <span style="font-family:'Geist Mono',monospace">${esc(opts.commit)}</span> on a local server, LLM calls off, synthetic CaseDesk data.</p></div>
  <div class="lbl">${esc(ev.plan.thesis.text)}</div>
  </div><div class="src">Deck + speaker notes: docs/deck/ · evidence: docs/evidence/ · replay manifest: ${esc(ev.replay.source)}</div>`);
}

export function archCard(): string {
  return page(`<div style="position:absolute;inset:0;display:grid;place-items:center;padding:40px" class="fade d1">${architectureSvg("light").replace("<svg ", '<svg style="width:1800px;height:auto" ')}</div>`);
}

/** A terminal that reveals lines one by one (`[data-show]` toggled by the recorder). */
export function terminalCard(title: string, subtitle: string, lines: { cls: string; text: string }[], source: string): string {
  return page(
    `<div class="wrap" style="gap:24px"><h2>${esc(title)}</h2><div class="lbl">${esc(subtitle)}</div>
  <div class="term" style="font-size:24px">${lines.map((l, i) => `<div class="ln ${l.cls}" data-i="${i}">${esc(l.text)}</div>`).join("")}</div></div><div class="src">${esc(source)}</div>`,
    `.ln{opacity:0;transition:opacity .4s} .ln.on{opacity:1}`,
  );
}

export function eventLoopCard(ev: Evidence): string {
  const b = ev.eventLoop.before;
  const a = ev.eventLoop.after;
  return page(`<div class="wrap" style="gap:30px">
  <h2 class="fade d1">Event loop: before and after worker threads</h2>
  <div class="cols" style="grid-template-columns:1fr 1fr">
    <div class="card fade d2"><span class="pill bad">Before · production (live bug #6)</span>
      <div class="big" style="margin-top:18px">${esc(b.healthWorst.text)}</div><div class="lbl">/api/health stalls during a cold Work Map export (${esc(b.coldExport.text)})</div>
      <div class="big" style="margin-top:18px">${esc(b.handlerGapMax.text)}</div><div class="lbl">worst in-handler gap before a nonce was issued</div></div>
    <div class="card fade d3"><span class="pill ok">After worker threads</span>
      ${
        ev.preflight.eventLoopP99 === null
          ? ""
          : `<div class="big" style="margin-top:18px">${esc(ev.preflight.eventLoopP99.text)}</div><div class="lbl">event-loop delay p99 on production (live preflight ${esc(ev.preflight.when.text)})</div>`
      }
      ${
        ev.rerun?.prodLoopMax == null
          ? ""
          : `<div class="lbl" style="margin-top:12px"><span class="pill bad">Still open</span> after the live re-runs: p99 ${esc(ev.rerun.prodLoopP99?.text ?? "")} but max ${esc(ev.rerun.prodLoopMax.text)} — a host-level freeze (PROGRESS.md); mitigations not yet verified.</div>`
      }
      ${
        a === null
          ? `<p style="margin-top:18px">Not measured yet — run scripts/story/event-loop-probe.ts.</p>`
          : `<div class="big" style="margin-top:18px">${esc(a.testMax?.text ?? "—")}</div><div class="lbl">worst event-loop block under the repo's heavy-flow test (${esc(a.test?.text ?? "")}) · ${esc(a.machine.text)}, commit ${esc(a.commit.text)}</div>
      <div class="lbl" style="margin-top:12px">Local cold Work Map export ${esc(a.coldExport.text)}; worst /api/health meanwhile ${esc(a.healthMax.text)} (n=${esc(a.healthSamples.text)}) — a different machine and rulebook size than production.</div>`
      }</div>
  </div></div><div class="src">docs/evidence/live/bugs/event-loop-stall-probe.txt · ${esc(ev.preflight.source)}${a === null ? "" : ` · ${esc(a.measuredAt.source)}`}</div>`);
}

export function benchCard(ev: Evidence): string {
  const b = ev.bench;
  return page(`<div class="wrap" style="gap:24px">
  <h2 class="fade d1">Apprentice-Bench</h2>
  <div class="cols">
    <img class="fade d1" src="${dataUri(b.chartUnsafe)}" style="width:100%;border-radius:14px;border:1px solid var(--line)" alt="Unsafe error rate vs expert questions"/>
    <div style="display:flex;flex-direction:column;gap:22px">
      <div class="card fade d2"><div class="big">${esc(b.floorUnsafe.text)} → ${esc(b.d8Unsafe.text)}</div><div class="lbl">unsafe approvals: record-only → ours after ${esc(b.d8Questions.text)} questions · fidelity ${esc(b.floorFidelity.text)} → ${esc(b.d8Fidelity.text)}</div></div>
      <div class="card fade d3"><p>Hidden policy ${esc(b.policy.text)} is a program; the learner and strategies cannot import it (a test fails if they do). ${esc(b.seeds.text)} seeds × ${esc(b.heldout.text)} held-out cases; re-runs are byte-identical.</p></div>
      <div class="card fade d4"><p><span class="pill warn">Honest</span> Generic “why” reaches ${esc(b.bUnsafe.text)} with ${esc(b.b16Questions.text)}–${esc(b.b24Questions.text)} questions. Simulated expert — not a human-subject result.</p></div>
    </div></div></div><div class="src">${esc(b.report)} · docs/evidence/bench/results.json</div>`);
}
