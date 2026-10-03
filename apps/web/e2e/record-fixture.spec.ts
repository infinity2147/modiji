/**
 * P2 fixture recorder (tagged @record: excluded from the default e2e run).
 *
 *   pnpm --filter @vashistha/web build
 *   pnpm --filter @vashistha/web exec playwright test --grep @record
 *
 * Drives CaseDesk through a scripted expert session over the training and practice cases (one
 * CaseDesk session per pass, as many passes as needed for ≥ 40 risk-rating changes and ≥ 40 committed
 * outcomes) while a fixed-rate loop takes a 1440×900 viewport screenshot every 500 ms. Writes the
 * fixture in exactly the packages/perception/FIXTURES.md format to
 * packages/perception/test/fixtures/casedesk-recorded/:
 *
 * - every capture is a `frames[]` entry; byte-identical screenshots share one PNG file (the format
 *   only requires each entry to name a PNG), so idle stretches cost no disk;
 * - `domEvents` are the session ledgers' `dom` / `screen.event` payloads, exactly as recorded.
 *
 * The judge view (gate HUD, event ticker, compliance strip — the full-width row under CaseDesk) is
 * hidden during recording. It is demo instrumentation, not the reviewer's application: its ticker
 * prints the ledger, including every DOM event (the ground truth), as on-screen text, so a vision
 * model could read the answers instead of perceiving the UI; and its HUD countdown repaints every
 * frame, which would make every capture "changed". Everything else is the real screen.
 *
 * All data is synthetic CaseDesk data (one privacy epoch, 0). Pacing is reviewer-like (0.9–2 s between
 * actions) with a fast double edit every fourth case, so coalescing is exercised.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ScreenEventSchema, type ScreenEvent } from "@vashistha/core";
import { KYC_DOMAIN, mulberry32 } from "@vashistha/core/domains/kyc";
import { FixtureSchema } from "../../../packages/perception/src/evaluation";
import { REVIEW_OUTCOMES } from "../lib/client/domain";

const FIXTURE_DIR = join(import.meta.dirname, "../../../packages/perception/test/fixtures/casedesk-recorded");
const INTERVAL_MS = 500;
const TARGET = { riskRatingChanges: 40, outcomes: 40 };
const PASSES: ReadonlyArray<"Training" | "Practice"> = ["Practice", "Training", "Practice", "Training", "Practice", "Training", "Practice", "Training", "Practice"];
const RATINGS = ["Low", "Medium", "High"] as const;
/** The judge-view row (see the header): instrumentation that renders the ground truth on screen. */
const GROUND_TRUTH_MASK = 'div[class~="[grid-area:strip]"] { visibility: hidden !important; }';

