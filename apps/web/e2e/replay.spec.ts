/**
 * P11 verified replay, end to end against the production server (LLM_CALLS=off; no voice, no model).
 *
 * 1. A short GENUINE run is made through the public APIs: an expert decides the training cases while
 *    redacted frames are uploaded, the debrief runs Z3, the expert confirms and revises two rules in
 *    their own typed words, states a stop-rule and confirms the (template) teach-back; then a novice
 *    selects the forbidden outcome on the unseen case NS-2026-0201, the tutor intervenes, and the novice
 *    decides as the expert would.
 * 2. `pnpm replay:export` exports both sessions from this server into DATA_DIR/replays.
 * 3. /replay/<id> shows the unmissable banner with integrity ✓; play, seek and speed drive the
 *    recorded timeline; ticker and compliance strip follow it entry by entry; the intervention, the
 *    debrief and the Work Map are re-rendered through the live components.
 * 4. One byte of a frame is changed on disk: the next load refuses to play and says why; restored, it plays.
 * Screenshots: docs/evidence/p11/replay-*.png.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { LedgerEntry } from "@vashistha/core";
import { computeCompliance } from "../lib/client/judge/compliance";
import { uploadFrame } from "./support/screen-frame";

const REPO = join(import.meta.dirname, "../../..");
const EVIDENCE_DIR = join(REPO, "docs/evidence/p11");
mkdirSync(EVIDENCE_DIR, { recursive: true });

const QUOTE_ENHANCED = "A brand-new customer from a high-risk country always goes to enhanced review.";
const QUOTE_DOCS = "If the biggest owner holds more than 25% and we haven't verified them, ask for documents.";
const STOP_QUOTE = "Never approve a new customer from a high-risk country at desk level.";
const HIGH_NEW = { and: [{ "==": [{ var: "jurisdictionRisk" }, "high"] }, { "==": [{ var: "customerStatus" }, "new"] }] };
const DOCS = { and: [{ ">": [{ var: "uboOwnershipPct" }, 25] }, { "==": [{ var: "uboVerified" }, false] }] };

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

type Proposal = { candidateId: string; decisionFamily: string; action: string; text: string };
type Debrief = { proposals: Proposal[]; rules: { rule: { id: string; effect: { type: string; action?: string } } }[]; teachBack: { entryId: string } | null };

async function expertRun(request: APIRequestContext): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  const decisions: [string, string][] = [
    ["NS-2026-0101", "requestDocuments"],
    ["NS-2026-0102", "approve"],
    ["NS-2026-0103", "enhancedReview"],
  ];
  let frameSeq = 0;
  let lastFrame = "";
  for (const [caseId, action] of decisions) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    lastFrame = (await uploadFrame(request, sessionId, frameSeq)).ledgerId;
    const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }));
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId } }));
  }
  const debrief = await ok<Debrief>(await request.post(`/api/sessions/${sessionId}/witnesses`));
  const act = (data: unknown) => request.post(`/api/sessions/${sessionId}/debrief`, { data });
  for (const [action, predicate, quote] of [
    ["enhancedReview", HIGH_NEW, QUOTE_ENHANCED],
    ["requestDocuments", DOCS, QUOTE_DOCS],
  ] as const) {
    const proposal = debrief.proposals.find((p) => p.action === action);
    if (proposal === undefined) throw new Error(`no proposal for ${action}`);
    const confirmed = await ok<{ state: Debrief }>(await act({ action: "confirm_candidate", candidateId: proposal.candidateId, decisionFamily: proposal.decisionFamily, quote: `Yes — ${proposal.text}, ${action}.` }));
    const rule = confirmed.state.rules.find((r) => r.rule.effect.type === "recommend" && r.rule.effect.action === action);
    if (rule === undefined) throw new Error(`rule for ${action} not confirmed`);
    await ok(await act({ action: "revise_rule", ruleId: rule.rule.id, predicate, priority: 100, quote }));
  }
  await ok(
    await act({
      action: "confirm_stop_rule",
      decisionFamily: "reviewOutcome",
      when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }, { feature: "customerStatus", op: "==", value: "new" }] },
      effect: { type: "forbid", action: "approve" },
      momentEntryId: lastFrame,
      quote: STOP_QUOTE,
    }),
  );
  const written = await ok<Debrief>(await request.post(`/api/sessions/${sessionId}/teachback`));
  if (written.teachBack === null) throw new Error("no teach-back");
  await ok(await act({ action: "confirm_teachback", teachBackId: written.teachBack.entryId, quote: "Yes, that's how I decide these." }));
  return sessionId;
}

async function noviceRun(request: APIRequestContext): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "novice", caseSet: "heldout" } }));
  const caseId = "NS-2026-0201";
  const event = { id: randomUUID(), frameSeq: 1, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
  await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
  // Predict first (the tutor asks before the novice decides): wrong, then revealed in the expert's words.
  const predicted = await ok<{ prediction: { correct: boolean } }>(await request.post(`/api/sessions/${sessionId}/tutor/prediction`, { data: { caseId, predicted: "approve", edits: {} } }));
  expect(predicted.prediction.correct).toBe(false);
  const intent = await ok<{ intervention: { text: string } | null }>(await request.post(`/api/sessions/${sessionId}/tutor/intent`, { data: { caseId, proposedAction: "approve", edits: {} } }));
  expect(intent.intervention?.text).toContain(STOP_QUOTE);
  await ok(await request.post(`/api/sessions/${sessionId}/tutor/intent`, { data: { caseId, proposedAction: "enhancedReview", edits: {} } }));
  const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: "enhancedReview" } }));
  await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action: "enhancedReview", checkId } }));
  return sessionId;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(EVIDENCE_DIR, name) });
}

async function seek(page: Page, n: number): Promise<void> {
  await page.getByLabel("Seek (recorded entries)").fill(String(n));
  await expect(page.getByTestId("replay-position")).toHaveAttribute("data-n", String(n));
}

test("verified replay: genuine run → export → verified replay through the same UI; seek/play in step; one byte tampered → refused", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000);
  const expert = await expertRun(request);
  const novice = await noviceRun(request);

  // Export through the public read APIs into this server's DATA_DIR (the script verifies what it wrote).
  const dataDir = process.env.E2E_DATA_DIR;
  if (dataDir === undefined || baseURL === undefined) throw new Error("E2E_DATA_DIR / baseURL not set");
  const out = execFileSync("pnpm", ["--silent", "replay:export", "--base", baseURL, "--sessions", `${expert},${novice}`, "--out", join(dataDir, "replays")], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: REPO },
  });
  const bundleId = /bundle (\S+) →/.exec(out)?.[1];
  if (bundleId === undefined) throw new Error(`no bundle id in export output:\n${out}`);
  writeFileSync(join(EVIDENCE_DIR, "replay-export.log"), out);

  const bundle = await ok<{ entries: LedgerEntry[]; manifest: { timeline: { head: string; entries: number }; files: Record<string, unknown> } }>(await request.get(`/api/replays/${bundleId}`));
  const total = bundle.entries.length;
  expect(total).toBe(bundle.manifest.timeline.entries);

  // The banner: labelled, sourced, integrity re-verified on load.
  await page.goto(`/replay/${bundleId}`);
  const banner = page.getByTestId("replay-banner-text");
  await expect(banner).toContainText(`VERIFIED REPLAY — recorded run ${bundleId} from 127.0.0.1`);
  await expect(banner).toContainText(`integrity ✓ (${total} entries, chain ${bundle.manifest.timeline.head.slice(0, 12)})`);
  await expect(page.getByTestId("try-live")).toHaveAttribute("href", "/sandbox");
  await expect(page.getByTestId("replay-position")).toHaveAttribute("data-n", "0");
  await shot(page, "replay-start.png");

  // Play (real recorded pacing, half speed): the ticker and the compliance strip move in step with the clock.
  await page.getByLabel("Speed").selectOption("0.5");
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(async () => Number(await page.getByTestId("replay-position").getAttribute("data-n")), { timeout: 60_000 }).toBeGreaterThan(5);
  const pause = page.getByRole("button", { name: "Pause" });
  if (await pause.isVisible()) await pause.click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  const paused = Number(await page.getByTestId("replay-position").getAttribute("data-n"));
  expect(paused).toBeGreaterThan(5);
  await expect(page.getByRole("log", { name: "Ledger events" }).locator("li")).toHaveCount(Math.min(paused, 60));
  const atPause = computeCompliance(bundle.entries.slice(0, paused));
  await expect(page.getByRole("list", { name: "Compliance" }).getByLabel(`Teach-back: ${atPause.teachBack ? "✓, earned" : "✗, pending"}`)).toBeVisible();
  await shot(page, "replay-playing.png");

  // Seek to the tutor's intervention: the novice's CaseDesk shows the warning in the expert's words, and the strip has earned it.
  const interventionAt = bundle.entries.findIndex((e) => e.kind === "tutor.intervention") + 1;
  expect(interventionAt).toBeGreaterThan(0);
  await seek(page, interventionAt);
  await expect(page.getByTestId("replay-view")).toHaveAttribute("data-session", novice);
  await expect(page.getByText(/Careful — the expert's rule forbids/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(STOP_QUOTE).first()).toBeVisible();
  const strip = page.getByRole("list", { name: "Compliance" });
  const expected = computeCompliance(bundle.entries.slice(0, interventionAt));
  expect(expected.unseenCaseIntercepted).toBe(true);
  await expect(strip.getByLabel(/^Unseen case intercepted: ✓, earned$/)).toBeVisible();
  await expect(strip.getByLabel(`Guardrail: ${expected.guardrail ? "✓, earned" : "✗, pending"}`)).toBeVisible();
  await expect(strip.getByLabel(/^Teach-back: ✓, earned$/)).toBeVisible();
  await shot(page, "replay-intervention.png");

  // Back before the teach-back was confirmed: the strip un-earns it (state is a pure function of the prefix).
  const teachBackAt = bundle.entries.findIndex((e) => e.kind === "teachback.confirmed") + 1;
  await seek(page, teachBackAt - 1);
  await expect(strip.getByLabel(/^Teach-back: ✗, pending$/)).toBeVisible();
  await expect(strip.getByLabel(/^Unseen case intercepted: ✗, pending$/)).toBeVisible();
  await seek(page, teachBackAt);
  await expect(page.getByTestId("replay-view")).toHaveAttribute("data-tab", "debrief");
  await expect(page.getByTestId("teachback")).toContainText("confirmed", { timeout: 30_000 });
  await expect(page.getByTestId("coverage-panel")).toBeVisible();
  await shot(page, "replay-debrief.png");

  // The Work Map of the recorded expert session, built by the same code from the recorded ledger.
  await page.getByRole("button", { name: "Work Map" }).click();
  await expect(page.getByTestId("step")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByRole("img", { name: /Redacted frame of NS-2026-0101/ })).toBeVisible();
  await shot(page, "replay-workmap.png");

  // The end: every entry applied, and the end-of-run cross-check against the views the server served at export.
  await page.getByLabel("Follow the recording").check();
  await seek(page, total);
  await expect(page.getByTestId("replay-cross-check")).toBeVisible({ timeout: 60_000 });
  await shot(page, "replay-end.png");

  // Tamper with one byte of a recorded frame: the next load refuses to play, with the reason.
  const frame = Object.keys(bundle.manifest.files).find((p) => p.startsWith("media/"));
  if (frame === undefined) throw new Error("no frame in the bundle");
  const framePath = join(dataDir, "replays", bundleId, frame);
  const original = readFileSync(framePath);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  writeFileSync(framePath, tampered);
  await page.reload();
  await expect(page.getByTestId("replay-refused")).toBeVisible();
  await expect(page.getByTestId("replay-refused-reason")).toContainText(`${frame}: sha256 mismatch`);
  await expect(page.getByTestId("replay-banner")).toHaveCount(0);
  await shot(page, "replay-refused.png");
  expect((await request.get(`/api/replays/${bundleId}/views?n=1`)).status()).toBe(409);

  // Restored byte for byte: it verifies and plays again.
  writeFileSync(framePath, original);
  await page.reload();
  await expect(page.getByTestId("replay-banner-text")).toContainText("integrity ✓");
});
