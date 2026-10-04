/**
 * The live Hindi run's offline parts: PCM chunking/WAV, the real-time audio streamer against a scripted
 * agent socket, TTS request shape (key never echoed), and the target API's error reporting.
 */
import { describe, expect, it } from "vitest";
import { pcmChunks, pcmDurationMs, pcmSampleRate, pcmSilence, wavFile } from "../live-hindi/audio";
import { streamSpeech } from "../live-hindi/stream";
import { createTargetApi, TargetError } from "../live-hindi/target-api";
import { synthesizeSpeech } from "../live-hindi/tts";
import { VoiceSession, type WebSocketFactory, type WebSocketHandlers } from "../preflight/voice-session";

describe("PCM helpers", () => {
  it("parses pcm formats only", () => {
    expect(pcmSampleRate("pcm_16000")).toBe(16_000);
    expect(pcmSampleRate("ulaw_8000")).toBeNull();
    expect(pcmSampleRate("mp3_44100_128")).toBeNull();
  });

  it("chunks by duration without splitting a sample, and sizes silence and WAV", () => {
    const pcm = new Uint8Array(16_000 * 2 + 1); // 1 s plus a stray byte (half a sample)
    const chunks = pcmChunks(pcm, 16_000, 100);
    expect(chunks).toHaveLength(10);
    expect(chunks.every((c) => c.byteLength === 3200)).toBe(true);
    expect(pcmDurationMs(pcmSilence(16_000, 250), 16_000)).toBe(250);
    const wav = wavFile(new Uint8Array(3200), 16_000);
    expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(Buffer.from(wav).readUInt32LE(24)).toBe(16_000);
    expect(wav.byteLength).toBe(44 + 3200);
  });
});

/** A scripted agent socket: metadata on open; a transcript once `transcriptAfter` audio chunks arrived. */
function agentSocket(transcriptAfter: number, transcript: string) {
  const sent: Record<string, unknown>[] = [];
  let handlers: WebSocketHandlers | undefined;
  const factory: WebSocketFactory = (_url, h) => {
    handlers = h;
    queueMicrotask(() => h.open());
    return {
      send(data) {
        const message = JSON.parse(data) as Record<string, unknown>;
        sent.push(message);
        if (message.type === "conversation_initiation_client_data")
          queueMicrotask(() =>
            h.message(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { conversation_id: "conv_1", user_input_audio_format: "pcm_16000" } })),
          );
        if ("user_audio_chunk" in message && sent.filter((m) => "user_audio_chunk" in m).length === transcriptAfter)
          queueMicrotask(() => h.message(JSON.stringify({ type: "user_transcript", user_transcription_event: { user_transcript: transcript, event_id: 3 } })));
      },
      close: (code, reason) => handlers?.close(code ?? 1000, reason ?? ""),
    };
  };
  return { factory, sent };
}

describe("streamSpeech", () => {
  it("streams base64 PCM in real-time chunks plus trailing silence and returns the final transcript", async () => {
    const hindi = "अगर देश हाई-रिस्क लिस्ट पर है तो मैं अप्रूव नहीं करती।";
    const { factory, sent } = agentSocket(5, hindi);
    let clock = 0;
    const sleeps: number[] = [];
    const session = await VoiceSession.connect({ factory, url: "wss://example/agent", initiation: { custom_llm_extra_body: { sessionId: "s-1" } }, timeoutMs: 1000, now: () => clock });
    const pcm = new Uint8Array(16_000 * 2 * 0.3); // 300 ms
    const result = await streamSpeech(session, pcm, {
      sampleRate: 16_000,
      chunkMs: 100,
      trailingSilenceMs: 200,
      transcriptTimeoutMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
    });
    const audio = sent.filter((m) => "user_audio_chunk" in m);
    expect(audio).toHaveLength(5);
    expect(Buffer.from(String(audio[0]?.user_audio_chunk), "base64").byteLength).toBe(3200);
    expect(sleeps).toEqual([100, 100, 100, 100, 100]);
    expect(result).toMatchObject({ transcript: hindi, chunksSent: 5, speechStartedAt: 0 });
    await session.close();
  });

  it("reports no transcript when the agent never sends one", async () => {
    const { factory } = agentSocket(99, "x");
    const session = await VoiceSession.connect({ factory, url: "wss://example/agent", initiation: {}, timeoutMs: 1000, now: Date.now });
    const result = await streamSpeech(session, new Uint8Array(3200), { sampleRate: 16_000, chunkMs: 100, trailingSilenceMs: 0, transcriptTimeoutMs: 20, sleep: () => Promise.resolve(), now: Date.now });
    expect(result.transcript).toBeNull();
    await session.close();
  });
});

describe("synthesizeSpeech", () => {
  it("posts text and model with the key in the header only; errors never echo the key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4])));
    };
    const audio = await synthesizeSpeech({ apiKey: "xi-secret-key", voiceId: "v 1", text: "नमस्ते", modelId: "eleven_multilingual_v2", outputFormat: "pcm_16000", fetch: ok });
    expect([...audio]).toEqual([1, 2, 3, 4]);
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/v%201?output_format=pcm_16000");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "नमस्ते", model_id: "eleven_multilingual_v2" });
    const failing: typeof fetch = () => Promise.resolve(new Response("bad key xi-secret-key", { status: 401 }));
    await expect(synthesizeSpeech({ apiKey: "xi-secret-key", voiceId: "v", text: "x", modelId: "m", outputFormat: "pcm_16000", fetch: failing })).rejects.toThrow(/HTTP 401: bad key \[redacted\]/);
  });
});

describe("target API", () => {
  it("names the server's error code, and what a response lacks", async () => {
    const api = createTargetApi({
      baseUrl: "http://server",
      fetch: (url) =>
        Promise.resolve(
          String(url).endsWith("/utterances")
            ? new Response(JSON.stringify({ error: "invalid_request", detail: "language: unrecognized key" }), { status: 400 })
            : new Response(JSON.stringify({ queue: [{ id: "q", kind: "why_probe" }], contextVersion: 1 }), { headers: { "content-type": "application/json" } }),
        ),
    });
    const refused = await api.postUtterance("s", {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TargetError);
    expect(refused).toMatchObject({ status: 400, code: "invalid_request", message: "POST /api/sessions/s/utterances → HTTP 400 invalid_request: language: unrecognized key" });
    await expect(api.questions("s")).rejects.toThrow("unexpected response (text: expected a text)");
  });
});
