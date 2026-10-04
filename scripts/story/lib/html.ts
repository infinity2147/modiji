/** Small HTML helpers and the shared visual tokens for the deck and the video cards. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./repo";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `**bold**` and `code` from plan.md prose → HTML (escaped first). */
export const md = (s: string): string =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

export function productName(): string {
  const src = readFileSync(join(REPO, "apps/web/lib/product.ts"), "utf8");
  const m = /PRODUCT_NAME = "([^"]+)"/.exec(src);
  if (m?.[1] === undefined) throw new Error("apps/web/lib/product.ts: PRODUCT_NAME not found");
  return m[1];
}

/** Geist (the product UI's font, from the web app's `geist` dependency) inlined as data URIs. */
export function fontFaces(): string {
  const dir = join(REPO, "apps/web/node_modules/geist/dist/fonts");
  const face = (family: string, file: string, weight: number): string =>
    `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${readFileSync(join(dir, file)).toString("base64")}) format("woff2");font-weight:${weight};font-style:normal;font-display:block}`;
  return [
    face("Geist", "geist-sans/Geist-Regular.woff2", 400),
    face("Geist", "geist-sans/Geist-SemiBold.woff2", 600),
    face("Geist", "geist-sans/Geist-Bold.woff2", 700),
    face("Geist Mono", "geist-mono/GeistMono-Regular.woff2", 400),
  ].join("\n");
}

/** Colour tokens: light by default, dark under prefers-color-scheme unless forced light, or forced dark. */
export const TOKENS = `
:root{--bg:#f7f7f5;--surface:#ffffff;--surface-2:#f0f1f3;--ink:#15171b;--muted:#5a606a;--faint:#8a909a;--line:#e1e3e7;
--accent:#3651c9;--accent-soft:#e8ecfc;--ok:#1d7a4c;--ok-soft:#e5f4ec;--warn:#9a5b00;--warn-soft:#fdf0dc;--bad:#b4322b;--bad-soft:#fbe9e7;
--violet:#5b21b6;--violet-soft:#efe8fc;--model:#c96a12;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 16px rgba(16,24,40,.06)}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#101215;--surface:#181b20;--surface-2:#20242a;--ink:#eef0f3;--muted:#a6acb6;--faint:#7c838e;--line:#2c3038;
--accent:#93a6ff;--accent-soft:#1d2440;--ok:#55c690;--ok-soft:#132a1f;--warn:#f1b552;--warn-soft:#2e2312;--bad:#ff8a80;--bad-soft:#341a19;
--violet:#b69cff;--violet-soft:#241a3a;--model:#f0a04b;--shadow:none}}
:root[data-theme="dark"]{--bg:#101215;--surface:#181b20;--surface-2:#20242a;--ink:#eef0f3;--muted:#a6acb6;--faint:#7c838e;--line:#2c3038;
--accent:#93a6ff;--accent-soft:#1d2440;--ok:#55c690;--ok-soft:#132a1f;--warn:#f1b552;--warn-soft:#2e2312;--bad:#ff8a80;--bad-soft:#341a19;
--violet:#b69cff;--violet-soft:#241a3a;--model:#f0a04b;--shadow:none}
`;
