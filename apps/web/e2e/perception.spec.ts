/**
 * Vision channel end to end, against the production server (LLM_CALLS=off: frames are stored
 * and ledgered, the model is never called, and the UI says so).
 *
 * Headless Chromium cannot capture a screen: with `--use-fake-ui-for-media-stream` and
 * `--auto-select-desktop-capture-source` getDisplayMedia fails with NotReadableError, and tab-capture
 * auto-accept flags answer NotSupportedError (checked with Playwright 1.63's headless shell). So the
 * test replaces `navigator.mediaDevices.getDisplayMedia` (page.addInitScript, test-side only) with a
 * MediaStream from a canvas the test draws on. Everything after the stream — grab, change detector,
 * Tesseract OCR + blur from /tesseract/, upload queue, server validation, storage, ledger — is real.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { kycCases } from "@vashistha/core/domains/kyc";

type Entry = { id: string; source: string; kind: string; privacyEpoch: number; payload: Record<string, unknown> };

const OWNER = kycCases("training")[0]?.owners[0]?.name ?? "";

/** Installs a fake screen: a 1280×720 canvas showing `window.__fakeScreen.text`, redrawn every 100 ms. */
async function installFakeScreen(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const state = { lines: ["Northstar CaseDesk"] };
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111111";
      ctx.font = "32px sans-serif";
      state.lines.forEach((line, i) => ctx.fillText(line, 60, 120 + i * 60));
    };
    draw();
    setInterval(draw, 100);
    Object.defineProperty(window, "__fakeScreen", { value: { show: (lines: string[]) => ((state.lines = lines), draw()) } });
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(10);
  });
}

const show = (page: Page, lines: string[]) =>
  page.evaluate((l) => (window as unknown as { __fakeScreen: { show: (lines: string[]) => void } }).__fakeScreen.show(l), lines);

async function ledger(request: APIRequestContext, sessionId: string): Promise<Entry[]> {
  const response = await request.get(`/api/sessions/${sessionId}/ledger?limit=500`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { entries: Entry[] }).entries;
}

const frames = async (request: APIRequestContext, sessionId: string) =>
  (await ledger(request, sessionId)).filter((e) => e.kind === "frame.received");

test("share screen → change-detected, redacted frames are uploaded, stored and ledgered; off the record stops them", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await installFakeScreen(page);
  await page.goto("/sandbox");
  await page.getByRole("radio", { name: /^Expert capture/ }).click();
  await page.getByRole("radio", { name: /^Training/ }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/session=/);
  const sessionId = new URL(page.url()).searchParams.get("session") ?? "";

  const card = page.getByRole("region", { name: "Screen capture" });
  await expect(card).toContainText("Screen frames: change-detected, best-effort PII blur in your browser before upload");
  const status = card.getByRole("status", { name: "Screen capture status" });
  await expect(status).toHaveText("Not sharing");

  await show(page, ["Case NS-2026-0001", `Beneficial owner: ${OWNER}`, "Risk rating: High"]);
  await card.getByRole("button", { name: "Share screen" }).click();
  await expect(status).toHaveText("Capturing");

  // First frame: Tesseract loads from our origin, reads the frame, blurs the owner's name, uploads.
  await expect.poll(async () => (await frames(request, sessionId)).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const [first] = await frames(request, sessionId);
  expect(first?.source).toBe("client");
  expect(first?.payload).toMatchObject({ frameSeq: 1, width: 1280, height: 720 });
  expect(first?.payload.redactedRegions as number).toBeGreaterThanOrEqual(1);

  // The stored redacted frame is served, session-scoped, as PNG.
  const media = await request.get(`/api/media/${sessionId}/frames/${String(first?.payload.frameId)}.png`);
  expect(media.status()).toBe(200);
  expect(media.headers()["content-type"]).toBe("image/png");
  expect((await media.body()).subarray(1, 4).toString("latin1")).toBe("PNG");

  // Honest vision state: this server does not extract, so no vision events exist.
  await expect(card.getByLabel("Vision status")).toHaveText(/Vision unavailable \(disabled on this server\)/);
  expect((await ledger(request, sessionId)).filter((e) => e.source === "vision")).toEqual([]);

  // A change on screen → another frame, with a higher vision frameSeq.
  await show(page, ["Case NS-2026-0001", `Beneficial owner: ${OWNER}`, "Risk rating: Low", "Outcome: Approve onboarding"]);
  await expect.poll(async () => (await frames(request, sessionId)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const seqs = (await frames(request, sessionId)).map((e) => e.payload.frameSeq as number);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  await card.getByText("Perception stats").click();
  await expect(card.getByLabel("Perception stats")).toContainText("Frames captured / changed");

  // Off the record: capture stops at once and nothing more is uploaded, whatever changes on screen.
  await page.getByRole("button", { name: "Go off the record" }).click();
  await expect(status).toHaveText("Paused — off the record");
  await expect.poll(async () => (await ledger(request, sessionId)).some((e) => e.kind === "privacy.off_record")).toBe(true);
  const before = (await frames(request, sessionId)).length;
  await show(page, ["Something private", `${OWNER} personal note`]);
  await page.waitForTimeout(2500);
  expect((await frames(request, sessionId)).length).toBe(before);
  await expect(card.getByRole("button", { name: "Share screen" })).toBeDisabled();

  // Resuming the record does not resume capture by itself: sharing again is the reviewer's choice.
  await page.getByRole("button", { name: "Resume the record" }).first().click();
  await expect(status).toHaveText("Not sharing");
  await expect(card.getByRole("button", { name: "Share screen" })).toBeEnabled();
  await card.getByRole("button", { name: "Share screen" }).click();
  await expect.poll(async () => (await frames(request, sessionId)).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const latest = (await frames(request, sessionId)).at(-1);
  const epochs = (await ledger(request, sessionId)).map((e) => e.privacyEpoch);
  expect(latest?.privacyEpoch).toBe(Math.max(...epochs));
});
