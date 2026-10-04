/**
 * `pnpm live:hindi [--target <url>] [--transcript asr|script] [--voice <id>] [--text <hindi>] [--tts-only] [--out <dir>]`
 *
 * P10 acceptance, "Hindi→English run" (plan §7.11, §11): a Hindi-speaking expert's answer goes through the real
 * system and comes out as a language-neutral rule with the Hindi quote as evidence and an English translation for
 * the tutor and agents. Every artefact is labelled SYNTHETIC VOICE INPUT: the "expert" is ElevenLabs text-to-speech.
 *
 * 1. Synthesises the scripted Hindi answer with ElevenLabs TTS (multilingual model) as PCM in the interviewer
 *    agent's `user_input_audio_format`.
 * 2. Through the target server's public API (as the browser does): creates an expert session (named expert,
 *    language "hi"), opens and decides a high-risk training case, uploads a redacted screen frame (evidence needs
 *    one), waits for the live question queue (Hindi questions with the English alongside on a P10 server) and
 *    authorises the top question at the gate.
 * 3. `--transcript asr` (default): opens the interviewer agent's WebSocket (signed URL; ASR language "hi" when the
 *    agent allows that client override), has the agent speak the authorised question when the agent's custom LLM is
 *    the target, streams the speech as `user_audio_chunk` frames at real-time pacing plus trailing silence, and
 *    takes ElevenLabs' `user_transcript`. `--transcript script` skips ElevenLabs and posts the scripted text itself
 *    (labelled as such) — for exercising the server chain while the agents are busy.
 * 4. Posts the transcript as the answer (utterance POST with the question id and `language: "hi"`) and reads back:
 *    the stored utterance and its translation, the parsed answer, the confirmed rule (forbid approve when
 *    jurisdictionRisk == high; Hindi exactQuote + English translation), `/mcp` check_action's citation, and the
 *    tutor's view of the rule.
 *
 * Evidence: <out>/hindi-run.json, <out>/hindi-run.txt and <out>/hindi-run-synthetic-voice.wav (default out:
 * docs/evidence/p10). Never written: API keys, the MCP token, signed URLs or the gate's control message (nonce).
 * Reads .env from the repo root (real env vars win). Exit 0 only when every acceptance check passed.
 */
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createElevenLabsClient } from "../packages/core/src/server/elevenlabs";
import { nodeWebSocketFactory, VoiceSession } from "./preflight/voice-session";
import { pcmDurationMs, pcmSampleRate, wavFile } from "./live-hindi/audio";
import { streamSpeech } from "./live-hindi/stream";
import { createTargetApi, TargetError, type TargetApi } from "./live-hindi/target-api";
import { synthesizeSpeech } from "./live-hindi/tts";

// Prefer IPv4: on networks with broken IPv6 routes, Node's fetch otherwise hits its 10 s connect timeout.
setDefaultResultOrder("ipv4first");

const LABEL = "SYNTHETIC VOICE INPUT — the expert's speech is ElevenLabs text-to-speech, not a person";
const DEFAULT_TARGET = "https://vashistha-production.up.railway.app";
/** "If the country is on the high-risk list, I do not approve at desk level. Such a case first goes to enhanced review." */
const DEFAULT_TEXT = "अगर देश हाई-रिस्क लिस्ट पर है, तो मैं डेस्क लेवल पर अप्रूव नहीं करती। ऐसे केस में पहले एन्हांस्ड रिव्यू होता है।";
/** A premade multilingual voice distinct from the interviewer's (override with --voice). */
const DEFAULT_VOICE = "XrExE9yKIg1WjnnlVkGX";
const TTS_MODEL = "eleven_multilingual_v2";
const EXPERT = { name: "Priya Sharma (synthetic)", language: "hi" as const };
/** Training case with jurisdictionRisk = high (NS-2026-0102); the expert sends it to enhanced review. */
const CASE = { id: "NS-2026-0102", action: "enhancedReview", riskRating: "high" };
const FRAME = { path: fileURLToPath(new URL("../docs/evidence/p1/case-1.png", import.meta.url)), width: 1440, height: 900 };
const CHUNK_MS = 100;

