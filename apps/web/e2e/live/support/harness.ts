/**
 * In-page harness for the LIVE runs, installed with `page.addInitScript` before any app code runs.
 * Test-side only: no product code is changed or hooked through app internals. It provides
 *
 * 1. a controllable MICROPHONE: `navigator.mediaDevices.getUserMedia({audio})` returns a fresh
 *    MediaStreamDestination stream fed by one WebAudio bus; the test plays decoded TTS clips (synthetic
 *    voice input, ElevenLabs TTS) and optional noise into it, so the script knows exactly when the
 *    "expert" is speaking (local start/end times);
 * 2. a SCREEN: `getDisplayMedia` returns a canvas stream (as e2e/perception.spec.ts) the test draws on;
 * 3. INSTRUMENTATION, by wrapping browser APIs only:
 *    - RTCDataChannel.send: the gate's control message (`⟦ctl:…⟧`, inside LiveKit's data packet) leaving
 *      the browser, and every other outgoing ElevenLabs client event;
 *    - RTCPeerConnection data channels: incoming ElevenLabs events (agent_response, user_transcript,
 *      vad_score, agent_tool_response, interruption …);
 *    - RTCPeerConnection `track`: the agent's remote audio, measured with an AnalyserNode (RMS every
 *      20 ms) → `agent_audio_start` / `agent_audio_end`;
 *    - window.fetch: gate/authorize, utterances and agent-utterances requests with timings and bodies;
 *    - capture-phase keydown and scroll listeners: ground-truth typing and scrolling times;
 *    - the voice panel's "Agent speaking" text (the SDK's mode) via a MutationObserver.
 *
 * Every event is `{ t: Date.now(), type, ... }`, the same clock the gate uses (systemClock = Date.now).
 */
export type HarnessEvent = { t: number; type: string; [key: string]: unknown };

export type HarnessOptions = { agentRmsThreshold: number; agentSilenceMs: number };

