/**
 * Uploads a redacted screen frame through the public frames route (`POST /api/sessions/:id/frames`,
 * multipart PNG), as the browser's capture pipeline does while the expert shares their screen. Headless
 * Chromium cannot capture a screen (see perception.spec.ts), so the API-seeded specs send a small
 * generated PNG instead: a schematic case page (header bar, field rows, one highlighted field). The
 * server validates and stores it and appends the `frame.received` entry every confirmed rule must cite.
 * The server runs with LLM_CALLS=off, so no model ever reads it.
 */
import { expect, type APIRequestContext } from "@playwright/test";
import { createRgba, type RgbaImage } from "@vashistha/perception";
import { encodePng } from "@vashistha/perception/png";

const WIDTH = 640;
const HEIGHT = 360;

function fill(image: RgbaImage, x0: number, y0: number, w: number, h: number, [r, g, b]: [number, number, number]): void {
  for (let y = y0; y < Math.min(HEIGHT, y0 + h); y += 1)
    for (let x = x0; x < Math.min(WIDTH, x0 + w); x += 1) image.data.set([r, g, b, 255], (y * WIDTH + x) * 4);
}

/** A schematic CaseDesk page; `variant` moves the highlighted row so successive frames differ. */
function casePage(variant: number): Buffer {
  const image = createRgba(WIDTH, HEIGHT);
  fill(image, 0, 0, WIDTH, HEIGHT, [248, 250, 252]);
  fill(image, 0, 0, WIDTH, 40, [30, 41, 59]);
  for (let row = 0; row < 7; row += 1) fill(image, 32, 64 + row * 38, 360 - (row % 3) * 60, 18, [203, 213, 225]);
  fill(image, 420, 64 + (variant % 7) * 38, 180, 18, [220, 38, 38]);
  return encodePng(image);
}

export type UploadedFrame = { frameId: string; ledgerId: string; mediaUrl: string };

export async function uploadFrame(request: APIRequestContext, sessionId: string, frameSeq: number, privacyEpoch = 0): Promise<UploadedFrame> {
  const metadata = {
    frameSeq,
    captureTime: Date.now(),
    privacyEpoch,
    changeScore: 24,
    redactedRegions: 0,
    source: { width: WIDTH, height: HEIGHT },
    bbox: null,
    crop: null,
  };
  const response = await request.post(`/api/sessions/${sessionId}/frames`, {
    multipart: { metadata: JSON.stringify(metadata), frame: { name: "frame.png", mimeType: "image/png", buffer: casePage(frameSeq) } },
  });
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()) as UploadedFrame;
}
