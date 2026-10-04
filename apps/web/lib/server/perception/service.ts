/**
 * Server-side vision channel (plan §7.1): per-session frame order and the extraction worker.
 * Code, not the model, decides ordering, staleness and criticality:
 *
 * - Frame order: a session's vision frameSeq must strictly increase (recovered from the ledger's
 *   `frame.received` entries after a restart). Independent of the DOM channel's frameSeq.
 * - One extraction in flight per session. While it runs only the newest waiting frame is kept;
 *   older waiting frames are skipped (coalesced) — the newest frame shows the current screen. A frame
 *   older than one already handed to the worker (two uploads stored in reverse order) is dropped.
 * - A result is applied only through `createStateApplier`: its frameSeq must be newer than the last
 *   applied one and its privacy epoch current. At apply time the session is re-read from the
 *   ledger, and the append is refused if it went off the record or changed epoch meanwhile, so an
 *   extraction that straddles a privacy transition never writes anything.
 * - Stateful reading (`@vashistha/perception/extraction`): the worker keeps the last applied reading
 *   (`CaseSnapshot`); `prepareRead` compares the frame with it and asks the model for a full or a
 *   local read; `interpretReading` validates the reading against the domain and the app's declared
 *   editable fields (`ScreenProfile`), derives the events and sets `critical` from `criticalFields`.
 *   Vision events are appended as `vision` / `screen.event` with the frame's
 *   `frame.received` entry as parent. They never replace DOM events: both channels are ledgered
 *   side by side with their source, so vision accuracy is measured, not assumed (D3).
 * - Proposed concepts become `engine` / `concept.proposed` entries, at most once per name per session.
 *
 * Without an extractor (no ANTHROPIC_API_KEY, or VISION_EXTRACTION=off) frames are still stored and
 * ledgered by the route, but no extraction runs and the state says `unavailable`: nothing is invented.
 *
 * Imports `@vashistha/perception/extraction` (which pulls the Claude wrapper's routing table), so this
 * module is loaded by the composition root only; route handlers see `PerceptionService` as a type.
 */
import { z } from "zod";
import { ProposedConceptSchema, type DomainConfig, type NewLedgerEntry, type ProposedConcept } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { createStateApplier, percentile, type StateApplier } from "@vashistha/perception";
import {
  interpretReading,
  type CaseSnapshot,
  type EncodedImage,
  type ExtractionResult,
  type FrameReading,
  type PreparedRead,
  type ScreenProfile,
} from "@vashistha/perception/extraction";
import type { VisionState } from "../../contracts/frames";
import { CASEDESK_SCHEMA_VERSION } from "../casedesk/session";
import type { ReadPreparer } from "./prepare";

export type VisionFrame = EncodedImage & { sourceWidth: number; sourceHeight: number };
export type VisionCrop = EncodedImage & { rect: { x: number; y: number; width: number; height: number } };

/** One stored, ledgered frame waiting for extraction. */
export type VisionJob = {
  sessionId: string;
  /** The `frame.received` entry: parent of every entry derived from this frame. */
  ledgerId: string;
  traceId: string;
  frameSeq: number;
  /** Browser clock. */
  captureTime: number;
  /** Server clock, when the frame was accepted. */
  receivedAt: number;
  epoch: number;
  frame: VisionFrame;
  crop: VisionCrop | null;
};

/** One model call per frame: answers the prepared read with the structured output exactly as the model gave it. */
export type VisionExtractor = (read: PreparedRead) => Promise<FrameReading>;

export type UnavailableReason = NonNullable<VisionState["unavailableReason"]>;

export type PerceptionServiceOptions = {
  ledger: Ledger;
  domain: DomainConfig;
  /** What the app on screen lets the reviewer edit (declared by the app, see screen-profile.ts). */
  profile: ScreenProfile;
  extractor: { run: VisionExtractor } | { unavailable: UnavailableReason };
  /** Decodes a frame and plans its read (prepare.ts): the vision worker thread in the server, in process in tests. */
  prepare: ReadPreparer;
  now: () => number;
  log: Pick<Console, "error">;
};

export type PerceptionService = {
  /**
   * Claims `frameSeq` for the session's vision channel: true when it is strictly newer than every
   * frame claimed before (the claim then stands even if storing the frame later fails).
   */
  claimFrameSeq(sessionId: string, frameSeq: number): boolean;
  /** Queues a stored, ledgered frame for extraction (a no-op beyond counting when extraction is unavailable). */
  submit(job: VisionJob): void;
  /**
   * Off-the-record hook (plan §7.8): drops the waiting frame and abandons the in-flight extraction
   * of `sessionId` (its result can no longer be applied), moving the worker to privacy epoch `epoch`.
   */
  cancel(sessionId: string, epoch: number): void;
  state(session: { id: string; privacyEpoch: number; offRecord: boolean }): VisionState;
  /** Resolves when the session has nothing waiting or in flight. */
  idle(sessionId: string): Promise<void>;
};

const MAX_SAMPLES = 4096;
const MAX_ERROR_LENGTH = 300;

