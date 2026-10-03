/**
 * Model-prompt half of the oracle guard (plan §6.2: the hidden policy is never bundled or sent to
 * any model). Every `*.oracle.server.ts` module exports a canary `ORACLE_MARKER =
 * "oracle:<domainId>:<hex>"` embedded in its policy, so a serialised policy carries the marker;
 * any outgoing prompt containing one is refused. Pure and isomorphic.
 */
import { z } from "zod";

/** Canonical marker shape (the bundle scanner enforces the same); group 1 is the domain id. */
const MARKER_PATTERN = /^oracle:([A-Za-z][A-Za-z0-9_]{0,63}):[0-9a-f]{16,}$/;

export const OracleMarkerSchema = z.string().regex(MARKER_PATTERN, "must be an oracle marker: oracle:<domainId>:<≥16 lowercase hex>");

/** A prompt contained a hidden-policy marker. The message names domains only, never prompt text. */
export class OracleLeakError extends Error {
  override readonly name: string = "OracleLeakError";
  /** Domain ids of the leaked markers (`"unrecognised"` for a marker not in the canonical shape). */
  readonly domainIds: readonly string[];

  constructor(domainIds: readonly string[]) {
    super(`Refused: text contains the hidden-policy marker of oracle domain(s) ${domainIds.join(", ")}`);
    this.domainIds = domainIds;
  }
}

/** Markers present in `text`. */
export function findMarkersInText(text: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => text.includes(marker));
}

/** Throws `OracleLeakError` if any marker occurs in any of `texts`. */
export function assertNoOracleMarkers(texts: readonly string[], markers: readonly string[]): void {
  if (markers.length === 0) return;
  const leaked = new Set<string>();
  for (const text of texts) for (const marker of findMarkersInText(text, markers)) leaked.add(marker);
  if (leaked.size === 0) return;
  const domainIds = [...leaked].map((marker) => MARKER_PATTERN.exec(marker)?.[1] ?? "unrecognised");
  throw new OracleLeakError([...new Set(domainIds)].sort());
}
