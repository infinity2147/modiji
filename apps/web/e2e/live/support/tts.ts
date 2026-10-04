/**
 * The scripted expert's voice: SYNTHETIC voice input (ElevenLabs TTS), generated once per line with
 * POST /v1/text-to-speech/{voice_id} (mp3, decoded in the browser with decodeAudioData) and cached under
 * e2e/live/audio/ (gitignored). `manifest.json` records text, voice, model and the synthetic label for
 * every clip.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIO_DIR, SYNTHETIC_LABEL, requireEnv } from "./env";

/** "Matilda" (premade, American English, female): distinct from the interviewer agent's voice. */
export const EXPERT_VOICE_ID = process.env.LIVE_EXPERT_VOICE_ID ?? "XrExE9yKIg1WjnnlVkGX";
export const TTS_MODEL_ID = "eleven_multilingual_v2";
const OUTPUT_FORMAT = "mp3_44100_128";

export type Clip = { key: string; text: string; file: string; base64: string; label: typeof SYNTHETIC_LABEL };

type ManifestEntry = { text: string; voiceId: string; modelId: string; outputFormat: string; label: string; createdAt: string };

function manifestPath(): string {
  return join(AUDIO_DIR, "manifest.json");
}

function readManifest(): Record<string, ManifestEntry> {
  try {
    return JSON.parse(readFileSync(manifestPath(), "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

export function clipKey(text: string): string {
  return createHash("sha256").update(`${EXPERT_VOICE_ID}|${TTS_MODEL_ID}|${OUTPUT_FORMAT}|${text}`).digest("hex").slice(0, 16);
}

async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EXPERT_VOICE_ID}?output_format=${OUTPUT_FORMAT}`, {
    method: "POST",
    headers: { "xi-api-key": requireEnv("ELEVENLABS_API_KEY"), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: TTS_MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs TTS ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Returns the clip for `text`, generating and caching it on first use. */
export async function clip(text: string): Promise<Clip> {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const key = clipKey(text);
  const file = join(AUDIO_DIR, `${key}.mp3`);
  if (!existsSync(file)) {
    writeFileSync(file, await synthesize(text));
    const manifest = readManifest();
    manifest[key] = {
      text,
      voiceId: EXPERT_VOICE_ID,
      modelId: TTS_MODEL_ID,
      outputFormat: OUTPUT_FORMAT,
      label: SYNTHETIC_LABEL,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { key, text, file, base64: readFileSync(file).toString("base64"), label: SYNTHETIC_LABEL };
}

export async function clips(texts: readonly string[]): Promise<Map<string, Clip>> {
  const out = new Map<string, Clip>();
  for (const text of texts) out.set(text, await clip(text));
  return out;
}
