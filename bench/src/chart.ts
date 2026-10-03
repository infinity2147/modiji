/**
 * Self-contained SVG line charts (no chart library): one series per strategy, x = mean questions
 * actually asked, y = mean metric across seeds with ±1 sample-std error bars. Colour-blind-safe
 * categorical palette (validated light/dark steps) plus a distinct marker shape per strategy, so
 * identity never rests on colour alone, and a legend. Hovering a point shows its exact values.
 */
import { STRATEGY_IDS, STRATEGY_LABELS, type StrategyId } from "./config";
import type { MetricNumbers, Aggregate } from "./sweep";

const COLORS: Record<StrategyId, { light: string; dark: string }> = {
  A: { light: "#2a78d6", dark: "#3987e5" },
  B: { light: "#eb6834", dark: "#d95926" },
  C: { light: "#1baf7a", dark: "#199e70" },
  D: { light: "#eda100", dark: "#c98500" },
};
const MARKERS: Record<StrategyId, (x: number, y: number) => string> = {
  A: (x, y) => `<circle cx="${f(x)}" cy="${f(y)}" r="5"/>`,
  B: (x, y) => `<rect x="${f(x - 4.5)}" y="${f(y - 4.5)}" width="9" height="9"/>`,
  C: (x, y) => `<path d="M${f(x)} ${f(y - 6)}L${f(x + 6)} ${f(y + 4.5)}L${f(x - 6)} ${f(y + 4.5)}Z"/>`,
  D: (x, y) => `<path d="M${f(x)} ${f(y - 6.5)}L${f(x + 6.5)} ${f(y)}L${f(x)} ${f(y + 6.5)}L${f(x - 6.5)} ${f(y)}Z"/>`,
};

export type ChartSpec = { title: string; subtitle: string; yLabel: string; metric: keyof MetricNumbers; percent: boolean };

const W = 880;
const H = 500;
const M = { top: 78, right: 270, bottom: 64, left: 72 };