type Entry = { source: string; kind: string; payload: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fixed-rate 500 ms screenshots; missed ticks are skipped, never caught up (FIXTURES.md). */
function startRecorder(page: Page) {
  const frames: Array<{ frameSeq: number; captureTime: number; file: string }> = [];
  const files = new Map<string, string>();
  let running = true;
  let lastCapture = 0;
  const done = (async () => {
    let next = Date.now();
    while (running) {
      const captureTime = Math.max(Date.now(), lastCapture + 1);
      try {
        const png = await page.screenshot({ type: "png" });
        const hash = createHash("sha256").update(png).digest("hex");
        let file = files.get(hash);
        if (file === undefined) {
          file = `frames/${String(files.size + 1).padStart(6, "0")}.png`;
          writeFileSync(join(FIXTURE_DIR, file), png);
          files.set(hash, file);
        }
        frames.push({ frameSeq: frames.length + 1, captureTime, file });
        lastCapture = captureTime;
      } catch {
        // A screenshot during a navigation can fail; that tick is simply missed.
      }
      next += INTERVAL_MS;
      while (next <= Date.now()) next += INTERVAL_MS;
      await sleep(next - Date.now());
    }
  })();
  return {
    frames,
    files,
    stop: async () => {
      running = false;
      await done;
    },
  };
}

async function domEvents(request: APIRequestContext, sessionId: string): Promise<ScreenEvent[]> {
  const response = await request.get(`/api/sessions/${sessionId}/ledger?limit=500`);
  expect(response.ok()).toBe(true);
  const { entries } = (await response.json()) as { entries: Entry[] };
  return entries.filter((e) => e.source === "dom" && e.kind === "screen.event").map((e) => ScreenEventSchema.parse(e.payload));
}

test("@record CaseDesk perception fixture (expert session, ≥40 rating changes and outcomes)", async ({ page, request }) => {
  test.setTimeout(30 * 60_000);
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(join(FIXTURE_DIR, "frames"), { recursive: true });
  const rng = mulberry32(20261004);
  const pause = (min = 900, max = 2000) => page.waitForTimeout(Math.round(min + rng() * (max - min)));
  const outcomes = REVIEW_OUTCOMES.map((o) => o.label);
  const counts = { riskRatingChanges: 0, outcomes: 0 };
  const sessions: string[] = [];

  await page.addInitScript((css) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
    });
  }, GROUND_TRUTH_MASK);
  await page.goto("/sandbox");
  const recorder = startRecorder(page);
  let caseNumber = 0;
  for (const set of PASSES) {
    if (counts.riskRatingChanges >= TARGET.riskRatingChanges && counts.outcomes >= TARGET.outcomes) break;
    await page.goto("/sandbox");
    await page.getByRole("radio", { name: /^Expert capture/ }).click();
    await page.getByRole("radio", { name: new RegExp(`^${set}`) }).click();
    await pause(500, 900);
    await page.getByRole("button", { name: "Start session" }).click();
    const queue = page.getByRole("list", { name: "Cases" }).getByRole("button");
    await expect(queue.first()).toBeVisible();
    sessions.push(new URL(page.url()).searchParams.get("session") ?? "");
    await pause();

    const total = await queue.count();
    for (let index = 0; index < total; index += 1) {
      caseNumber += 1;
      await queue.nth(index).click();
      await expect(queue.nth(index)).toHaveAttribute("aria-current", "true");
      await pause();

      const rating = page.getByRole("combobox", { name: "Risk rating" });
      const choose = async (label: string) => {
        await rating.click();
        await page.getByRole("option", { name: label, exact: true }).click();
        await expect(rating).toHaveText(label);
        counts.riskRatingChanges += 1;
      };
      const current = ((await rating.textContent()) ?? "").trim();
      const options = RATINGS.filter((r) => r !== current);
      const final = options[Math.floor(rng() * options.length)] ?? "High";
      if (caseNumber % 4 === 0) {
        // A fast double edit (well inside one 500 ms frame interval): the intermediate value may never be seen.
        const intermediate = RATINGS.find((r) => r !== current && r !== final) ?? final;
        await choose(intermediate);
      }
      await choose(final);
      await pause();

      const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "Request documents";
      await page.getByRole("radio", { name: outcome }).click();
      await pause(600, 1400);
      await page.getByRole("button", { name: "Save decision" }).click();
      await expect(queue.nth(index)).toContainText("Decided");
      counts.outcomes += 1;
      await pause();
    }
    await expect(page.getByText("All DOM events delivered")).toBeVisible();
    await pause(1000, 1500);
  }
  await recorder.stop();
  expect(counts.riskRatingChanges).toBeGreaterThanOrEqual(TARGET.riskRatingChanges);
  expect(counts.outcomes).toBeGreaterThanOrEqual(TARGET.outcomes);

  const events = (await Promise.all(sessions.map((id) => domEvents(request, id)))).flat();
  const fixture = FixtureSchema.parse({ version: 1, domainId: KYC_DOMAIN.id, sessionEpoch: 0, frames: recorder.frames, domEvents: events });
  writeFileSync(join(FIXTURE_DIR, "fixture.json"), `${JSON.stringify(fixture, null, 1)}\n`);

  const byKind: Record<string, number> = {};
  for (const e of events) {
    const key = e.kind === "field_change" ? `field_change:${e.field ?? "?"}` : e.kind === "action" ? `action:${e.action ?? "?"}` : e.kind;
    byKind[key] = (byKind[key] ?? 0) + 1;
  }
  const bytes = [...recorder.files.values()].reduce((sum, file) => sum + statSync(join(FIXTURE_DIR, file)).size, 0);
  const span = (recorder.frames.at(-1)?.captureTime ?? 0) - (recorder.frames[0]?.captureTime ?? 0);
  console.info(
    [
      `fixture: ${FIXTURE_DIR}`,
      `sessions: ${sessions.length} · span ${(span / 1000).toFixed(1)} s`,
      `frames: ${recorder.frames.length} captures, ${recorder.files.size} distinct PNG files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`,
      `UI actions: ${counts.riskRatingChanges} risk-rating changes, ${counts.outcomes} committed outcomes`,
      `DOM events: ${events.length} ${JSON.stringify(byKind)}`,
    ].join("\n"),
  );
});
