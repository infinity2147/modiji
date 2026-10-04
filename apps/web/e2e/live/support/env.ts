/**
 * Live runner environment: reads the repo-root `.env` (never printed) without overriding variables that
 * are already set, and resolves the production base URL. Node must prefer IPv4 on this network
 * (broken IPv6 routes time out), so the runner sets the default DNS order here as well as through
 * NODE_OPTIONS in the README commands.
 */
import { readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { join } from "node:path";

setDefaultResultOrder("ipv4first");

export const REPO_ROOT = join(import.meta.dirname, "../../../../..");

function loadDotEnv(): void {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key = "", raw = ""] = match;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "" && (process.env[key] ?? "") === "") process.env[key] = value;
  }
}
loadDotEnv();

export function requireEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") throw new Error(`${name} is not set (repo-root .env or the environment)`);
  return value;
}

/** The deployed service under test (production by default). */
export const BASE_URL = (process.env.LIVE_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "https://vashistha-production.up.railway.app").replace(/\/$/, "");

export const EVIDENCE_DIR = join(REPO_ROOT, "docs/evidence/live");
export const AUDIO_DIR = join(import.meta.dirname, "../audio");

/** Every artefact that contains or derives from the expert's speech carries this label. */
export const SYNTHETIC_LABEL = "synthetic voice input (ElevenLabs TTS)";
