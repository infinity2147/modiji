/**
 * Tech video (~2 min): architecture, the gate HUD's condition rows, the custom-LLM nonce invariant (real
 * requests against the local build + the committed production preflight), Z3 witnesses and coverage
 * closure, ledger lineage, event-loop numbers, the bench, and replay integrity (one byte flipped in a LOCAL
 * copy of the bundle, then restored). Called by video.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOM_LLM_PATH, agentModelId, loadAgentSpec } from "../../packages/core/src/server/elevenlabs-agents";
import { chatRequestBody } from "../preflight/checks/public-llm";
import { interpretChatStream, readSseResponse } from "../preflight/sse";
import { archCard, benchCard, endCard, eventLoopCard, terminalCard, thesisCard } from "./cards";
import { seek } from "./demo";
import { confirmDebriefProposals, expertSessionWithScreens } from "./lib/flows";
import { REPO } from "./lib/repo";
import { api } from "./lib/seed";
import { OPERATOR_SECRET } from "./lib/server";
import type { StoryContext } from "./video";

type Line = { cls: string; text: string };

/** Real requests to the local custom-LLM endpoint, exactly as ElevenLabs makes them (shapes from scripts/preflight). */
async function nonceDemo(base: string): Promise<Line[]> {
  const url = `${base}${CUSTOM_LLM_PATH}/chat/completions`;
  const model = agentModelId(await loadAgentSpec(new URL(`file://${join(REPO, "agents/interviewer.json")}`)));
  const call = async (text: string, sessionId: string | null, auth: boolean) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(auth ? { authorization: `Bearer ${OPERATOR_SECRET}` } : {}) },
      body: JSON.stringify(chatRequestBody(model, text, sessionId)),
    });
    if (r.status !== 200) {
      await r.body?.cancel();
      return { status: r.status, content: "", tools: [] as string[], reason: "" };
    }
    const { events, errors } = await readSseResponse(r, () => undefined);
    const s = interpretChatStream(events, errors);
    const args = s.toolCalls[0]?.arguments ?? "{}";
    let reason: string;
    try {
      reason = String((JSON.parse(args) as { reason?: unknown }).reason ?? "");
    } catch {
      reason = "";
    }
    return { status: r.status, content: s.content, tools: s.toolCalls.map((t) => t.name), reason };
  };
  const auth = await api<{ sessionId: string; controlMessage: string; text: string }>(base, "/api/preflight/authorize", {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
  });
  const noCreds = await call("Hello, is anyone there?", null, false);
  const plain = await call("Right, so I'd send that one to enhanced review.", auth.sessionId, true);
  const spoken = await call(auth.controlMessage, auth.sessionId, true);
  const again = await call(auth.controlMessage, auth.sessionId, true);
  const show = (x: { tools: string[]; reason: string; content: string; status: number }): string =>
    x.status !== 200 ? `HTTP ${x.status}` : x.tools.length > 0 ? `tool_call ${x.tools.join(",")}${x.reason === "" ? "" : ` (reason: ${x.reason})`}` : `speaks: “${x.content}”`;
  return [
    { cls: "dim", text: `POST ${CUSTOM_LLM_PATH}/chat/completions   (model ${model}, local build)` },
    { cls: "", text: "1  no credentials" },
    { cls: noCreds.status === 401 ? "bad" : "", text: `   → ${show(noCreds)}` },
    { cls: "", text: "2  expert turn, no authorisation" },
    { cls: plain.tools.includes("skip_turn") ? "ok" : "bad", text: `   → ${show(plain)}` },
    { cls: "", text: "3  gate control message ⟦ctl:…⟧ with a valid one-time nonce" },
    { cls: spoken.content === auth.text ? "ok" : "bad", text: `   → ${show(spoken)}` },
    { cls: "", text: "4  the same nonce again" },
    { cls: again.tools.includes("skip_turn") ? "ok" : "bad", text: `   → ${show(again)}` },
  ];
}

