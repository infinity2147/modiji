/**
 * Re-runs the analysis over a saved live run (docs/evidence/live/<group>/<name>.json) and rewrites its
 * summary — the raw events and ledger in the file are the source; nothing is re-measured.
 *   npx tsx e2e/live/support/reanalyze.ts docs/evidence/live/p3/run-a-….json "P3 run A — …"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { analyzeRun } from "./analyze";
import type { Entry } from "./expert";
import type { HarnessEvent } from "./harness";
import { summarizeRun } from "./report";

const [file, title] = process.argv.slice(2);
if (file === undefined) throw new Error("usage: reanalyze.ts <run.json> [title]");
const data = JSON.parse(readFileSync(file, "utf8")) as {
  sessionId: string;
  conversationIds: string[];
  events: HarnessEvent[];
  ledger: Entry[];
  asked?: { caseId: string; question: string; answer: string; rule: string }[];
  notes?: string[];
  [key: string]: unknown;
};
const analysis = analyzeRun(data.events, data.ledger);
const oldTitle = readFileSync(file.replace(/\.json$/, ".txt"), "utf8").split("\n")[0] ?? "";
const extra = [
  "",
  "Questions and scripted answers (synthetic voice input, ElevenLabs TTS):",
  ...(data.asked ?? []).map((a) => `  [${a.caseId}] Q: "${a.question}"\n      A (${a.rule}): "${a.answer}"`),
  ...(data.notes ?? []),
];
writeFileSync(file, `${JSON.stringify({ ...data, analysis }, null, 2)}\n`);
const summary = summarizeRun(title ?? oldTitle, data.sessionId, data.conversationIds, analysis, extra);
writeFileSync(file.replace(/\.json$/, ".txt"), summary);
console.info(summary);
