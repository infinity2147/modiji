/**
 * Records a video as a sequence of beats (one Playwright context with `recordVideo` per beat) and
 * assembles them with ffmpeg: trimmed beat videos concatenated, narration and recorded audio placed on
 * one audio track at the times they were cued during recording, and an SRT built from the TTS alignment.
 *
 * Narration is cued live while the browser acts (`beat.say(id)` waits for the segment's real duration),
 * so picture and voice stay in sync without guessing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "./playwright";
import { cues, type Voiced } from "./narration";
import { run } from "./ffmpeg";

type AudioEvent = { kind: "narration"; id: string; at: number } | { kind: "clip"; file: string; from: number; to: number; at: number; gain: number };
type Cue = { start: number; end: number; text: string };
type BeatRecord = { name: string; video: string; start: number; end: number; audio: AudioEvent[]; cues: Cue[] };

const LABEL_CSS = `position:fixed;z-index:2147483647;pointer-events:none;max-width:620px;padding:10px 16px;border-radius:10px;
background:rgba(17,19,24,.86);color:#f5f6f8;font:500 17px/1.35 Geist,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12)`;

export type LabelPos = "top-right" | "bottom-right" | "top-left" | "bottom-left" | "mid-right";
const POS: Record<LabelPos, string> = {
  "top-right": "top:150px;right:24px",
  "mid-right": "top:420px;right:24px",
  "bottom-right": "bottom:230px;right:24px",
  "top-left": "top:150px;left:24px",
  "bottom-left": "bottom:230px;left:24px",
};

export class Beat {
  readonly audio: AudioEvent[] = [];
  readonly cues: Cue[] = [];
  private startMs = Date.now();
  private endMs: number | null = null;
  constructor(
    readonly page: Page,
    readonly t0: number,
    private readonly voiced: Map<string, Voiced>,
  ) {}
  /** The beat starts now (everything before is trimmed away: page loads, seeding). */
  mark(): void {
    this.startMs = Date.now();
  }
  end(): void {
    this.endMs = Date.now();
  }
  get startSec(): number {
    return (this.startMs - this.t0) / 1000;
  }
  get endSec(): number {
    return ((this.endMs ?? Date.now()) - this.t0) / 1000;
  }
  private now(): number {
    return (Date.now() - this.startMs) / 1000;
  }
  /** Cues a narration segment now; resolves when it has been spoken (its real TTS duration). */
  say(id: string): Promise<void> {
    const v = this.voiced.get(id);
    if (v === undefined) throw new Error(`no voiced narration ${id}`);
    const at = this.now();
    this.audio.push({ kind: "narration", id, at });
    for (const c of cues(v)) this.cues.push({ start: at + c.start, end: at + c.end, text: c.text });
    return new Promise((r) => setTimeout(r, v.duration * 1000 + 150));
  }
  /** Plays [from, to] of a recorded audio file now, with subtitle lines at offsets within the clip. */
  clip(file: string, from: number, to: number, lines: { at: number; until: number; text: string }[], gain = 1): Promise<void> {
    const at = this.now();
    this.audio.push({ kind: "clip", file, from, to, at, gain });
    for (const l of lines) this.cues.push({ start: at + l.at, end: at + l.until, text: l.text });
    return new Promise((r) => setTimeout(r, (to - from) * 1000 + 100));
  }
  wait(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }
  /** A provenance label drawn over the page (recording overlay only; the product UI is untouched). */
  async label(html: string, pos: LabelPos = "top-right"): Promise<void> {
    const js = `(() => { let el = document.getElementById("__story_label"); if (!el) { el = document.createElement("div"); el.id = "__story_label"; document.body.appendChild(el); }
      el.setAttribute("style", ${JSON.stringify(`${LABEL_CSS};${POS[pos]}`)}); el.innerHTML = ${JSON.stringify(html)}; })()`;
    await this.page.evaluate(js);
  }
  async unlabel(): Promise<void> {
    await this.page.evaluate(`document.getElementById("__story_label")?.remove()`);
  }
}

export class Production {
  readonly beats: BeatRecord[] = [];
  constructor(
    private readonly browser: Browser,
    private readonly videoDir: string,
    private readonly voiced: Map<string, Voiced>,
  ) {}

