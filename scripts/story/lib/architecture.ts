/**
 * The architecture diagram (plan.md §5 flow) as a standalone SVG. Box colours say who decides:
 * deterministic code, a model (non-authoritative), or an external provider — the thesis in one picture.
 * Light and dark come from the SVG's own prefers-color-scheme block; `theme` forces one for video.
 */
type Kind = "code" | "model" | "mixed" | "ext";
type Box = { id: string; x: number; y: number; w: number; h: number; kind: Kind; title: string; lines: string[] };

const W = 1600;
const H = 980;
const COL = [40, 590, 1140];
const BW = 420;
const BH = 112;
const ROW = [96, 250, 404, 558, 712];

const boxes: Box[] = [
  { id: "screen", x: COL[0]!, y: ROW[0]!, w: BW, h: BH, kind: "ext", title: "Screen share", lines: ["getDisplayMedia → canvas every 500 ms"] },
  { id: "privacy", x: COL[0]!, y: ROW[1]!, w: BW, h: BH, kind: "code", title: "Client change detector + privacy pass", lines: ["dHash/pixel diff · best-effort OCR/PII blur", "privacy epoch (off-record ⇒ nothing sent)"] },
  { id: "queue", x: COL[0]!, y: ROW[2]!, w: BW, h: BH, kind: "code", title: "Ordered perception queue", lines: ["1 in flight per session · coalesce newer frames", "frameSeq: stale responses never applied"] },
  { id: "vision", x: COL[0]!, y: ROW[3]!, w: BW, h: BH, kind: "model", title: "Vision → screen events", lines: ["Claude Haiku 4.5, structured output", "measured independently (P2: below target)"] },
  { id: "signals", x: COL[0]!, y: ROW[4]!, w: BW / 2 - 8, h: BH, kind: "code", title: "Activity signals", lines: ["typing · motion", "VAD · local onset"] },
  { id: "dom", x: COL[0]! + BW / 2 + 8, y: ROW[4]!, w: BW / 2 - 8, h: BH, kind: "code", title: "DOM events", lines: ["CaseDesk only", "disclosed in UI"] },
  { id: "context", x: COL[1]!, y: ROW[0]!, w: BW, h: BH, kind: "code", title: "Decision context", lines: ["case · history · actor · environment", "schemaVersion (unknown = Kleene ‘unknown’)"] },
  { id: "engine", x: COL[1]!, y: ROW[1]!, w: BW, h: BH, kind: "mixed", title: "Hypothesis engine", lines: ["enumerated candidates + LLM latent concepts", "surprise · expected information gain → queue"] },
  { id: "gate", x: COL[1]!, y: ROW[2]!, w: BW, h: BH, kind: "code", title: "Deterministic gate", lines: ["silence · idle screen · no typing · budget", "→ GateAuthorization{nonce, +4 s, contextVersion}"] },
  { id: "wrapper", x: COL[1]!, y: ROW[3]!, w: BW, h: BH, kind: "code", title: "Custom-LLM wrapper (thin)", lines: ["no valid nonce ⇒ skip_turn", "valid ⇒ speak the precomputed question"] },
  { id: "voice", x: COL[1]!, y: ROW[4]!, w: BW, h: BH, kind: "ext", title: "ElevenLabs voice", lines: ["Scribe realtime ASR · v3 conversational TTS", "custom LLM = our wrapper (option A)"] },
  { id: "answer", x: COL[2]!, y: ROW[0]!, w: BW, h: BH, kind: "mixed", title: "Expert answer → evidence", lines: ["provenance human_voice · exact quote + frame", "parser: Claude Sonnet 5.5 (schema-bound)"] },
  { id: "z3", x: COL[2]!, y: ROW[1]!, w: BW, h: BH, kind: "code", title: "Z3 counterexamples → debrief", lines: ["unresolved · conflict · boundary witnesses", "within domain constraints · teach-back"] },
  { id: "rulebook", x: COL[2]!, y: ROW[2]!, w: BW, h: BH, kind: "code", title: "Confirmed rulebook", lines: ["evidence-mandatory · versioned · code-compiled", "promotion needs the expert's own words"] },
  { id: "tutor", x: COL[2]!, y: ROW[3]!, w: BW, h: BH, kind: "code", title: "Human tutor", lines: ["guardrail monitor · spoken intervention", "deterministic Save interlock"] },
  { id: "mcp", x: COL[2]!, y: ROW[4]!, w: BW, h: BH, kind: "code", title: "MCP check_action", lines: ["same rulebook guards AI agents", "blocks with the expert's quote"] },
];

const by = (id: string): Box => {
  const b = boxes.find((x) => x.id === id);
  if (b === undefined) throw new Error(`no box ${id}`);
  return b;
};
const bottom = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h];
const top = (b: Box): [number, number] => [b.x + b.w / 2, b.y];
const right = (b: Box, dy = 0): [number, number] => [b.x + b.w, b.y + b.h / 2 + dy];
const left = (b: Box, dy = 0): [number, number] => [b.x, b.y + b.h / 2 + dy];

type Edge = { points: [number, number][]; dashed?: boolean; label?: string; labelAt?: [number, number] };
const down = (a: string, b: string): Edge => ({ points: [bottom(by(a)), top(by(b))] });