type Check = { name: string; ok: boolean; detail: string };
type Evidence = Record<string, unknown> & { label: string; checks: Check[]; steps: { at: string; step: string; detail: string }[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
/** `v.path[0].path[1]…` through objects and (numeric keys) arrays; undefined when any step is missing. */
function at(v: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((node, key) => (Array.isArray(node) ? node[Number(key)] : isRecord(node) ? node[key] : undefined), v);
}
const DEVANAGARI = /[ऀ-ॿ]/;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: "string", default: DEFAULT_TARGET },
      transcript: { type: "string", default: "asr" },
      voice: { type: "string", default: DEFAULT_VOICE },
      text: { type: "string", default: DEFAULT_TEXT },
      "tts-only": { type: "boolean", default: false },
      out: { type: "string" },
    },
    strict: true,
  });
  if (values.transcript !== "asr" && values.transcript !== "script") throw new Error("--transcript must be asr or script");
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const target = values.target.replace(/\/+$/, "");
  const outDir = values.out ?? fileURLToPath(new URL("../docs/evidence/p10", import.meta.url));
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_INTERVIEWER_AGENT_ID;
  const evidence: Evidence = {
    label: LABEL,
    startedAt: new Date().toISOString(),
    target,
    transcriptSource: values.transcript === "asr" ? "ElevenLabs agent ASR (Scribe realtime) of the synthetic speech" : "scripted text (no ASR)",
    scriptedText: values.text,
    steps: [],
    checks: [],
  };
  const step = (name: string, detail: string): void => {
    evidence.steps.push({ at: new Date().toISOString(), step: name, detail });
    console.info(`· ${name}: ${detail}`);
  };
  const check = (name: string, ok: boolean, detail: string): void => {
    evidence.checks.push({ name, ok, detail });
    console.info(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  const finish = async (): Promise<number> => {
    evidence.finishedAt = new Date().toISOString();
    await mkdir(outDir, { recursive: true });
    await writeFile(`${outDir}/hindi-run.json`, `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(`${outDir}/hindi-run.txt`, summary(evidence));
    const failed = evidence.checks.filter((c) => !c.ok).length;
    console.info(`\n${LABEL}\nEvidence: ${outDir}/hindi-run.{json,txt}${failed === 0 ? "" : ` — ${failed} check(s) failed`}`);
    return failed === 0 && evidence.checks.length > 0 ? 0 : 1;
  };

  try {
    // ── 1. Agent audio format (and whether it accepts a Hindi ASR override), then TTS in that format ──
    const eleven = apiKey === undefined ? undefined : createElevenLabsClient({ apiKey });
    let audioFormat = "pcm_16000";
    let languageOverride = false;
    let agentLlmUrl: string | undefined;
    if (values.transcript === "asr" || values["tts-only"]) {
      if (eleven === undefined || agentId === undefined) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_INTERVIEWER_AGENT_ID are required");
      const agent = await eleven.getAgent(agentId);
      const format = at(agent, "conversation_config", "asr", "user_input_audio_format");
      if (typeof format === "string") audioFormat = format;
      languageOverride = at(agent, "platform_settings", "overrides", "conversation_config_override", "agent", "language") === true;
      const url = at(agent, "conversation_config", "agent", "prompt", "custom_llm", "url");
      agentLlmUrl = typeof url === "string" ? url : undefined;
      const modelId = String(at(agent, "conversation_config", "agent", "prompt", "custom_llm", "model_id"));
      const presets = at(agent, "conversation_config", "language_presets");
      const languagePresets = isRecord(presets) ? Object.keys(presets) : [];
      evidence.agent = { modelId, languagePresets, clientLanguageOverrideAllowed: languageOverride, userInputAudioFormat: audioFormat };
      step("agent", `${modelId}; presets [${languagePresets.join(", ")}]; client language override ${languageOverride ? "allowed" : "NOT allowed (sync agents v3)"}; input ${audioFormat}`);
    }
    const sampleRate = pcmSampleRate(audioFormat);
    if (sampleRate === null) throw new Error(`agent input format ${audioFormat} is not PCM; this run streams PCM`);
    let pcm: Uint8Array | undefined;
    if (values.transcript === "asr" || values["tts-only"]) {
      if (apiKey === undefined) throw new Error("ELEVENLABS_API_KEY is required for TTS");
      pcm = await synthesizeSpeech({ apiKey, voiceId: values.voice, text: values.text, modelId: TTS_MODEL, outputFormat: audioFormat });
      await mkdir(outDir, { recursive: true });
      await writeFile(`${outDir}/hindi-run-synthetic-voice.wav`, wavFile(pcm, sampleRate));
      evidence.tts = { label: LABEL, model: TTS_MODEL, voiceId: values.voice, outputFormat: audioFormat, durationMs: pcmDurationMs(pcm, sampleRate), wav: "hindi-run-synthetic-voice.wav" };
      step("tts", `${TTS_MODEL} → ${pcmDurationMs(pcm, sampleRate)} ms of ${audioFormat}`);
      if (values["tts-only"]) {
        check("tts produced audio", pcm.byteLength > 0, `${pcm.byteLength} bytes`);
        return await finish();
      }
    }

    // ── 2. Session, decision, frame, question ──
    const api = createTargetApi({ baseUrl: target, ...(process.env.MCP_BEARER_TOKEN !== undefined && { mcpBearer: process.env.MCP_BEARER_TOKEN }) });
    await api.health();
    const session = await api.createSession(EXPERT);
    const sessionId = session.sessionId;
    evidence.sessionId = sessionId;
    step("session", `${sessionId} expert ${JSON.stringify(session.expert ?? "(not echoed: server predates P10)")}`);
    await api.openCase(sessionId, CASE.id, session.privacyEpoch, CASE.riskRating);
    const decided = await api.decide(sessionId, CASE.id, CASE.action, CASE.riskRating);
    step("decision", `${CASE.id} → ${CASE.action}: ${decided.status}`);
    const frame = await api.uploadFrame(sessionId, FRAME, session.privacyEpoch, 1);
    step("frame", `redacted frame ${frame.ledgerId} (docs/evidence/p1/case-1.png)`);
    const question = await firstQuestion(api, sessionId);
    evidence.question = { id: question.id, kind: question.kind, text: question.text, textEnglish: question.textEnglish ?? null, language: question.language ?? null };
    step("question", `${question.kind}: ${question.text}${question.textEnglish === undefined ? "" : ` (English: ${question.textEnglish})`}`);

    // ── 3. Voice: agent asks, synthetic expert answers, ASR transcribes ──
    let transcript = values.text;
    let t0Ms = 0;
    let t1Ms = 5000;
    let conversationId = `scripted-${sessionId}`;
    if (values.transcript === "asr") {
      if (eleven === undefined || agentId === undefined || pcm === undefined) throw new Error("unreachable: ASR mode without agent or audio");
      const voice = await VoiceSession.connect({
        factory: nodeWebSocketFactory,
        url: await eleven.getSignedUrl(agentId),
        initiation: {
          custom_llm_extra_body: { sessionId },
          ...(languageOverride && { conversation_config_override: { agent: { language: EXPERT.language } } }),
        },
        timeoutMs: 15_000,
        now: Date.now,
      });
      const connectedAt = Date.now();
      try {
        conversationId = voice.conversationId ?? conversationId;
        const meta = voice.events.find((e) => e.type === "conversation_initiation_metadata")?.body;
        const metaFormat = at(meta, "conversation_initiation_metadata_event", "user_input_audio_format");
        step("voice", `conversation ${conversationId}; input ${String(metaFormat)}; ASR language ${languageOverride ? "hi (client override)" : "agent default"}`);
        if (metaFormat !== audioFormat) throw new Error(`conversation input format ${String(metaFormat)} differs from the agent's ${audioFormat}`);
        const { contextVersion } = await api.questions(sessionId);
        const granted = await api.authorize(sessionId, question.id, contextVersion);
        if (agentLlmUrl?.startsWith(target) === true) {
          const from = voice.events.length;
          voice.send({ type: "user_message", text: granted.controlMessage });
          await voice.waitFor(() => voice.since(from, "agent_response").length > 0, 20_000);
          const spoken = at(voice.since(from, "agent_response")[0]?.body, "agent_response_event", "agent_response");
          evidence.agentAsked = { authorisedText: granted.text, spokenText: spoken ?? null };
          check("agent spoke exactly the authorised question", spoken === granted.text, String(spoken ?? "no agent_response within 20 s"));
          // Let the question finish playing before the expert answers: wait for 1.5 s without agent audio.
          for (let quiet = voice.events.length; ; quiet = voice.events.length) {
            await sleep(1_500);
            if (!voice.since(quiet).some((e) => e.type === "audio")) break;
          }
        } else {
          step("question not spoken", `the agent's custom LLM is ${agentLlmUrl ?? "unknown"}, not this target; authorised via the gate only`);
        }
        const streamed = await streamSpeech(voice, pcm, { sampleRate, chunkMs: CHUNK_MS, trailingSilenceMs: 2_000, transcriptTimeoutMs: 20_000, sleep: (ms) => sleep(ms), now: Date.now });
        evidence.asr = { label: LABEL, chunksSent: streamed.chunksSent, chunkMs: CHUNK_MS, transcript: streamed.transcript };
        if (streamed.transcript === null) throw new Error(`no user_transcript within 20 s after ${streamed.chunksSent} audio chunks${voice.closeSuffix()}`);
        transcript = streamed.transcript;
        t0Ms = Math.max(0, streamed.speechStartedAt - connectedAt);
        t1Ms = Math.max(t0Ms, (streamed.transcriptAt ?? Date.now()) - connectedAt);
        step("asr", transcript);
        check("ASR transcribed Hindi (Devanagari)", DEVANAGARI.test(transcript), transcript);
      } finally {
        await voice.close();
      }
    } else {
      const { contextVersion } = await api.questions(sessionId);
      await api.authorize(sessionId, question.id, contextVersion);
      step("transcript", `scripted (no ASR): ${transcript}`);
    }

    // ── 4. Answer → server, then read everything back ──
    const posted = await api.postUtterance(sessionId, { conversationId, text: transcript, t0Ms, t1Ms, questionId: question.id, privacyEpoch: session.privacyEpoch, language: EXPERT.language });
    evidence.utterancePost = posted;
    step("utterance", `${posted.utteranceId}: language ${posted.language ?? "(none)"}, translation ${JSON.stringify(posted.translation ?? null)}`);
    check("utterance recorded as Hindi", posted.language === "hi", String(posted.language));
    check("English translation stored", at(posted.translation, "status") === "translated", JSON.stringify(posted.translation ?? null));
    const quotes = posted.statedQuotes ?? [];
    check("parser quoted the original Hindi words", quotes.length > 0 && quotes.every((q) => DEVANAGARI.test(q) && transcript.replace(/\s+/g, " ").includes(q.replace(/\s+/g, " ").trim())), JSON.stringify(quotes));

    const entries = await api.ledger(sessionId);
    const pick = (kind: string, parent?: string) => entries.filter((e) => e.kind === kind && (parent === undefined || e.parentIds.includes(parent)));
    const translated = pick("utterance.translated", posted.utteranceId)[0];
    const rules = pick("rule.confirmed", posted.utteranceId).map((e) => at(e.payload, "rule"));
    evidence.ledger = {
      utterance: entries.find((e) => e.id === posted.utteranceId) ?? null,
      translated: translated ?? null,
      answerParsed: pick("answer.parsed", posted.utteranceId)[0] ?? null,
      rulesConfirmed: rules,
    };
    check("utterance.translated entry (source engine, parent the utterance)", translated?.source === "engine", translated === undefined ? "missing" : translated.id);
    const rule = rules.find((r) => at(r, "effect", "type") === "forbid" && at(r, "effect", "action") === "approve");
    const quote = at(rule, "evidence", "0");
    check(
      "confirmed rule: forbid approve when jurisdictionRisk == high",
      JSON.stringify(at(rule, "predicate")) === JSON.stringify({ "==": [{ var: "jurisdictionRisk" }, "high"] }),
      JSON.stringify(at(rule, "predicate") ?? "no forbid-approve rule"),
    );
    check("rule evidence: Hindi exactQuote + English translation", at(quote, "language") === "hi" && typeof at(quote, "translation") === "string" && DEVANAGARI.test(String(at(quote, "exactQuote"))), JSON.stringify({ exactQuote: at(quote, "exactQuote"), translation: at(quote, "translation") }));

    try {
      const verdict = await api.checkAction({ jurisdictionRisk: "high", customerStatus: "new", entityType: "company" }, "approve");
      const explanation = verdict.explanation;
      evidence.mcp = verdict.content;
      const ruleId = at(rule, "id");
      check(
        "MCP check_action cites the Hindi quote with its English translation",
        verdict.decision === "forbid" && typeof ruleId === "string" && explanation.includes(String(at(quote, "exactQuote"))) && explanation.includes("English translation (machine, not authoritative)"),
        explanation,
      );
    } catch (error) {
      check("MCP check_action cites the Hindi quote with its English translation", false, error instanceof Error ? error.message : String(error));
    }
    try {
      const novice = await api.createSession(undefined, "novice");
      const view = (await api.tutor(novice.sessionId)).find((r) => r.ruleId === at(rule, "id"));
      evidence.tutor = view ?? null;
      check("tutor shows the rule with its English translation", typeof at(view, "quote", "translation") === "string", JSON.stringify(view === undefined ? "rule not in the tutor's rulebook" : view.quote));
    } catch (error) {
      check("tutor shows the rule with its English translation", false, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    const detail = error instanceof TargetError || error instanceof Error ? error.message : String(error);
    evidence.error = detail;
    check("run completed", false, detail);
  }
  return finish();
}

/** Polls the live queue until the engine has planned (and localized) a question for the decision. */
async function firstQuestion(api: TargetApi, sessionId: string) {
  for (let i = 0; i < 30; i++) {
    const { queue } = await api.questions(sessionId);
    const question = queue.find((q) => q.kind === "why_probe") ?? queue[0];
    if (question !== undefined) return question;
    await sleep(1_000);
  }
  throw new Error("no question queued within 30 s of the decision");
}

function summary(e: Evidence): string {
  const lines = [
    `P10 Hindi→English run — ${e.label}`,
    `target ${String(e.target)} · session ${String(e.sessionId ?? "-")} · ${String(e.startedAt)} → ${String(e.finishedAt)}`,
    `transcript source: ${String(e.transcriptSource)}`,
    "",
    ...e.steps.map((s) => `${s.at}  ${s.step}: ${s.detail}`),
    "",
    ...e.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`),
    "",
  ];
  return lines.join("\n");
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
