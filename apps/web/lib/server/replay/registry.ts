/**
 * The verified replay service as route handlers see it. Like the runtime (runtime.ts), it is built by
 * the custom server (`server.ts` → `replay/service.ts`, unbundled: it opens in-memory SQLite and runs
 * Z3) and shared through `globalThis`; route bundles import only these types.
 */
import type { ReplayBundleResponse, ReplayListResponse, ReplayViewsResponse } from "../../contracts/replay";

export type OpenResult = { ok: true; body: ReplayBundleResponse } | { ok: false; status: 404 | 409; code: string; detail: string };

export type ReplayService = {
  list: () => Promise<ReplayListResponse>;
  /** Re-verifies the bundle from disk (every call) and returns it, or why it is refused. */
  open: (bundleId: string) => Promise<OpenResult>;
  /** Server views derived from the first `n` timeline entries of a verified bundle; null when not verified. */
  views: (bundleId: string, n: number) => Promise<ReplayViewsResponse | null>;
  /** A file listed in a verified bundle's manifest, re-hashed on read; null otherwise. */
  file: (bundleId: string, path: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Guarded import (bearer-checked by the route): stage one file of a bundle (`manifest.json` or a bundle path). */
  stage: (bundleId: string, path: string, bytes: Uint8Array) => Promise<ImportResult>;
  /** Verifies the staged bundle and moves it into place; never replaces an existing bundle. */
  commit: (bundleId: string) => Promise<ImportResult>;
};

export type ImportResult = { ok: true; detail: string } | { ok: false; status: 400 | 409 | 422; code: string; detail: string };

const KEY: unique symbol = Symbol.for("vashistha.replay");
const registry = globalThis as typeof globalThis & { [KEY]?: ReplayService | undefined };

export function registerReplay(service: ReplayService | undefined): void {
  registry[KEY] = service;
}

export function getReplay(): ReplayService {
  const service = registry[KEY];
  if (!service) throw new Error("Sage replay service is not initialised: start the app through server.ts");
  return service;
}
