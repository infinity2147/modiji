/**
 * docs/video/narration.md → narration segments → ElevenLabs TTS (AI narration, labelled in each end card).
 *
 * - `{{path}}` tokens are filled from the evidence (lib/evidence.ts), so spoken numbers track the files.
 * - Every literal number in a spoken line must appear in one of the segment's cited `Sources:` files,
 *   or the build fails (no number is typed into the narration from memory).
 * - TTS uses `/v1/text-to-speech/{voice}/with-timestamps`, whose character alignment times the subtitles.
 *   Audio is cached by a hash of (voice, model, text) outside the repo.
 */
import { setDefaultResultOrder } from "node:dns";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, Fact } from "./evidence";
import { REPO, VIDEO_DIR, readCommitted, readText, sha256 } from "./repo";

setDefaultResultOrder("ipv4first");

export const NARRATOR = { voiceId: "onwK4e9ZLuTAKqWW03F9", voiceName: "Daniel", modelId: "eleven_multilingual_v2", speed: 1.1 } as const;

export type Segment = { id: string; sources: string[]; text: string; spoken: string };
export type Alignment = { characters: string[]; starts: number[]; ends: number[] };
export type Voiced = Segment & { audio: string; duration: number; alignment: Alignment };

function resolve(evidence: Evidence, path: string): string {
  let cur: unknown = evidence;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in cur)) throw new Error(`narration: unknown token {{${path}}}`);
    cur = (cur as Record<string, unknown>)[key];
  }
  const f = cur as Fact | null;
  if (f === null || typeof f !== "object" || typeof f.text !== "string") throw new Error(`narration: {{${path}}} is not a measured fact (missing evidence?)`);
  return f.text;
}

/** How the narrator says compact units (the subtitles keep what is spoken). */
export function speakable(text: string): string {
  return text
    .replace(/(\d)\s?ms\b/g, "$1 milliseconds")
    .replace(/(\d(?:\.\d+)?) s\b/g, "$1 seconds")
    .replace(/\bat p95\b/g, "at the 95th percentile")
    .replace(/(\d)%/g, "$1 percent")
    .replace(/ — /g, ", ");
}

function sourceText(src: string): string {
  if (src === "PROGRESS.md" || src === "plan.md") return readCommitted(src);
  const abs = join(REPO, src);
  if (!existsSync(abs)) throw new Error(`narration: cited source ${src} does not exist`);
  return readText(abs);
}

export function loadNarration(evidence: Evidence, prefix: string): Segment[] {
  const md = readFileSync(join(VIDEO_DIR, "narration.md"), "utf8");
  const parts = md.split(/^## /m).slice(1);
  const out: Segment[] = [];
  for (const part of parts) {
    const [head = "", ...lines] = part.split("\n");
    const id = head.trim();
    if (!id.startsWith(`${prefix}/`)) continue;
    const sources = (lines.find((l) => l.startsWith("Sources:")) ?? "").replace("Sources:", "").split(",").map((s) => s.trim()).filter(Boolean);
    const literal = lines.filter((l) => l.startsWith("> ")).map((l) => l.slice(2).trim()).join(" ");
    const corpus = sources.map(sourceText).join("\n");
    for (const n of literal.replace(/\{\{[^}]+\}\}/g, "").match(/\d[\d,.]*\d|\d/g) ?? []) {
      if (!corpus.includes(n) && !corpus.includes(n.replace(/,/g, ""))) throw new Error(`narration ${id}: number "${n}" is not in its cited sources (${sources.join(", ")})`);
    }
    const text = literal.replace(/\{\{([^}]+)\}\}/g, (_, p: string) => resolve(evidence, p.trim()));
    out.push({ id, sources, text, spoken: speakable(text) });
  }
  if (out.length === 0) throw new Error(`narration: no ${prefix}/ segments`);
  return out;
}

export async function voice(segment: Segment, cacheDir: string, ffprobe: (file: string) => number): Promise<Voiced> {
  mkdirSync(cacheDir, { recursive: true });
  const key = sha256(`${NARRATOR.voiceId}|${NARRATOR.modelId}|${NARRATOR.speed}|${segment.spoken}`).slice(0, 24);
  const audio = join(cacheDir, `${key}.mp3`);
  const align = join(cacheDir, `${key}.json`);
  if (!existsSync(audio) || !existsSync(align)) {
    const apiKey = process.env.ELEVENLABS_API_KEY ?? envFile().ELEVENLABS_API_KEY;
    if (apiKey === undefined || apiKey === "") throw new Error("ELEVENLABS_API_KEY is not set (repo-root .env)");
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${NARRATOR.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: segment.spoken, model_id: NARRATOR.modelId, voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true, speed: NARRATOR.speed } }),
    });
    if (!r.ok) throw new Error(`ElevenLabs TTS ${segment.id}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    const body = (await r.json()) as { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
    writeFileSync(audio, Buffer.from(body.audio_base64, "base64"));
    writeFileSync(align, JSON.stringify({ characters: body.alignment.characters, starts: body.alignment.character_start_times_seconds, ends: body.alignment.character_end_times_seconds }));
  }
  return { ...segment, audio, duration: ffprobe(audio), alignment: JSON.parse(readFileSync(align, "utf8")) as Alignment };
}

function envFile(): Record<string, string> {
  const file = join(REPO, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Subtitle cues for a voiced segment: sentence/clause chunks ≤ ~84 characters, timed by the TTS alignment. */
export function cues(v: Voiced): { start: number; end: number; text: string }[] {
  const chars = v.alignment.characters.join("");
  const out: { start: number; end: number; text: string }[] = [];
  const pieces = chars.match(/[^.;:!?,]+[.;:!?,]*\s*/g) ?? [chars];
  let buf = "";
  let bufStart = 0;
  let pos = 0;
  const flush = (endIdx: number): void => {
    const text = buf.trim();
    if (text !== "") out.push({ start: v.alignment.starts[bufStart] ?? 0, end: v.alignment.ends[Math.max(bufStart, endIdx - 1)] ?? v.duration, text });
    buf = "";
  };
  for (const piece of pieces) {
    if (buf !== "" && (buf + piece).trim().length > 84) flush(pos);
    if (buf === "") bufStart = pos;
    buf += piece;
    pos += piece.length;
    if (/[.!?]\s*$/.test(piece)) flush(pos);
  }
  flush(pos);
  return out;
}
