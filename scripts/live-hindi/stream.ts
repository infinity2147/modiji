/**
 * Streams synthetic speech into a live ElevenLabs agent conversation the way a microphone would: PCM in
 * `chunkMs` frames at real-time pacing (`user_audio_chunk`, base64), then trailing silence so the turn
 * ends, and waits for the final `user_transcript`. Works on `VoiceSession` (scripts/preflight), so tests
 * drive it with a scripted fake socket.
 */
import type { VoiceSession } from "../preflight/voice-session";
import { pcmChunks, pcmSilence } from "./audio";

export type StreamOptions = {
  sampleRate: number;
  chunkMs: number;
  trailingSilenceMs: number;
  transcriptTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type StreamResult = {
  /** The final transcript ElevenLabs' ASR produced for the streamed speech; null when none arrived. */
  transcript: string | null;
  chunksSent: number;
  /** Clock (`now`) when the first speech chunk was sent and when the transcript arrived. */
  speechStartedAt: number;
  transcriptAt: number | null;
};

function transcriptOf(body: Record<string, unknown>): string | null {
  const event = body.user_transcription_event;
  if (event === null || typeof event !== "object") return null;
  const text = (event as Record<string, unknown>).user_transcript;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

export async function streamSpeech(session: VoiceSession, pcm: Uint8Array, options: StreamOptions): Promise<StreamResult> {
  const from = session.events.length;
  const frames = [...pcmChunks(pcm, options.sampleRate, options.chunkMs), ...pcmChunks(pcmSilence(options.sampleRate, options.trailingSilenceMs), options.sampleRate, options.chunkMs)];
  const speechStartedAt = options.now();
  let chunksSent = 0;
  const started = options.now();
  for (const [i, frame] of frames.entries()) {
    session.send({ user_audio_chunk: Buffer.from(frame).toString("base64") });
    chunksSent += 1;
    // Real-time pacing against the wall clock, so send jitter does not accumulate.
    const due = started + (i + 1) * options.chunkMs - options.now();
    if (due > 0) await options.sleep(due);
    if (session.closed !== null) break;
  }
  const found = () => session.since(from, "user_transcript").map((e) => transcriptOf(e.body)).find((t) => t !== null);
  await session.waitFor(() => found() !== undefined || session.closed !== null, options.transcriptTimeoutMs);
  const transcript = found() ?? null;
  const event = session.since(from, "user_transcript").find((e) => transcriptOf(e.body) !== null);
  return { transcript, chunksSent, speechStartedAt, transcriptAt: event?.at ?? null };
}
