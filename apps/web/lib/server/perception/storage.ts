/**
 * Redacted frame storage under `DATA_DIR/media/<sessionId>/frames/<frameId>.png`. Every path is
 * built from ids that must be lower-case UUIDs (what the server itself generates), then resolved
 * and checked to stay inside `DATA_DIR/media`, so no request value can traverse the filesystem.
 * Writes are atomic (temporary file + rename): a reader never sees a partial PNG.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { frameMediaPath } from "../../contracts/frames";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height from a PNG's signature and IHDR chunk, or null when the bytes are not a PNG.
 * Only the header is inspected; the image is never decoded on the server.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function mediaRoot(dataDir: string): string {
  return resolve(dataDir, "media");
}

/** Absolute path of a stored frame; throws unless both ids are UUIDs and the result stays inside the media root. */
export function framePath(dataDir: string, sessionId: string, frameId: string): string {
  if (!isUuid(sessionId) || !isUuid(frameId)) throw new RangeError("session and frame ids must be lower-case UUIDs");
  const root = mediaRoot(dataDir);
  const path = resolve(root, frameMediaPath(sessionId, frameId));
  if (!path.startsWith(root + sep)) throw new RangeError("media path escapes the media root");
  return path;
}

/** Writes the frame atomically; returns its absolute path. */
export async function writeFrame(dataDir: string, sessionId: string, frameId: string, png: Uint8Array): Promise<string> {
  const path = framePath(dataDir, sessionId, frameId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${frameId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, png, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}

/** Removes a stored frame (used when its ledger entry was refused); missing files are fine. */
export async function removeFrame(dataDir: string, sessionId: string, frameId: string): Promise<void> {
  await rm(framePath(dataDir, sessionId, frameId), { force: true });
}

/** The stored PNG, or null when there is no such file. */
export async function readFrame(dataDir: string, sessionId: string, frameId: string): Promise<Buffer | null> {
  try {
    return await readFile(framePath(dataDir, sessionId, frameId));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