  async beat(name: string, fn: (b: Beat, ctx: BrowserContext) => Promise<void>): Promise<void> {
    const ctx = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: this.videoDir, size: { width: 1920, height: 1080 } },
      timezoneId: "UTC",
      locale: "en-GB",
      colorScheme: "light",
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    const b = new Beat(page, t0, this.voiced);
    try {
      await fn(b, ctx);
      b.end();
    } finally {
      await ctx.close();
    }
    const video = await page.video()?.path();
    if (video === undefined) throw new Error(`beat ${name}: no video`);
    this.beats.push({ name, video, start: b.startSec, end: b.endSec, audio: b.audio, cues: b.cues });
    console.info(`  beat ${name}: ${(b.endSec - b.startSec).toFixed(1)} s`);
  }

  /** Beat records next to the raw videos, so a run can be re-assembled without re-recording (`--assemble-only`). */
  save(): void {
    writeFileSync(join(this.videoDir, "beats.json"), JSON.stringify(this.beats, null, 1));
  }
  load(): void {
    this.beats.push(...(JSON.parse(readFileSync(join(this.videoDir, "beats.json"), "utf8")) as BeatRecord[]));
  }

  /**
   * ffmpeg, in three steps (each simple enough that no multi-input graph has to re-initialise mid-stream):
   * 1. every beat trimmed and normalised to the same H.264 intermediate, then joined with the concat demuxer;
   * 2. one audio track: silence and audio pieces (narration, recorded clips) as uniform WAVs, joined the same way;
   * 3. the final mux: H.264 + AAC (loudness-normalised) + the SRT as a soft subtitle track.
   */
  assemble(ffmpeg: string, out: { mp4: string; srt: string; title: string }): { duration: number; srt: string } {
    const dir = this.videoDir;
    const pad = (n: number): string => String(n).padStart(2, "0");
    const subtitles: Cue[] = [];
    const events: { at: number; source: string; from?: number; to?: number; dur: number; gain: number }[] = [];
    const videoList: string[] = [];
    let offset = 0;
    this.beats.forEach((beat, i) => {
      const norm = join(dir, `beat-${pad(i)}.mkv`);
      // Playwright writes frames only when the page changes: fps=25 first fills the gaps with the previous frame,
      // then the beat is cut, and laid over a black clip of the exact duration so a static ending is held.
      const d = (beat.end - beat.start).toFixed(3);
      run(ffmpeg, [
        "-i",
        beat.video,
        "-filter_complex",
        `color=c=black:s=1920x1080:r=25:d=${d}[bg];[0:v]fps=25,trim=start=${beat.start.toFixed(3)}:end=${beat.end.toFixed(3)},setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[v];[bg][v]overlay=eof_action=repeat,format=yuv420p`,
        "-t",
        d,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "14",
        "-g",
        "50",
        norm,
      ]);
      videoList.push(`file '${norm}'`);
      for (const c of beat.cues) subtitles.push({ start: offset + c.start, end: offset + c.end, text: c.text });
      for (const a of beat.audio) {
        if (a.kind === "narration") {
          const v = this.voiced.get(a.id);
          if (v === undefined) throw new Error(`no voiced ${a.id}`);
          events.push({ at: offset + a.at, source: v.audio, dur: v.duration, gain: 1 });
        } else {
          events.push({ at: offset + a.at, source: a.file, from: a.from, to: a.to, dur: a.to - a.from, gain: a.gain });
        }
      }
      offset += beat.end - beat.start;
    });
    const total = offset;
    const videoListFile = join(dir, "video-list.txt");
    writeFileSync(videoListFile, `${videoList.join("\n")}\n`);
    const video = join(dir, "video.mkv");
    run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", videoListFile, "-c", "copy", video]);

    events.sort((x, y) => x.at - y.at);
    const audioList: string[] = [];
    const silence = (k: string, seconds: number): void => {
      const f = join(dir, `sil-${k}.wav`);
      run(ffmpeg, ["-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`, "-t", seconds.toFixed(3), "-c:a", "pcm_s16le", f]);
      audioList.push(`file '${f}'`);
    };
    let cursor = 0;
    events.forEach((e, k) => {
      const gap = e.at - cursor;
      if (gap < -0.25) throw new Error(`audio events overlap at ${e.at.toFixed(2)} s (previous ends ${cursor.toFixed(2)} s)`);
      if (gap > 0.01) silence(pad(k), gap);
      const wav = join(dir, `aud-${pad(k)}.wav`);
      const trim = e.from === undefined ? "" : `atrim=start=${e.from.toFixed(3)}:end=${(e.to ?? 0).toFixed(3)},asetpts=PTS-STARTPTS,`;
      const lead = gap < 0 ? `atrim=start=${(-gap).toFixed(3)},asetpts=PTS-STARTPTS,` : "";
      run(ffmpeg, ["-i", e.source, "-af", `${trim}${lead}aresample=44100,volume=${e.gain}`, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav]);
      audioList.push(`file '${wav}'`);
      cursor = e.at + e.dur;
    });
    if (total - cursor > 0.01) silence("end", total - cursor);
    const audioListFile = join(dir, "audio-list.txt");
    writeFileSync(audioListFile, `${audioList.join("\n")}\n`);
    const audio = join(dir, "audio.wav");
    run(ffmpeg, ["-f", "concat", "-safe", "0", "-i", audioListFile, "-c", "copy", audio]);

    writeFileSync(out.srt, toSrt(subtitles));
    run(ffmpeg, [
      "-i",
      video,
      "-i",
      audio,
      "-i",
      out.srt,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-map",
      "2:s",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "23",
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "25",
      "-af",
      `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${total.toFixed(3)}`,
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-c:s",
      "mov_text",
      "-metadata:s:s:0",
      "language=eng",
      "-metadata",
      `title=${out.title}`,
      "-t",
      total.toFixed(3),
      "-movflags",
      "+faststart",
      out.mp4,
    ]);
    return { duration: total, srt: out.srt };
  }

}

const ts = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function toSrt(list: Cue[]): string {
  return (
    [...list]
      .sort((a, b) => a.start - b.start)
      .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(Math.max(c.end, c.start + 0.8))}\n${c.text}\n`)
      .join("\n") + "\n"
  );
}

