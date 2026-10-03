/**
 * Browser adapters for the capture pipeline: the screen share (`getDisplayMedia`, user-initiated
 * only), canvas PNG encoding, and the best-effort PII redactor (Tesseract.js served from our own
 * origin under `/tesseract/`, vendored by `packages/perception/scripts/vendor-tesseract.ts`).
 */
import type { KycCase } from "@vashistha/core/domains/kyc";
import { createRedactor, createTesseractOcr, type Redactor, type RgbaImage } from "@vashistha/perception";
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

/** The redactor plus its OCR worker's teardown. */
export function createBrowserRedactor(names: () => readonly string[]): { redactor: Redactor; terminate: () => Promise<void> } {
  const ocr = createTesseractOcr({ basePath: TESSERACT_BASE_PATH });
  return { redactor: createRedactor({ ocr: ocr.ocr, names }), terminate: ocr.terminate };
}