export async function recordTech(x: StoryContext): Promise<void> {
  const { prod, ev, name } = x;
  const A = x.serverA.baseUrl;
  const local = (extra: string): string => `<b style="color:#c9b6ff">LOCAL RUN</b> · production build of <code>${x.commit}</code> · ${extra}`;

  const fresh = await expertSessionWithScreens(x.browser, A);
  await confirmDebriefProposals(A, fresh.sessionId);
  const closed = x.closedDebriefSession;
  const lines = await nonceDemo(A);
  lines.push({ cls: "dim", text: "" }, { cls: "dim", text: `Production, through ElevenLabs (preflight ${ev.preflight.when.text}):` }, { cls: "ok", text: `   ${ev.preflight.voiceDetail.text}` });

  await prod.beat("arch", async (b) => {
    b.mark();
    await b.page.setContent(archCard());
    await b.say("tech/arch");
    await b.wait(600);
  });

  await prod.beat("gate", async (b) => {
    const p = b.page;
    await p.goto(`${A}/sandbox`);
    await p.getByRole("radio", { name: /^Expert capture/ }).click();
    await p.getByRole("radio", { name: /^Training/ }).click();
    await p.getByRole("button", { name: "Start session" }).click();
    const items = p.getByRole("list", { name: "Cases" }).getByRole("button");
    await items.first().waitFor();
    await p.getByRole("button", { name: "Engineering view" }).click();
    await p.waitForTimeout(800);
    b.mark();
    await b.label(local("voice is not configured locally: the gate's conditions run live, no question is spoken"), "top-right");
    const n = b.say("tech/gate");
    await p.waitForTimeout(2500);
    for (let i = 0; i < 3; i += 1) {
      await items.first().focus();
      for (let k = 0; k < 6; k += 1) {
        await p.keyboard.press("Shift");
        await p.waitForTimeout(120);
      }
      await p.waitForTimeout(2600);
      await items.nth(i).click();
      await p.waitForTimeout(3200);
    }
    await n;
    await b.wait(800);
  });

  await prod.beat("nonce", async (b) => {
    const p = b.page;
    b.mark();
    await p.setContent(terminalCard("The custom-LLM invariant", "No valid, unexpired, unused nonce ⇒ skip_turn. Real requests against the local build, then the committed production preflight.", lines, `local build ${x.commit} · ${ev.preflight.source}`));
    const n = b.say("tech/nonce");
    const step = (x.voiced.get("tech/nonce")?.duration ?? 20) / (lines.length + 1);
    for (let i = 0; i < lines.length; i += 1) {
      await p.evaluate(`document.querySelector('.ln[data-i="${i}"]').classList.add("on")`);
      await p.waitForTimeout(step * 1000);
    }
    await n;
    await b.wait(1200);
  });

  await prod.beat("z3", async (b) => {
    const p = b.page;
    await p.goto(`${A}/debrief/${fresh.sessionId}`);
    await p.getByTestId("coverage-panel").waitFor();
    await p.waitForTimeout(800);
    b.mark();
    await b.label(local("Z3 witnesses on a fresh session; then the session closed in the demo"), "bottom-right");
    const n = b.say("tech/z3");
    for (const kind of ["unresolved", "conflict"]) {
      const w = p.getByTestId("witness").and(p.locator(`[data-kind="${kind}"]`)).first();
      if ((await w.count()) > 0) {
        await w.scrollIntoViewIfNeeded();
        await p.waitForTimeout(3500);
      }
    }
    await p.goto(`${A}/debrief/${closed}`);
    await p.getByTestId("coverage-closed").waitFor();
    await b.label(local("the debrief closed in the demo (typed answers)"), "bottom-right");
    await p.getByTestId("coverage-panel").scrollIntoViewIfNeeded();
    await n;
    await b.wait(1500);
  });

  await prod.beat("lineage", async (b) => {
    const p = b.page;
    await p.goto(`${A}/workmap/${closed}`);
    await p.getByRole("heading", { name: "Work Map" }).waitFor();
    await p.waitForTimeout(800);
    b.mark();
    await b.label(local("lineage from the append-only ledger"), "bottom-right");
    const n = b.say("tech/lineage");
    await p.getByTestId("reason-quote").first().getByRole("button", { name: "Trace expert quote" }).click();
    await p.waitForTimeout(4000);
    await p.keyboard.press("Escape");
    await p.getByTestId("step").first().getByRole("button", { name: /^Trace step 1$/ }).click();
    await n;
    await b.wait(1500);
  });

  await prod.beat("eventloop", async (b) => {
    b.mark();
    await b.page.setContent(eventLoopCard(ev));
    await b.say("tech/eventloop");
    await b.wait(1000);
  });

  await prod.beat("bench", async (b) => {
    b.mark();
    await b.page.setContent(benchCard(ev));
    await b.say("tech/bench");
    await b.wait(800);
  });

  await prod.beat("replay", async (b) => {
    const p = b.page;
    const frame = x.replay.tamperFile;
    await p.goto(`${A}/replay/${x.replay.bundleId}`);
    await p.getByTestId("replay-banner-text").waitFor();
    await p.waitForTimeout(800);
    b.mark();
    const tamperLabel = `<b style="color:#c9b6ff">VERIFIED REPLAY of a recorded run</b> · a LOCAL copy of the bundle: one byte of a frame is flipped on purpose, then restored`;
    await b.label(tamperLabel, "mid-right");
    const n = b.say("tech/replay");
    await p.waitForTimeout(2500);
    const original = readFileSync(frame);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    writeFileSync(frame, tampered);
    try {
      await p.reload();
      await p.getByTestId("replay-refused").waitFor();
      await b.label(`<b style="color:#ff8a80">ONE BYTE CHANGED</b> · the page re-verifies every file and the hash chain on load, and refuses to play`, "mid-right");
      await p.waitForTimeout(3500);
    } finally {
      writeFileSync(frame, original);
    }
    await p.reload();
    await p.getByTestId("replay-banner-text").waitFor();
    await b.label(`<b style="color:#7ee2a8">RESTORED</b> · byte for byte: integrity ✓ again`, "mid-right");
    await seek(p, 80);
    await n;
    await b.wait(1200);
  });

  await prod.beat("close", async (b) => {
    b.mark();
    await b.page.setContent(thesisCard(ev));
    await b.wait(300);
    await b.say("tech/close");
    await b.wait(1000);
  });

  await prod.beat("end", async (b) => {
    b.mark();
    await b.page.setContent(
      endCard(ev, {
        title: `${name} — how it works`,
        commit: x.commit,
        narrator: "Daniel",
        lines: [
          `Production numbers: ${ev.preflight.source} and docs/evidence/live/SUMMARY.txt (live runs with <strong>synthetic voice input</strong>, ElevenLabs TTS).`,
          `Verified replay of a recorded run: bundle <code>${x.replay.bundleId}</code>; the tamper test changed a local copy only.`,
          `Apprentice-Bench uses a simulated expert (deterministic oracle).`,
        ],
      }),
    );
    await b.wait(6000);
  });
}