/** Serialized into the page by Playwright: must be self-contained. */
export function installHarness(options: HarnessOptions): void {
  const events: HarnessEvent[] = [];
  const rec = (type: string, data: Record<string, unknown> = {}): void => {
    events.push({ t: Date.now(), type, ...data });
  };
  const textOf = (data: unknown): string | null => {
    try {
      if (typeof data === "string") return data;
      if (data instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(data));
      if (ArrayBuffer.isView(data)) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch {
      return null;
    }
    return null;
  };
  const jsonIn = (text: string): Record<string, unknown> | null => {
    const start = text.indexOf('{"');
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // ── microphone ──
  let ctx: AudioContext | null = null;
  let bus: GainNode | null = null;
  let noise: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  const buffers = new Map<string, AudioBuffer>();
  const audio = (): { ctx: AudioContext; bus: GainNode } => {
    if (ctx === null || bus === null) {
      ctx = new AudioContext({ sampleRate: 48000 });
      bus = ctx.createGain();
      bus.gain.value = 1;
    }
    return { ctx, bus };
  };
  const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
  if (mediaDevices) {
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (constraints?.audio && !constraints.video) {
        const a = audio();
        await a.ctx.resume();
        const destination = a.ctx.createMediaStreamDestination();
        a.bus.connect(destination);
        rec("mic_opened", { constraints: JSON.stringify(constraints).slice(0, 300) });
        return destination.stream;
      }
      return originalGetUserMedia(constraints);
    };
  }

  // ── screen ──
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  let lines: string[] = ["Northstar CaseDesk"];
  let scrollOffset = 0;
  const draw = (): void => {
    const c = canvas.getContext("2d");
    if (!c) return;
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = "#1e293b";
    c.fillRect(0, 0, canvas.width, 56);
    c.fillStyle = "#ffffff";
    c.font = "bold 26px sans-serif";
    c.fillText("Northstar CaseDesk — synthetic screen (live runner)", 24, 37);
    c.fillStyle = "#111111";
    c.font = "28px sans-serif";
    lines.forEach((line, i) => c.fillText(line, 60, 120 + i * 52 - scrollOffset));
  };
  draw();
  setInterval(draw, 100);
  if (mediaDevices) mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);

  // ── agent audio (remote track) ──
  const watchRemoteAudio = (track: MediaStreamTrack): void => {
    const actx = new AudioContext();
    const source = actx.createMediaStreamSource(new MediaStream([track]));
    const analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let speaking = false;
    let lastLoud = 0;
    let peak = 0;
    rec("remote_audio_track", { id: track.id });
    setInterval(() => {
      void actx.resume();
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms >= options.agentRmsThreshold) {
        lastLoud = now;
        peak = Math.max(peak, rms);
        if (!speaking) {
          speaking = true;
          peak = rms;
          rec("agent_audio_start", { rms: Math.round(rms * 1000) / 1000 });
        }
      } else if (speaking && now - lastLoud >= options.agentSilenceMs) {
        speaking = false;
        events.push({ t: lastLoud, type: "agent_audio_end", peak: Math.round(peak * 1000) / 1000, detectedAt: now });
      }
    }, 20);
  };

  // ── WebRTC data channels ──
  const incoming = (data: unknown): void => {
    const text = textOf(data);
    if (text === null) return;
    const msg = jsonIn(text);
    if (msg === null || typeof msg.type !== "string") return;
    const type = msg.type;
    if (type === "ping") return;
    if (type === "vad_score") {
      const v = (msg.vad_score_event as { vad_score?: number } | undefined)?.vad_score;
      rec("vad", { v });
      return;
    }
    if (type === "agent_response")
      rec("agent_response", { text: (msg.agent_response_event as { agent_response?: string } | undefined)?.agent_response });
    else if (type === "user_transcript")
      rec("user_transcript", { text: (msg.user_transcription_event as { user_transcript?: string } | undefined)?.user_transcript });
    else rec(`el_${type}`, { raw: JSON.stringify(msg).slice(0, 400) });
  };
  const hookChannel = (channel: RTCDataChannel): void => {
    channel.addEventListener("message", (event: MessageEvent) => incoming(event.data));
  };
  const OriginalPC = window.RTCPeerConnection;
  class InstrumentedPC extends OriginalPC {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      this.addEventListener("datachannel", (event: RTCDataChannelEvent) => hookChannel(event.channel));
      this.addEventListener("track", (event: RTCTrackEvent) => {
        if (event.track.kind === "audio") watchRemoteAudio(event.track);
      });
    }
    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      hookChannel(channel);
      return channel;
    }
  }
  window.RTCPeerConnection = InstrumentedPC;
  const originalSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function send(this: RTCDataChannel, data: never) {
    const text = textOf(data);
    if (text !== null && text.includes("ctl:")) rec("ctl_sent", { bytes: text.length });
    else if (text !== null) {
      const msg = jsonIn(text);
      if (msg !== null && typeof msg.type === "string" && msg.type !== "pong") rec(`out_${msg.type}`);
    }
    return originalSend.call(this, data);
  } as RTCDataChannel["send"];

  // ── fetch ──
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const watched = /\/gate\/authorize|\/utterances|\/agent-utterances|\/voice\/token/.exec(url)?.[0];
    if (watched === undefined) return originalFetch(input, init);
    const sentAt = Date.now();
    const body = typeof init?.body === "string" ? init.body.slice(0, 2000) : undefined;
    try {
      const response = await originalFetch(input, init);
      const text = await response.clone().text();
      events.push({ t: sentAt, type: `fetch${watched.replace(/\//g, "_")}`, url, status: response.status, doneAt: Date.now(), body: watched === "/voice/token" ? undefined : body, response: watched === "/voice/token" ? undefined : text.slice(0, 2000) });
      return response;
    } catch (error) {
      events.push({ t: sentAt, type: `fetch${watched.replace(/\//g, "_")}`, url, error: String(error), doneAt: Date.now() });
      throw error;
    }
  };

  // ── ground-truth activity ──
  document.addEventListener("keydown", (event) => rec("key", { key: event.key.length === 1 ? "char" : event.key }), true);
  // Ground truth for scrolling is the user's wheel input; `scroll` events (which also fire for
  // programmatic scrolls such as the transcript log following new turns) are kept for diagnostics.
  let lastWheelRec = 0;
  document.addEventListener(
    "wheel",
    () => {
      const now = Date.now();
      if (now - lastWheelRec >= 50) {
        lastWheelRec = now;
        rec("wheel");
      }
    },
    { capture: true, passive: true },
  );
  let lastScrollRec = 0;
  document.addEventListener(
    "scroll",
    (event) => {
      const now = Date.now();
      if (now - lastScrollRec >= 50) {
        lastScrollRec = now;
        const target = event.target instanceof Element ? event.target : null;
        rec("scroll", { gateIgnored: target?.closest("[data-gate-ignore]") != null, target: target?.tagName ?? "document" });
      }
    },
    { capture: true, passive: true },
  );
  // The SDK's speaking mode as the voice panel renders it.
  let lastMode = "";
  const watchMode = (): void => {
    const text = document.querySelector('ul[aria-label="Sensing"]')?.textContent ?? "";
    const mode = text.includes("Agent speaking") ? "speaking" : text.includes("Agent silent") ? "silent" : "";
    if (mode !== "" && mode !== lastMode) {
      lastMode = mode;
      rec("ui_agent_mode", { mode });
    }
  };
  setInterval(watchMode, 50);

  const api = {
    events,
    since: (index: number) => events.slice(index),
    async load(key: string, base64: string): Promise<number> {
      const a = audio();
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const buffer = await a.ctx.decodeAudioData(bytes.buffer);
      buffers.set(key, buffer);
      return buffer.duration;
    },
    /** Plays a loaded clip into the microphone bus; resolves with its local start/end times. */
    play(key: string, gain = 1, label = ""): Promise<{ start: number; end: number }> {
      const a = audio();
      const buffer = buffers.get(key);
      if (!buffer) return Promise.reject(new Error(`clip ${key} not loaded`));
      void a.ctx.resume();
      return new Promise((resolve) => {
        const source = a.ctx.createBufferSource();
        source.buffer = buffer;
        const g = a.ctx.createGain();
        g.gain.value = gain;
        source.connect(g).connect(a.bus);
        const start = Date.now();
        rec("speech_start", { key, gain, label, durationMs: Math.round(buffer.duration * 1000) });
        source.onended = () => {
          const end = Date.now();
          rec("speech_end", { key, label });
          resolve({ start, end });
        };
        source.start();
      });
    },
    /** Background noise (white, looped) into the microphone bus; level 0 stops it. */
    noise(level: number): void {
      const a = audio();
      if (noise) {
        noise.source.stop();
        noise = null;
        rec("noise_off");
      }
      if (level <= 0) return;
      const length = a.ctx.sampleRate * 2;
      const buffer = a.ctx.createBuffer(1, length, a.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      const source = a.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = a.ctx.createGain();
      gain.gain.value = level;
      source.connect(gain).connect(a.bus);
      source.start();
      noise = { source, gain };
      rec("noise_on", { level });
    },
    screen(next: string[], offset = 0): void {
      lines = next;
      scrollOffset = offset;
      draw();
    },
    mark(label: string, data: Record<string, unknown> = {}): void {
      rec("mark", { label, ...data });
    },
  };
  Object.defineProperty(window, "__live", { value: api });
}

export type LiveApi = {
  events: HarnessEvent[];
  since: (index: number) => HarnessEvent[];
  load: (key: string, base64: string) => Promise<number>;
  play: (key: string, gain?: number, label?: string) => Promise<{ start: number; end: number }>;
  noise: (level: number) => void;
  screen: (lines: string[], offset?: number) => void;
  mark: (label: string, data?: Record<string, unknown>) => void;
};
