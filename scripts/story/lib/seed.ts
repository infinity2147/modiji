/**
 * Public-API calls the recordings use to set up genuine local flows — the same routes and payloads as the
 * e2e specs (apps/web/e2e/{debrief,tutor,replay}.spec.ts). Nothing is intercepted or mocked: every entry
 * these calls create is written by the real server into its append-only ledger.
 */
import { randomUUID } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";

export async function api<T>(base: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${r.status} ${text.slice(0, 400)}`);
  return (text === "" ? null : JSON.parse(text)) as T;
}

export const createSession = (base: string, mode: "expert" | "novice", caseSet: "training" | "heldout" | "practice", expert?: { name: string; language: string }) =>
  api<{ sessionId: string }>(base, "/api/sessions", { body: { mode, caseSet, ...(expert === undefined ? {} : { expert }) } }).then((r) => r.sessionId);

export const openCase = (base: string, sessionId: string, caseId: string, frameSeq: number) =>
  api(base, `/api/sessions/${sessionId}/events`, {
    body: { events: [{ id: randomUUID(), frameSeq, captureTime: Date.now(), sessionEpoch: 0, kind: "open_case", caseId, confidence: 1, source: "dom", critical: false }] },
  });

/** Uploads a PNG through the frames route (as the browser capture pipeline does); returns the frame's ledger id. */
export async function uploadFrame(base: string, sessionId: string, frameSeq: number, png: Buffer, width: number, height: number): Promise<string> {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({ frameSeq, captureTime: Date.now(), privacyEpoch: 0, changeScore: 24, redactedRegions: 0, source: { width, height }, bbox: null, crop: null }),
  );
  form.append("frame", new Blob([new Uint8Array(png)], { type: "image/png" }), "frame.png");
  const r = await fetch(`${base}/api/sessions/${sessionId}/frames`, { method: "POST", body: form });
  const text = await r.text();
  if (r.status !== 202) throw new Error(`frame upload → ${r.status} ${text}`);
  return (JSON.parse(text) as { ledgerId: string }).ledgerId;
}

export async function decide(base: string, sessionId: string, caseId: string, action: string): Promise<void> {
  const { checkId } = await api<{ checkId: string }>(base, "/api/interlock/check", { body: { sessionId, caseId, edits: {}, proposedAction: action } });
  await api(base, `/api/sessions/${sessionId}/decisions`, { body: { caseId, edits: {}, action, checkId } });
}

export type Proposal = { candidateId: string; decisionFamily: string; action: string; text: string };
export type DebriefState = { proposals: Proposal[]; rules: { rule: { id: string; effect: { type: string; action?: string } } }[]; teachBack: { entryId: string } | null };

export const debrief = (base: string, sessionId: string) => api<DebriefState>(base, `/api/sessions/${sessionId}/debrief`);
export const debriefAction = (base: string, sessionId: string, body: unknown) => api<{ state: DebriefState }>(base, `/api/sessions/${sessionId}/debrief`, { body });

/** A small schematic PNG (for the event-loop probe only; recordings upload real CaseDesk screenshots). */
export function schematicPng(width: number, height: number, variant: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const header = y < 40;
      const row = y > 60 && (y - 60) % 38 < 18 && x > 32 && x < 360;
      const hi = Math.floor((y - 60) / 38) === variant % 7 && x > 420 && x < 600 && row === false && y > 60 && (y - 60) % 38 < 18;
      const [r, g, b] = header ? [30, 41, 59] : hi ? [220, 38, 38] : row ? [203, 213, 225] : [248, 250, 252];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
