/**
 * Browser adapters for the capture pipeline: the screen share (`getDisplayMedia`, user-initiated
 * only), canvas PNG encoding, and the best-effort PII redactor (Tesseract.js served from our own
 * origin under `/tesseract/`, vendored by `packages/perception/scripts/vendor-tesseract.ts`).
 */
import type { KycCase } from "@vashistha/core/domains/kyc";
import {
  createCaseIdTracker,
  createRedactor,
  createTesseractOcr,
  type CaseIdReaderConfig,
  type CaseIdTracker,
  type OcrScale,
  type Redactor,
  type RgbaImage,
} from "@vashistha/perception";
import type { FrameGrabber, PngEncoder } from "./pipeline";

/** Where `createTesseractOcr` loads its worker, cores and English model (apps/web/public/tesseract). */
export const TESSERACT_BASE_PATH = "/tesseract/";

/** Large (HiDPI) screens are grabbed at this long edge at most; the upload is ≤1568 px anyway. */
const MAX_GRAB_LONG_EDGE = 2560;

/**
 * Asks the browser for a screen share. Must be called from a user gesture (the "Share screen"
 * click); the browser shows its own picker and sharing indicator.
 */
export async function startScreenShare(): Promise<FrameGrabber> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 5 } }, audio: false });
  const [track] = stream.getVideoTracks();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (error) {
    for (const t of stream.getTracks()) t.stop();
    throw error;
  }
  let canvas: OffscreenCanvas | null = null;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  return {
    grab(): RgbaImage | null {
      const { videoWidth, videoHeight } = video;
      if (videoWidth === 0 || videoHeight === 0) return null;
      const scale = Math.min(1, MAX_GRAB_LONG_EDGE / Math.max(videoWidth, videoHeight));
      const width = Math.round(videoWidth * scale);
      const height = Math.round(videoHeight * scale);
      if (canvas?.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
        context = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (context === null) throw new Error("2D canvas unavailable");
      context.drawImage(video, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      return { data, width, height };
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
    onEnded(listener) {
      track?.addEventListener("ended", listener, { once: true });
    },
  };
}

export const encodePng: PngEncoder = async (image) => {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas unavailable");
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
};

/** People in the session's synthetic cases: beneficial owners, relationship managers, individual customers. */
export function personNames(cases: readonly KycCase[]): string[] {
  const names = new Set<string>();
  for (const c of cases) {
    for (const owner of c.owners) names.add(owner.name);
    names.add(c.relationship.relationshipManager);
    if (c.customer.entityType === "individual") names.add(c.customer.name);
  }
  return [...names];
}

/**
 * OCR upscaling for the PII pass: 2× for local changes; regions of at least a quarter of the frame
 * (case switches, scrolls — the slow reads that dominate the client's p95) at a lower scale.
 * Chosen from `e2e/perception-ocr-latency.spec.ts` (latency and PII-box recall per setting,
 * docs/evidence/p2/ocr-latency.json).
 */
export const CLIENT_OCR_SCALE: OcrScale = { scale: 2, largeRegion: { share: 0.25, scale: 1.5 } };

/** The redactor plus its OCR worker's teardown. */
export function createBrowserRedactor(names: () => readonly string[]): { redactor: Redactor; terminate: () => Promise<void> } {
  const ocr = createTesseractOcr({ basePath: TESSERACT_BASE_PATH, ...CLIENT_OCR_SCALE });
  return { redactor: createRedactor({ ocr: ocr.ocr, names }), terminate: ocr.terminate };
}

/**
 * Reading the CaseDesk case id on-device (team P2 decision). Case ids are `NS-####-####`; the open
 * case's id sits in the detail-panel header's top band — measured on the recorded fixture (1440×900)
 * at x≈305, y≈67, while the queue-list ids are at x≈17 and the review column's at x≈1150. The
 * fractional region keeps only the header id, independent of the capture resolution.
 */
export const CASEDESK_CASE_ID: Pick<CaseIdReaderConfig, "pattern" | "region"> = {
  pattern: /^NS-\d{4}-\d{4}$/,
  region: { x: 0.1, y: 0, width: 0.68, height: 0.2 },
};

/** A tracker that reads the CaseDesk case id from the redactor's OCR words and carries it forward. */
export function createBrowserCaseIdTracker(): CaseIdTracker {
  return createCaseIdTracker({ ...CASEDESK_CASE_ID });
}
