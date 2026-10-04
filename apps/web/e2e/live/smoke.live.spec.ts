/**
 * @live @smoke — does the live harness work against production? One Expert/Training session: share the
 * synthetic screen, start the interview over WebRTC, speak one synthetic line (ElevenLabs TTS) and check
 * that ElevenLabs transcribed it (user_transcript) and our ledger recorded it. No decision, no question.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR, SYNTHETIC_LABEL } from "./support/env";
import { Expert } from "./support/expert";

test("@live @smoke harness: WebRTC voice with the synthetic microphone", async ({ page, request }) => {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.info(`[page ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  const expert = await Expert.open(page, request);
  const sessionId = await expert.startSession("Training");
  await expert.shareScreen();
  await expert.startInterview();
  await page.waitForTimeout(1500);
  await expert.say("Okay, I am looking at the first case now.", "smoke");
  await expect.poll(async () => (await expert.events()).some((e) => e.type === "user_transcript"), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(3000);
  const events = await expert.events();
  await expert.endInterview();
  const ledger = await expert.ledger();
  mkdirSync(join(EVIDENCE_DIR, "smoke"), { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, "smoke", `smoke-${sessionId}.json`),
    JSON.stringify({ label: SYNTHETIC_LABEL, sessionId, events: events.filter((e) => e.type !== "vad").concat(events.filter((e) => e.type === "vad").slice(0, 50)), ledger }, null, 2),
  );
  const types = new Map<string, number>();
  for (const e of events) types.set(e.type, (types.get(e.type) ?? 0) + 1);
  console.info(JSON.stringify(Object.fromEntries(types)));
  console.info(JSON.stringify(events.filter((e) => e.type === "user_transcript" || e.type.startsWith("fetch") || e.type.startsWith("agent"))));
  expect(ledger.some((e) => e.kind === "utterance.transcript")).toBe(true);
});
