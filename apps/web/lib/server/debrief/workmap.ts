/**
 * The Work Map of an expert session (plan §7.6): built by code (`buildWorkMap`) from the ledger and the
 * confirmed rulebook; Opus only titles the steps and writes the summary (validated, non-authoritative,
 * labelled by `proseOrigin`; deterministic templates when no model is available). Each distinct Work
 * Map — same session, rulebook revision, decisions and coverage — is generated once: its canonical JSON
 * export is saved to DATA_DIR/media/workmaps/<id>.json and recorded as `workmap.generated`; later
 * requests serve that saved export unchanged.
 */
import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  WorkMapSchema,
  buildWorkMap,
  canonicalJson,
  contentId,
  defaultStepTitle,
  parseLedgerPayload,
  type LedgerEntry,
  type WorkMap,
} from "@vashistha/core";
import type { WorkMapResponse } from "../../contracts/debrief";
import { entry } from "../interview/ledger";
import type { DebriefDeps } from "./deps";
import { DOMAIN, coverageOf, expertIdOf, kycCaseFeatures, ruleEntries, snapshot, type Snapshot } from "./state";
import { ruleText } from "./text";

/** Relative to DATA_DIR/media. */
export const WORKMAP_DIR = "workmaps";
const MAX_TITLE_CHARS = 80;
const MAX_SUMMARY_CHARS = 600;
const DEADLINE_MS = 45_000;
const MAX_TOKENS = 6_000;

const ProseSchema = z.strictObject({
  titles: z.array(z.strictObject({ stepId: z.string(), title: z.string() })),
  summary: z.string(),
});

export const WORKMAP_PROSE_SYSTEM = `You title the steps of an expert's documented work and summarise it, for a Work Map that a
new hire will read. The structure, decisions and rules are fixed by code; you only write labels.

Rules:
- One title per step id given, at most 8 words, naming the case situation and the decision. Plain, no marketing.
- A summary of at most 80 words: what the expert decides in this work and which confirmed rules govern it.
- Use only the facts given. Do not invent conditions, thresholds or rules.`;

type Prose = { titles: Record<string, string>; summary: string; origin: "llm" | "template" };

function templateProse(wm: WorkMap): Prose {
  const closed = wm.coverage.closed ? " Coverage under the current model is closed." : "";
  return {
    titles: {},
    summary: `${wm.steps.length} observed decision${wm.steps.length === 1 ? "" : "s"} explained by ${wm.rules.length} confirmed rule${wm.rules.length === 1 ? "" : "s"} (rulebook revision ${wm.rulebookRevision}).${closed}`,
    origin: "template",
  };
}

/** The prompt input: step ids with their decision and the confirmed rules that explain it — nothing else. */
export function proseInput(wm: WorkMap): string {
  const rules = new Map(wm.rules.map((r) => [r.id, ruleText(DOMAIN, r)]));
  return wm.steps
    .map((s) => {
      const why = s.ruleIds.map((id) => rules.get(id)).filter((t) => t !== undefined).map((t) => `when ${t.when}: ${t.then}`);
      const guard = s.guardrailIds.map((id) => rules.get(id)).filter((t) => t !== undefined).map((t) => `${t.then} when ${t.when}`);
      return `<step id="${s.id}">decision: ${defaultStepTitle(DOMAIN, s.caseId, s.decision.action)}; because: ${why.join("; ") || "no confirmed rule"}; guardrails: ${guard.join("; ") || "none"}</step>`;
    })
    .join("\n");
}

