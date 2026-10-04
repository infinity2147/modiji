/** Shared setup for the vision-channel tests: CaseDesk harness + perception service + temp DATA_DIR + multipart helpers. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KYC_DOMAIN, kycCases } from "@vashistha/core/domains/kyc";
import { createVolumeFrameStore } from "../../lib/server/perception/frame-store";
import { CASEDESK_SCREEN } from "../../lib/server/perception/screen-profile";
import { createRgba } from "@vashistha/perception";
import type { FrameReading, FullRead, ReadMode } from "@vashistha/perception/extraction";
import { encodePng } from "../../../../packages/perception/src/png";
import type { FrameMetadata } from "../../lib/contracts/frames";
import { handlePostFrame, handleVisionState, type PerceptionDeps } from "../../lib/server/perception/frames";
import { prepareFrame } from "../../lib/server/perception/prepare";
import { createPerceptionService, type PerceptionServiceOptions, type VisionExtractor } from "../../lib/server/perception/service";
import { T0, createCaseDeskHarness, type CaseDeskHarness, type Reply } from "./casedesk-harness";

export const SOURCE = { width: 160, height: 100 } as const;

/** A solid-colour PNG of the given size. */
export function png(width: number = SOURCE.width, height: number = SOURCE.height, shade = 200): Buffer {
  const image = createRgba(width, height);
  image.data.fill(shade);
  return encodePng(image);
}

export function metadata(over: Partial<FrameMetadata> = {}): FrameMetadata {
  return {
    frameSeq: 1,
    captureTime: T0,
    privacyEpoch: 0,
    changeScore: 12.5,
    redactedRegions: 2,
    source: { ...SOURCE },
    bbox: null,
    crop: null,
    caseId: null,
    ...over,
  };
}

export type FrameParts = { metadata?: unknown; frame?: Uint8Array | string; crop?: Uint8Array };

export function frameRequest(sessionId: string, parts: FrameParts): Request {
  const form = new FormData();
  if (parts.metadata !== undefined)
    form.set("metadata", typeof parts.metadata === "string" ? parts.metadata : JSON.stringify(parts.metadata));
  if (typeof parts.frame === "string") form.set("frame", parts.frame);
  else if (parts.frame !== undefined) form.set("frame", new Blob([new Uint8Array(parts.frame)], { type: "image/png" }), "frame.png");
  if (parts.crop !== undefined) form.set("crop", new Blob([new Uint8Array(parts.crop)], { type: "image/png" }), "crop.png");
  return new Request(`http://localhost/api/sessions/${sessionId}/frames`, { method: "POST", body: form });
}

/** What the model would answer for a screen showing `output`, in the shape of the read that was asked for. */
function answer(mode: ReadMode, output: FullRead): FrameReading {
  const { concepts, ...caseState } = output;
  if (mode === "local") return { mode, output: { fields: output.fields, committed: output.committed } };
  return mode === "refresh" ? { mode, output: caseState } : { mode, output: { ...caseState, concepts } };
}

/** A controllable extractor: every call waits until the test resolves (with what the screen shows) or rejects it. */
export function controlledExtractor() {
  const calls: Array<{
    frameSeq: number;
    previous: Parameters<VisionExtractor>[0]["context"]["previous"];
    mode: ReadMode;
    images: number;
    resolve: (screen: FullRead) => void;
    reject: (error: unknown) => void;
  }> = [];
  const run: VisionExtractor = (read) =>
    new Promise<FrameReading>((resolve, reject) => {
      const content = read.request.messages[0]?.content;
      const images = Array.isArray(content) ? content.filter((b) => b.type === "image").length : 0;
      calls.push({
        frameSeq: read.context.frameSeq,
        previous: read.context.previous,
        mode: read.mode,
        images,
        resolve: (screen) => resolve(answer(read.mode, screen)),
        reject,
      });
    });
  return { run, calls };
}

export const trainingCaseId = (): string => {
  const id = kycCases("training")[0]?.id;
  if (id === undefined) throw new Error("no training case");
  return id;
};

/** A screen showing `caseId` with the given risk rating (and, optionally, more). */
export function caseReading(caseId: string, riskRating: string, over: Partial<FullRead> = {}): FullRead {
  return { caseId, caseTitle: `Customer of ${caseId}`, fields: { riskRating }, committed: null, concepts: [], ...over };
}

/** A concept the model might propose on the frame that opens a case. */
export const DOCUMENT_EXPIRY = { name: "documentExpiry", description: "Whether an identity document has expired", observedValue: "expired" };

export type PerceptionHarness = CaseDeskHarness & {
  dataDir: string;
  deps: CaseDeskHarness["deps"];
  perceptionDeps: PerceptionDeps;
  clock: { now: number };
  postFrame: (sessionId: string, parts: FrameParts) => Promise<Reply>;
  visionState: (sessionId: string) => Promise<Reply>;
  /** Replaces the perception service (a process restart for the vision channel). */
  restartPerception: (extractor?: PerceptionServiceOptions["extractor"]) => void;
  cleanup: () => void;
};

export function createPerceptionHarness(extractor: PerceptionServiceOptions["extractor"]): PerceptionHarness {
  const h = createCaseDeskHarness();
  const dataDir = mkdtempSync(join(tmpdir(), "vashistha-perception-"));
  const clock = { now: T0 + 500 };
  const build = (ex: PerceptionServiceOptions["extractor"]) =>
    createPerceptionService({ ledger: h.ledger, domain: KYC_DOMAIN, profile: CASEDESK_SCREEN, extractor: ex, prepare: async (input) => prepareFrame(input), now: () => clock.now, log: h.deps.log });
  const perceptionDeps: PerceptionDeps = {
    ledger: h.ledger,
    store: h.deps.store,
    perception: build(extractor),
    frames: createVolumeFrameStore(dataDir),
    now: () => clock.now,
    log: h.deps.log,
  };
  const reply = async (response: Response): Promise<Reply> => ({ status: response.status, body: await response.json() });
  return Object.assign(h, {
    dataDir,
    perceptionDeps,
    clock,
    postFrame: async (sessionId: string, parts: FrameParts) => reply(await handlePostFrame(frameRequest(sessionId, parts), sessionId, perceptionDeps)),
    visionState: async (sessionId: string) => reply(await handleVisionState(sessionId, perceptionDeps)),
    restartPerception: (ex: PerceptionServiceOptions["extractor"] = extractor) => {
      perceptionDeps.perception = build(ex);
    },
    cleanup: () => {
      h.opened.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
}