const FrameSeqPayloadSchema = z.object({ frameSeq: z.int().nonnegative() });
const ConceptNamePayloadSchema = z.object({ name: z.string() });
const LEDGER_REFUSALS = new Set(["StaleEpochError", "OffRecordError", "SessionArchivedError"]);

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown";
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** "documentStatus" → "Document status". */
function labelOf(name: string): string {
  const words = name.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A vision-proposed concept in the engine's `ProposedConcept` shape. The type is read off the value
 * the screen showed (yes/no → boolean, a number → number, otherwise an enum seeded with that value);
 * it is a proposal for the expert to confirm, never a feature.
 */
export function toConceptPayload(concept: { name: string; description: string; observedValue: string | null }): ProposedConcept | null {
  const observed = concept.observedValue?.trim() ?? "";
  const type = /^(true|false|yes|no)$/i.test(observed)
    ? "boolean"
    : observed !== "" && Number.isFinite(Number(observed.replace(/[,\s]/g, "")))
      ? "number"
      : "enum";
  const parsed = ProposedConceptSchema.safeParse({
    name: concept.name,
    label: labelOf(concept.name),
    definition: concept.description.trim(),
    type,
    ...(type === "enum" && observed !== "" && { values: [observed] }),
  });
  return parsed.success ? parsed.data : null;
}

type Counts = VisionState["counts"];

type Worker = {
  epoch: number;
  pending: VisionJob | null;
  inFlight: { job: VisionJob; abandoned: boolean } | null;
  snapshot: CaseSnapshot | null;
  /** Highest frameSeq handed to the worker (waiting, in flight or done). */
  newest: number;
  lastApplied: number | null;
  conceptNames: Set<string>;
  counts: Counts;
  captureToEvents: number[];
  receiptToEvents: number[];
  lastError: string | null;
  idleWaiters: Array<() => void>;
  applier: StateApplier<{ job: VisionJob; result: ExtractionResult }>;
};

export function createPerceptionService(options: PerceptionServiceOptions): PerceptionService {
  const { ledger, domain, profile, prepare, now, log } = options;
  const extractor = "run" in options.extractor ? options.extractor.run : null;
  const unavailableReason = "unavailable" in options.extractor ? options.extractor.unavailable : null;
  const lastFrameSeqs = new Map<string, number>();
  const workers = new Map<string, Worker>();

  const sample = (list: number[], value: number): void => {
    list.push(value);
    if (list.length > MAX_SAMPLES) list.shift();
  };

  function lastFrameSeq(sessionId: string): number {
    const known = lastFrameSeqs.get(sessionId);
    if (known !== undefined) return known;
    const last = ledger.list(sessionId, { sources: ["client"], kinds: ["frame.received"] }).at(-1);
    const recovered = last === undefined ? 0 : FrameSeqPayloadSchema.parse(last.payload).frameSeq;
    lastFrameSeqs.set(sessionId, recovered);
    return recovered;
  }

  /** Appends a fresh result, unless the session left this epoch or went off the record meanwhile. */
  function commit(worker: Worker, job: VisionJob, result: ExtractionResult): void {
    const session = ledger.getSession(job.sessionId);
    if (!session || session.offRecord || session.archived || session.privacyEpoch !== job.epoch) {
      worker.counts.staleDropped += 1;
      return;
    }
    const concepts: ProposedConcept[] = [];
    for (const proposed of result.concepts) {
      const key = proposed.name.toLowerCase();
      const payload = worker.conceptNames.has(key) ? null : toConceptPayload(proposed);
      if (payload === null) continue;
      worker.conceptNames.add(key);
      concepts.push(payload);
    }
    const base = { sessionId: job.sessionId, traceId: job.traceId, parentIds: [job.ledgerId], schemaVersion: CASEDESK_SCHEMA_VERSION };
    const entries: NewLedgerEntry[] = [
      ...result.events.map(
        (event): NewLedgerEntry => ({
          ...base,
          source: "vision",
          kind: "screen.event",
          occurredAt: job.captureTime,
          privacyEpoch: job.epoch,
          payload: event,
        }),
      ),
      ...concepts.map(
        (concept): NewLedgerEntry => ({
          ...base,
          source: "engine",
          kind: "concept.proposed",
          occurredAt: job.captureTime,
          privacyEpoch: job.epoch,
          payload: concept,
        }),
      ),
    ];
    try {
      // Synchronous (SQLite): nothing can change the session between the check above and this append.
      ledger.appendMany(entries);
    } catch (error) {
      for (const concept of concepts) worker.conceptNames.delete(concept.name.toLowerCase());
      if (error instanceof Error && LEDGER_REFUSALS.has(error.name)) worker.counts.staleDropped += 1;
      else {
        worker.counts.failed += 1;
        worker.lastError = describe(error);
        log.error(`[perception] could not append vision results for frame ${job.frameSeq}: ${worker.lastError}`);
      }
      return;
    }
    const appliedAt = now();
    worker.snapshot = result.snapshot;
    worker.lastApplied = job.frameSeq;
    worker.counts.applied += 1;
    worker.counts.events += result.events.length;
    worker.counts.concepts += concepts.length;
    sample(worker.captureToEvents, appliedAt - job.captureTime);
    sample(worker.receiptToEvents, appliedAt - job.receivedAt);
  }

  function worker(sessionId: string, epoch: number): Worker {
    const existing = workers.get(sessionId);
    if (existing) return existing;
    const conceptNames = new Set(
      ledger.list(sessionId, { kinds: ["concept.proposed"] }).flatMap((entry) => {
        const parsed = ConceptNamePayloadSchema.safeParse(entry.payload);
        return parsed.success ? [parsed.data.name.toLowerCase()] : [];
      }),
    );
    const created: Worker = {
      epoch,
      pending: null,
      inFlight: null,
      snapshot: null,
      newest: 0,
      lastApplied: null,
      conceptNames,
      counts: { received: 0, applied: 0, coalesced: 0, staleDropped: 0, failed: 0, events: 0, concepts: 0 },
      captureToEvents: [],
      receiptToEvents: [],
      lastError: null,
      idleWaiters: [],
      applier: createStateApplier({
        currentEpoch: () => created.epoch,
        apply: ({ job, result }) => commit(created, job, result),
      }),
    };
    workers.set(sessionId, created);
    return created;
  }

  function settleIdle(w: Worker): void {
    if (w.pending !== null || w.inFlight !== null) return;
    for (const resolve of w.idleWaiters.splice(0)) resolve();
  }

  function pump(w: Worker, run: VisionExtractor): void {
    if (w.inFlight !== null || w.pending === null) return settleIdle(w);
    const job = w.pending;
    w.pending = null;
    const slot = { job, abandoned: false };
    w.inFlight = slot;
    const context = { domain, profile, previous: w.snapshot, frameSeq: job.frameSeq, captureTime: job.captureTime, sessionEpoch: job.epoch };
    Promise.resolve()
      .then(async () => {
        // Decoded only for frames that reach the model (coalesced ones never are): code compares it with the last reading.
        const read = await prepare({ ...context, frame: job.frame, crop: job.crop });
        return interpretReading(await run(read), read.context);
      })
      .then(
        (result) => {
          if (slot.abandoned || !w.applier.offer({ frameSeq: job.frameSeq, epoch: job.epoch }, { job, result }))
            w.counts.staleDropped += 1;
        },
        (error: unknown) => {
          if (slot.abandoned) w.counts.staleDropped += 1;
          else {
            w.counts.failed += 1;
            w.lastError = describe(error);
          }
        },
      )
      .finally(() => {
        w.inFlight = null;
        pump(w, run);
      });
  }

  /** Moves the worker to a newer epoch: the waiting frame is dropped and the in-flight result abandoned. */
  function advance(w: Worker, epoch: number): void {
    if (epoch <= w.epoch) return;
    w.epoch = epoch;
    if (w.pending !== null) {
      w.pending = null;
      w.counts.staleDropped += 1;
    }
    if (w.inFlight !== null) w.inFlight.abandoned = true;
    settleIdle(w);
  }

  return {
    claimFrameSeq(sessionId, frameSeq) {
      if (frameSeq <= lastFrameSeq(sessionId)) return false;
      lastFrameSeqs.set(sessionId, frameSeq);
      return true;
    },

    submit(job) {
      const w = worker(job.sessionId, job.epoch);
      w.counts.received += 1;
      if (extractor === null) return;
      advance(w, job.epoch);
      // Concurrent uploads can finish storing in reverse order: an older frame never displaces a newer one.
      if (job.epoch < w.epoch || job.frameSeq <= w.newest) {
        w.counts.staleDropped += 1;
        return;
      }
      w.newest = job.frameSeq;
      if (w.pending !== null) w.counts.coalesced += 1;
      w.pending = job;
      pump(w, extractor);
    },

    cancel(sessionId, epoch) {
      const w = workers.get(sessionId);
      if (w) advance(w, epoch);
    },

    state(session) {
      const w = workers.get(session.id);
      const summary = (samples: readonly number[]) => ({ n: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95) });
      return {
        extraction: extractor === null ? "unavailable" : "available",
        unavailableReason,
        privacyEpoch: session.privacyEpoch,
        offRecord: session.offRecord,
        lastFrameSeq: lastFrameSeq(session.id),
        inFlight: w?.inFlight != null,
        pendingFrameSeq: w?.pending?.frameSeq ?? null,
        lastAppliedFrameSeq: w?.lastApplied ?? null,
        counts: w ? { ...w.counts } : { received: 0, applied: 0, coalesced: 0, staleDropped: 0, failed: 0, events: 0, concepts: 0 },
        latencyMs: { captureToEvents: summary(w?.captureToEvents ?? []), receiptToEvents: summary(w?.receiptToEvents ?? []) },
        lastError: w?.lastError ?? null,
      };
    },

    idle(sessionId) {
      const w = workers.get(sessionId);
      if (!w || (w.pending === null && w.inFlight === null)) return Promise.resolve();
      return new Promise((resolve) => w.idleWaiters.push(resolve));
    },
  };
}
