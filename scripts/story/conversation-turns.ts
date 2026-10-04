/**
 * Writes docs/video/evidence/conversation-turns.txt: the turn list ElevenLabs recorded for the two conversations
 * in the verified replay bundle (GET /v1/convai/conversations/{id}, read-only). It shows when the agent spoke,
 * when the expert (synthetic test voice) answered, and that the agent's turn after every answer was the
 * `skip_turn` system tool. Control messages carry a spent one-time nonce; it is redacted anyway.
 */
import { setDefaultResultOrder } from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, VIDEO_DIR, newest } from "./lib/repo";

setDefaultResultOrder("ipv4first");

type Turn = { role: string; time_in_call_secs: number; message: string | null; tool_calls?: { tool_name: string }[] };

function apiKey(): string {
  const fromEnv = process.env.ELEVENLABS_API_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const m = /^ELEVENLABS_API_KEY=(.*)$/m.exec(readFileSync(join(REPO, ".env"), "utf8"));
  if (m?.[1] === undefined) throw new Error("ELEVENLABS_API_KEY not set");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const manifestFile = newest(join(REPO, "docs/replay"), /\.manifest\.json$/);
const manifest = (JSON.parse(readFileSync(manifestFile, "utf8")) as { manifest: { bundleId: string; sessions: { id: string; conversationIds: string[] }[] } }).manifest;
const lines = [
  `ElevenLabs conversation turns for verified replay bundle ${manifest.bundleId} (fetched ${new Date().toISOString()}, GET /v1/convai/conversations/{id}).`,
  "Expert speech: synthetic voice input (ElevenLabs TTS). Control messages (one-time gate nonces, already spent) are redacted.",
  "",
];
for (const s of manifest.sessions) {
  for (const id of s.conversationIds) {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${id}`, { headers: { "xi-api-key": apiKey() } });
    if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
    const c = (await r.json()) as { status: string; metadata?: { call_duration_secs?: number }; transcript: Turn[] };
    lines.push(`== session ${s.id} · ${id} · status ${c.status} · ${c.metadata?.call_duration_secs ?? "?"} s`);
    let skips = 0;
    let answers = 0;
    for (const t of c.transcript) {
      const msg = (t.message ?? "").startsWith("⟦ctl:") ? "[control message from the gate — nonce redacted]" : (t.message ?? "");
      const tools = (t.tool_calls ?? []).map((x) => x.tool_name);
      if (tools.includes("skip_turn")) skips += 1;
      if (t.role === "user" && msg !== "" && !msg.startsWith("[control")) answers += 1;
      if (msg === "" && tools.length === 0) continue;
      lines.push(`${String(t.time_in_call_secs).padStart(4)} s  ${t.role.padEnd(5)}  ${tools.length > 0 ? `tool: ${tools.join(", ")}` : msg}`);
    }
    lines.push(`   expert answers: ${answers} · agent turns resolved by skip_turn: ${skips}`, "");
  }
}
mkdirSync(join(VIDEO_DIR, "evidence"), { recursive: true });
writeFileSync(join(VIDEO_DIR, "evidence/conversation-turns.txt"), `${lines.join("\n")}\n`);
console.info(lines.join("\n"));
