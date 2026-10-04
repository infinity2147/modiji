/**
 * Raw 16-bit little-endian mono PCM helpers for the live Hindi run: the ElevenLabs agent WebSocket takes
 * `user_audio_chunk` frames of base64 audio in the agent's `user_input_audio_format` (e.g. `pcm_16000`).
 */

const BYTES_PER_SAMPLE = 2;

/** Sample rate of a `pcm_<rate>` format, or null for any other format (ulaw, mp3, …). */
export function pcmSampleRate(format: string): number | null {
  const match = /^pcm_(\d{4,6})$/.exec(format);
  return match === null ? null : Number(match[1]);
}

/** Splits PCM into chunks of `chunkMs` (the last one may be shorter); never splits a sample. */
export function pcmChunks(pcm: Uint8Array, sampleRate: number, chunkMs: number): Uint8Array[] {
  const size = Math.max(BYTES_PER_SAMPLE, Math.round((sampleRate * chunkMs) / 1000) * BYTES_PER_SAMPLE);
  const usable = pcm.byteLength - (pcm.byteLength % BYTES_PER_SAMPLE);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < usable; at += size) chunks.push(pcm.subarray(at, Math.min(at + size, usable)));
  return chunks;
}

export function pcmSilence(sampleRate: number, ms: number): Uint8Array {
  return new Uint8Array(Math.round((sampleRate * ms) / 1000) * BYTES_PER_SAMPLE);
}

export function pcmDurationMs(pcm: Uint8Array, sampleRate: number): number {
  return Math.round((pcm.byteLength / BYTES_PER_SAMPLE / sampleRate) * 1000);
}

/** A playable WAV file around raw PCM (evidence artefact). */
export function wavFile(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}
