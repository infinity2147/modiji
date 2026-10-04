/**
 * Schema versioning end to end against the production server (plan §6.6): an expert session seeded
 * through the public APIs (three training cases decided with a redacted frame each), one undefined
 * concept surfaced, then the debrief page — the expert confirms the concept with their own words, the
 * banner reads "Model updated: new concept … — coverage …", the backfill result per case is shown, and
 * coverage is computed under feature model v2.
 *
 * The concept proposal is the one entry not written through an HTTP route: in production it comes from
 * the interview's concept proposer (Sonnet) or vision (Haiku), and this server runs with LLM_CALLS=off.
 * The spec appends that single `engine` / `concept.proposed` entry to the run's own ledger (the same
 * SQLite file, append-only, gap-free sequences across connections). With no model, every backfill is
 * `Unknown{backfill_failed}` (no_model) — nothing is invented.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type APIRequestContext } from "@playwright/test";
import { expect, test } from "./support/accounts";
import { createLedger, openDatabase } from "@vashistha/core/server";
import { uploadFrame } from "./support/screen-frame";
import { serverDataDir } from "./support/server";

const EVIDENCE_DIR = join(import.meta.dirname, "../../../docs/evidence/schema");
mkdirSync(EVIDENCE_DIR, { recursive: true });

const DECISIONS: Record<string, string> = { "NS-2026-0101": "requestDocuments", "NS-2026-0102": "approve", "NS-2026-0103": "enhancedReview" };
const QUOTE = "the proof of address is missing, so the file is not complete";

async function ok<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

async function seedSession(request: APIRequestContext): Promise<string> {
  const { sessionId } = await ok<{ sessionId: string }>(await request.post("/api/sessions", { data: { mode: "expert", caseSet: "training" } }));
  let frameSeq = 0;
  for (const [caseId, action] of Object.entries(DECISIONS)) {
    frameSeq += 1;
    const event = { id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false };
    await ok(await request.post(`/api/sessions/${sessionId}/events`, { data: { events: [event] } }));
    await uploadFrame(request, sessionId, frameSeq);
    const { checkId } = await ok<{ checkId: string }>(await request.post("/api/interlock/check", { data: { sessionId, caseId, edits: {}, proposedAction: action } }));
    await ok(await request.post(`/api/sessions/${sessionId}/decisions`, { data: { caseId, edits: {}, action, checkId } }));
  }
  return sessionId;
}

/** Stands in for the concept proposer (a model, off in this run): one `concept.proposed` entry quoting the expert. */
function proposeConcept(sessionId: string): void {
  const opened = openDatabase({ dataDir: serverDataDir() });
  try {
    createLedger(opened.db).append({
      sessionId,
      source: "engine",
      kind: "concept.proposed",
      occurredAt: Date.now(),
      traceId: randomUUID(),
      parentIds: [],
      schemaVersion: 1,
      privacyEpoch: 0,
      payload: { name: "documentsComplete", label: "documents complete", definition: "Every required document is on file.", type: "boolean", exactQuote: QUOTE },
    });
  } finally {
    opened.close();
  }
}

test("concepts: undefined concept → expert confirms → Model updated banner → backfill shown → coverage under v2", async ({ page, request }) => {
  test.setTimeout(120_000);
  const sessionId = await seedSession(request);
  proposeConcept(sessionId);

  await page.goto(`/debrief/${sessionId}`);
  const panel = page.getByTestId("concepts");
  await expect(panel).toBeVisible();
  const concept = panel.getByTestId("concept-documentsComplete");
  await expect(concept.getByText(`Expert: “${QUOTE}”`)).toBeVisible();
  await expect(page.getByTestId("coverage-panel").getByText("Feature model v1")).toBeVisible();

  await concept.getByRole("button", { name: "Confirm as a feature" }).click();
  await concept.getByLabel("Concept label").fill("Documents complete");
  await concept.getByLabel("Your words (recorded as evidence)").fill("Yes — documents complete means nothing on the checklist is missing or expired.");
  await concept.getByRole("button", { name: "Confirm concept" }).click();

  const banner = page.getByTestId("model-updated");
  await expect(banner).toContainText("Model updated: new concept Documents complete —");
  await expect(banner).toContainText("coverage recomputed under schema v2");
  const confirmed = panel.getByTestId("confirmed-documentsComplete");
  for (const caseId of Object.keys(DECISIONS)) await expect(confirmed.getByText(`${caseId}: unknown (no vision model)`)).toBeVisible();
  await expect(panel.getByText("No undefined concept under the current model.")).toBeVisible();
  await expect(page.getByTestId("coverage-panel").getByText("Feature model v2")).toBeVisible();
  await page.screenshot({ path: join(EVIDENCE_DIR, "concept-confirmed.png"), fullPage: true });

  // The ledger holds the whole chain, with the expert's words as evidence.
  const state = await ok<{ schemaVersion: number; confirmed: { statement: string; bumpEntryId: string | null; backfill: { failure: string | null }[] }[] }>(
    await request.get(`/api/sessions/${sessionId}/concepts`),
  );
  expect(state.schemaVersion).toBe(2);
  expect(state.confirmed[0]?.bumpEntryId).not.toBeNull();
  expect(state.confirmed[0]?.backfill.map((b) => b.failure)).toEqual(["no_model", "no_model", "no_model"]);
});