function f(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

export function renderChart(aggregates: readonly Aggregate[], spec: ChartSpec): string {
  const series = STRATEGY_IDS.map((s) => ({
    strategy: s,
    points: aggregates
      .filter((a) => a.strategy === s)
      .sort((a, b) => a.budget - b.budget)
      .map((a) => ({ x: a.mean.questions, y: a.mean[spec.metric], err: a.std[spec.metric], budget: a.budget })),
  }));
  const all = series.flatMap((s) => s.points);
  const reference = new Set(series.filter((s) => s.points.length > 0 && s.points.every((p) => p.x === 0 && p.y === s.points[0]?.y)).map((s) => s.strategy));
  const xMax = Math.max(1, ...all.map((p) => p.x));
  const yTop = Math.max(...all.map((p) => p.y + p.err), spec.percent ? 0.05 : 0.1);
  const yStep = niceStep(yTop, 5);
  const yMax = Math.ceil(yTop / yStep) * yStep;
  const xStep = niceStep(xMax, 6);
  const xEnd = Math.ceil(xMax / xStep) * xStep;
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const sx = (x: number): number => M.left + (x / xEnd) * pw;
  const sy = (y: number): number => M.top + ph - (y / yMax) * ph;
  const fmtY = (y: number): string => (spec.percent ? `${Number((y * 100).toFixed(1))}%` : Number(y.toFixed(2)).toString());

  const grid: string[] = [];
  for (let y = 0; y <= yMax + 1e-9; y += yStep)
    grid.push(
      `<line class="grid" x1="${M.left}" x2="${M.left + pw}" y1="${f(sy(y))}" y2="${f(sy(y))}"/>`,
      `<text class="tick" x="${M.left - 10}" y="${f(sy(y) + 4)}" text-anchor="end">${fmtY(y)}</text>`,
    );
  for (let x = 0; x <= xEnd + 1e-9; x += xStep)
    grid.push(
      `<line class="axis" x1="${f(sx(x))}" x2="${f(sx(x))}" y1="${M.top + ph}" y2="${M.top + ph + 5}"/>`,
      `<text class="tick" x="${f(sx(x))}" y="${M.top + ph + 20}" text-anchor="middle">${Number(x.toFixed(1))}</text>`,
    );

  const marks = series.map(({ strategy, points }) => {
    // A strategy that never asks (A) is one point at x = 0: drawn as a dashed reference line across the plot.
    const first = points[0];
    if (first !== undefined && reference.has(strategy))
      return `<g class="series s${strategy}" data-strategy="${strategy}"><title>${esc(`${STRATEGY_LABELS[strategy]}: ${fmtY(first.y)} ± ${fmtY(first.err)} at every budget (no questions)`)}</title><path class="line ref" d="M${M.left} ${f(sy(first.y))}H${M.left + pw}"/>${MARKERS[strategy](sx(0), sy(first.y))}</g>`;
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${f(sx(p.x))} ${f(sy(p.y))}`).join("");
    const bars = points
      .filter((p) => p.err > 0)
      .map((p) => {
        const x = sx(p.x);
        const lo = sy(Math.max(0, p.y - p.err));
        const hi = sy(p.y + p.err);
        return `<path class="err" d="M${f(x)} ${f(lo)}V${f(hi)}M${f(x - 4)} ${f(lo)}H${f(x + 4)}M${f(x - 4)} ${f(hi)}H${f(x + 4)}"/>`;
      })
      .join("");
    const dots = points
      .map((p) => `<g><title>${esc(`${STRATEGY_LABELS[strategy]} — budget ${p.budget}: ${p.x.toFixed(1)} questions, ${fmtY(p.y)} ± ${fmtY(p.err)}`)}</title>${MARKERS[strategy](sx(p.x), sy(p.y))}</g>`)
      .join("");
    return `<g class="series s${strategy}" data-strategy="${strategy}"><path class="line" d="${path}"/>${bars}${dots}</g>`;
  });

  const legend = STRATEGY_IDS.map((s, i) => {
    const y = M.top + 8 + i * 26;
    const x = M.left + pw + 24;
    return `<g class="series s${s}">${MARKERS[s](x, y)}<line class="line${reference.has(s) ? " ref" : ""}" x1="${x - 12}" x2="${x + 12}" y1="${y}" y2="${y}"/></g><text class="legend" x="${x + 20}" y="${y + 4}">${esc(STRATEGY_LABELS[s])}${reference.has(s) ? " (asks nothing)" : ""}</text>`;
  }).join("");

  const style = `
    svg { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .bg { fill: #fcfcfb; }
    .title { fill: #0b0b0b; font-size: 17px; font-weight: 600; }
    .subtitle, .legend, .label { fill: #52514e; font-size: 12.5px; }
    .tick { fill: #52514e; font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .grid { stroke: #e4e3df; stroke-width: 1; }
    .axis { stroke: #8a8984; stroke-width: 1; }
    .line { fill: none; stroke-width: 2; }
    .err { fill: none; stroke-width: 1.25; opacity: 0.7; }
    .ref { stroke-dasharray: 6 4; }
    .series path:not(.line):not(.err), .series rect, .series circle { stroke: #fcfcfb; stroke-width: 1.5; }
    ${STRATEGY_IDS.map((s) => `.s${s} .line, .s${s} .err { stroke: ${COLORS[s].light}; } .s${s} circle, .s${s} rect, .s${s} path:not(.line):not(.err) { fill: ${COLORS[s].light}; }`).join("\n    ")}
    @media (prefers-color-scheme: dark) {
      .bg { fill: #1a1a19; }
      .title { fill: #ffffff; }
      .subtitle, .legend, .label, .tick { fill: #c3c2b7; }
      .grid { stroke: #34332f; }
      .series path:not(.line):not(.err), .series rect, .series circle { stroke: #1a1a19; }
      ${STRATEGY_IDS.map((s) => `.s${s} .line, .s${s} .err { stroke: ${COLORS[s].dark}; } .s${s} circle, .s${s} rect, .s${s} path:not(.line):not(.err) { fill: ${COLORS[s].dark}; }`).join("\n      ")}
    }`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(spec.title)}</title>
<desc id="d">${esc(spec.subtitle)}</desc>
<style>${style}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text class="title" x="${M.left}" y="30">${esc(spec.title)}</text>
<text class="subtitle" x="${M.left}" y="52">${esc(spec.subtitle)}</text>
${grid.join("\n")}
<line class="axis" x1="${M.left}" x2="${M.left + pw}" y1="${M.top + ph}" y2="${M.top + ph}"/>
<text class="label" x="${M.left + pw / 2}" y="${H - 18}" text-anchor="middle">Expert questions asked (mean per episode)</text>
<text class="label" transform="translate(20 ${M.top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(spec.yLabel)}</text>
${marks.join("\n")}
${legend}
</svg>
`;
}