function edges(): Edge[] {
  const gutter1 = (COL[0]! + BW + COL[1]!) / 2;
  const gutter2 = (COL[1]! + BW + COL[2]!) / 2;
  const vision = by("vision");
  const context = by("context");
  const voice = by("voice");
  const answer = by("answer");
  const rulebook = by("rulebook");
  const mcp = by("mcp");
  return [
    down("screen", "privacy"),
    down("privacy", "queue"),
    down("queue", "vision"),
    { points: [right(vision), [gutter1 - 10, right(vision)[1]], [gutter1 - 10, left(context)[1]], left(context)] },
    { points: [[by("dom").x + by("dom").w / 2, by("dom").y], [by("dom").x + by("dom").w / 2, ROW[4]! - 20], [gutter1 + 10, ROW[4]! - 20], [gutter1 + 10, left(context, 30)[1]], left(context, 30)] },
    { points: [[by("signals").x + 30, by("signals").y + by("signals").h], [by("signals").x + 30, H - 128], [gutter1, H - 128], [gutter1, left(by("gate"))[1]], left(by("gate"))] },
    down("context", "engine"),
    down("engine", "gate"),
    down("gate", "wrapper"),
    down("wrapper", "voice"),
    { points: [right(voice), [gutter2, right(voice)[1]], [gutter2, left(answer)[1]], left(answer)] },
    { points: [left(answer, 30), [gutter2 + 20, left(answer, 30)[1]], [gutter2 + 20, right(by("engine"))[1]], right(by("engine"))], dashed: true, label: "hypothesis update", labelAt: [gutter2 + 28, ROW[1]! - 14] },
    down("answer", "z3"),
    down("z3", "rulebook"),
    down("rulebook", "tutor"),
    { points: [right(rulebook), [W - 14, right(rulebook)[1]], [W - 14, right(mcp)[1]], right(mcp)] },
  ];
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function architectureSvg(theme: "auto" | "light" | "dark" = "auto"): string {
  const light = `--bg:#fbfbfa;--ink:#16181d;--muted:#555a64;--line:#8b909a;--code:#e8f0fe;--code-b:#3b6fd8;--model:#fff1e0;--model-b:#c96a12;--mixed:#f2ecfd;--mixed-b:#7b54c9;--ext:#eef0f2;--ext-b:#7a808a;--ledger:#e9f6ef;--ledger-b:#2e8a5a;`;
  const dark = `--bg:#14161a;--ink:#eef0f3;--muted:#a9afba;--line:#7d838e;--code:#16233b;--code-b:#6c9cf5;--model:#33230f;--model-b:#f0a04b;--mixed:#251c3a;--mixed-b:#a98bf0;--ext:#22252b;--ext-b:#9aa1ac;--ledger:#12291d;--ledger-b:#5cc58d;`;
  const vars = theme === "dark" ? `svg{${dark}}` : theme === "light" ? `svg{${light}}` : `svg{${light}} @media (prefers-color-scheme: dark){svg{${dark}}}`;
  const style = `${vars}
    .bg{fill:var(--bg)} text{font-family:Geist,"Liberation Sans",system-ui,sans-serif;fill:var(--ink)}
    .t{font-size:21px;font-weight:600} .l{font-size:16px;fill:var(--muted)} .h{font-size:30px;font-weight:700} .s{font-size:17px;fill:var(--muted)}
    .code{fill:var(--code);stroke:var(--code-b)} .model{fill:var(--model);stroke:var(--model-b)} .mixed{fill:var(--mixed);stroke:var(--mixed-b)} .ext{fill:var(--ext);stroke:var(--ext-b);stroke-dasharray:6 4}
    .ledger{fill:var(--ledger);stroke:var(--ledger-b)} rect{stroke-width:2}
    .e{fill:none;stroke:var(--line);stroke-width:2.2} .d{stroke-dasharray:7 6} .ah{fill:var(--line)} .el{font-size:15px;fill:var(--muted);font-style:italic}`;
  const box = (b: Box): string =>
    `<g><rect class="${b.kind}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12"/>` +
    `<text class="t" x="${b.x + 18}" y="${b.y + 36}">${esc(b.title)}</text>` +
    b.lines.map((l, i) => `<text class="l" x="${b.x + 18}" y="${b.y + 66 + i * 24}">${esc(l)}</text>`).join("") +
    `</g>`;
  const edge = (e: Edge): string =>
    `<polyline class="e${e.dashed === true ? " d" : ""}" marker-end="url(#ah)" points="${e.points.map((p) => p.join(",")).join(" ")}"/>` +
    (e.label !== undefined && e.labelAt !== undefined ? `<text class="el" x="${e.labelAt[0]}" y="${e.labelAt[1]}">${esc(e.label)}</text>` : "");
  const legend = [
    ["code", "code (authoritative)"],
    ["model", "model (non-authoritative)"],
    ["mixed", "code + model · code decides"],
    ["ext", "browser / voice provider"],
  ]
    .map(([k, label], i) => `<rect class="${k}" x="${460 + i * 280}" y="34" width="26" height="18" rx="4"/><text class="s" x="${494 + i * 280}" y="49">${label}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="at ad">
<title id="at">Architecture — plan.md §5</title>
<desc id="ad">Screen and voice in; a deterministic gate decides when to speak; Z3 and the expert's own words make the confirmed rulebook; the same rulebook drives the tutor and an MCP guardrail; an append-only ledger records everything.</desc>
<style>${style}</style>
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="ah" d="M0,0 L10,5 L0,10 z"/></marker></defs>
<rect class="bg" width="${W}" height="${H}"/>
<text class="h" x="40" y="52">How it works</text>
${legend}
${edges().map(edge).join("\n")}
${boxes.map(box).join("\n")}
<rect class="ledger" x="40" y="${H - 108}" width="${W - 80}" height="72" rx="12"/>
<text class="t" x="64" y="${H - 66}">Append-only ledger underneath everything</text>
<text class="l" x="520" y="${H - 66}">every input and derivation, with parent provenance · control turns are system_control, never evidence</text>
</svg>`;
}
