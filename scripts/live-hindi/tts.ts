/**
 * Synthetic expert speech for the live Hindi run: ElevenLabs text-to-speech
 * (`POST /v1/text-to-speech/{voice_id}?output_format=…`), multilingual model, raw PCM out. The API key
 * travels only in the `xi-api-key` header and is never echoed in errors.
 */

export type TtsRequest = {
  apiKey: string;
  voiceId: string;
  text: string;
  /** e.g. `eleven_multilingual_v2` (speaks Hindi from Devanagari text). */
  modelId: string;
  /** e.g. `pcm_16000`: must match the agent's `user_input_audio_format`. */
  outputFormat: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

export async function synthesizeSpeech(req: TtsRequest): Promise<Uint8Array> {
  const fetchImpl = req.fetch ?? globalThis.fetch;
  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(req.voiceId)}`, req.baseUrl ?? "https://api.elevenlabs.io");
  url.searchParams.set("output_format", req.outputFormat);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "xi-api-key": req.apiKey, "content-type": "application/json", accept: "application/octet-stream" },
    body: JSON.stringify({ text: req.text, model_id: req.modelId }),
    signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).replaceAll(req.apiKey, "[redacted]").slice(0, 300);
    throw new Error(`text-to-speech ${url.pathname} returned HTTP ${response.status}: ${detail}`);
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.byteLength === 0) throw new Error("text-to-speech returned no audio");
  return audio;
}