async function writeProse(deps: DebriefDeps, wm: WorkMap): Promise<Prose> {
  const { claude } = deps;
  if (claude === null || wm.steps.length === 0) return templateProse(wm);
  let timer: NodeJS.Timeout | undefined;
  try {
    const { output } = await Promise.race([
      claude.structured({ model: deps.models.prose, system: WORKMAP_PROSE_SYSTEM, messages: [{ role: "user", content: proseInput(wm) }], maxTokens: MAX_TOKENS, schema: ProseSchema }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Work Map prose did not arrive within ${DEADLINE_MS} ms`)), DEADLINE_MS);
      }),
    ]);
    const ids = new Set(wm.steps.map((s) => s.id));
    const titles = Object.fromEntries(output.titles.filter((t) => ids.has(t.stepId) && t.title.trim() !== "" && t.title.length <= MAX_TITLE_CHARS).map((t) => [t.stepId, t.title.trim()]));
    const summary = output.summary.trim();
    if (Object.keys(titles).length !== ids.size || summary === "" || summary.length > MAX_SUMMARY_CHARS) {
      deps.log.info("[debrief] Work Map prose rejected (missing titles or bounds); templates used");
      return templateProse(wm);
    }
    return { titles, summary, origin: "llm" };
  } catch (error) {
    deps.log.warn(`[debrief] Work Map prose failed; templates used: ${error instanceof Error ? error.message : String(error)}`);
    return templateProse(wm);
  } finally {
    clearTimeout(timer);
  }
}

function workMapId(snap: Snapshot, coverage: WorkMap["coverage"]): string {
  return contentId("wm", canonicalJson({ session: snap.loaded.session.id, revision: snap.book.revision, decisions: snap.decisions.map((d) => d.entry.id), coverage }));
}

async function readSaved(dataDir: string, mediaPath: string): Promise<WorkMap | undefined> {
  try {
    return WorkMapSchema.parse(JSON.parse(await readFile(join(dataDir, "media", mediaPath), "utf8")));
  } catch {
    return undefined;
  }
}

/** The redacted frame of a `frame.received` entry, served by the perception media route. */
export function frameMediaUrl(frameEntry: LedgerEntry): string {
  return `/api/media/${encodeURIComponent(frameEntry.sessionId)}/frames/${encodeURIComponent(parseLedgerPayload(frameEntry, "frame.received").frameId)}.png`;
}

/** One line for a screen event: "open case NS-2026-0101", "risk rating: unrated → high", "action approve". */
export function screenEventSummary(entry: LedgerEntry): string {
  const e = parseLedgerPayload(entry, "screen.event");
  switch (e.kind) {
    case "open_case":
      return `opened case ${e.caseId ?? ""}`.trim();
    case "field_change":
      return `${e.field ?? "field"}: ${e.from === undefined ? "" : `${String(e.from)} → `}${String(e.to)}`;
    case "action":
      return `action ${e.action ?? ""}`.trim();
    case "navigate":
      return "navigated";
  }
}

function moments(snap: Snapshot, wm: WorkMap): WorkMapResponse["moments"] {
  const byId = new Map(snap.entries.map((e) => [e.id, e]));
  return Object.fromEntries(
    wm.steps.map((s) => [
      s.id,
      [...s.frameIds, ...s.eventIds].flatMap((id): WorkMapResponse["moments"][string] => {
        const e = byId.get(id);
        if (e === undefined) return [];
        if (e.kind === "frame.received") {
          const f = parseLedgerPayload(e, "frame.received");
          return [{ entryId: id, kind: "frame", summary: `frame ${f.frameSeq} · ${f.redactedRegions} region(s) redacted`, mediaUrl: frameMediaUrl(e) }];
        }
        return [{ entryId: id, kind: e.source === "dom" ? "dom_event" : "vision_event", summary: screenEventSummary(e), mediaUrl: null }];
      }),
    ]),
  );
}

export async function sessionWorkMap(deps: DebriefDeps, sessionId: string): Promise<WorkMapResponse> {
  const snap = await snapshot(deps, sessionId);
  const coverage = coverageOf(snap);
  const id = workMapId(snap, coverage);
  const recorded = snap.entries.find((e) => e.kind === "workmap.generated" && parseLedgerPayload(e, "workmap.generated").workMapId === id);
  const mediaPath = `${WORKMAP_DIR}/${id}.json`;

  let workMap = recorded === undefined ? undefined : await readSaved(deps.dataDir, mediaPath);
  let proseOrigin = recorded === undefined ? undefined : parseLedgerPayload(recorded, "workmap.generated").proseOrigin;
  if (workMap === undefined || proseOrigin === undefined) {
    const base = {
      id,
      domain: snap.domain,
      entries: snap.entries,
      rules: snap.book.rules,
      revision: snap.book.revision,
      coverage,
      // The case as the expert saw it, plus the session's confirmed concepts (backfilled or Unknown) for that decision.
      caseFeatures: (caseId: string, edits: Readonly<Record<string, unknown>>) => {
        const features = kycCaseFeatures(caseId, edits);
        return features === undefined ? undefined : { ...snap.decisions.findLast((d) => d.caseId === caseId)?.features, ...features };
      },
      expertId: expertIdOf(snap.loaded.session.id),
      schemaVersion: snap.schemaVersion,
      now: recorded?.occurredAt ?? deps.now(),
    };
    const cached = deps.store.prose.get(id);
    const prose = cached ?? (await writeProse(deps, buildWorkMap(base)));
    deps.store.prose.set(id, prose);
    workMap = buildWorkMap({ ...base, titles: prose.titles, summary: prose.summary });
    proseOrigin = prose.origin;
    await mkdir(join(deps.dataDir, "media", WORKMAP_DIR), { recursive: true });
    await writeFile(join(deps.dataDir, "media", mediaPath), deps.exports.workMapJson(workMap), "utf8");
  }

  const entryOf = ruleEntries(snap.book);
  let generatedEntryId = recorded?.id;
  if (generatedEntryId === undefined) {
    const parents = [...snap.decisions.map((d) => d.entry.id), ...workMap.rules.flatMap((r) => entryOf.get(r.id) ?? [])];
    const ctx = { sessionId: snap.loaded.session.id, occurredAt: workMap.generatedAt, traceId: id, privacyEpoch: snap.loaded.session.privacyEpoch };
    generatedEntryId = deps.ledger.append(
      entry(ctx, "workmap.generated", "engine", [...new Set(parents)], { workMapId: id, rulebookRevision: snap.book.revision, mediaPath, proseOrigin }),
    ).id;
  }

  return {
    workMap,
    proseOrigin,
    exportPath: mediaPath,
    generatedEntryId,
    moments: moments(snap, workMap),
    ruleText: Object.fromEntries(workMap.rules.map((r) => [r.id, { ...ruleText(snap.domain, r), entryId: entryOf.get(r.id) ?? generatedEntryId }])),
    voiceSession: snap.entries.some((e) => e.kind === "utterance.transcript"),
    mcp: { path: "/mcp", tool: "check_action", bearerRequired: deps.mcpBearerRequired, rulebookRevision: snap.book.revision },
  };
}
