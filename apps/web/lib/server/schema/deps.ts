/**
 * What the schema-versioning handlers need (plan §6.6). Route adapters build it from the process runtime
 * (`schemaDeps` in runtime-deps.ts); tests build it around an in-memory ledger and a fake re-reader. The
 * re-reader (Claude Haiku over stored redacted frames) arrives as a function from the runtime, so route
 * bundles never load the model client or the filesystem reader.
 */
import "server-only";
import type { BackfillFailure, DomainConfig, EngineConfig, Value } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import type { CaseDeskStore } from "../casedesk/session";
import type { InterviewStore } from "../interview/engine-state";

/** A stored redacted frame of the case, as recorded by its `frame.received` entry. */
export type RereadFrame = { entryId: string; frameId: string; width: number; height: number };

export type RereadResult =
  | { ok: true; value: Value; evidence: string; frameIds: string[] }
  | { ok: false; failure: BackfillFailure; evidence?: string; frameIds: string[] };

/**
 * Reads ONE confirmed concept for ONE past case from its stored frames. `frameIds` in the result are the
 * `frame.received` entry ids whose images were actually sent. Never throws for a model failure: that is
 * `{ ok: false, failure: "model_error" }`.
 */
export type ConceptReread = (input: { sessionId: string; domain: DomainConfig; feature: string; caseId: string; frames: readonly RereadFrame[] }) => Promise<RereadResult>;

/** Per-process state: the tail of each session's serial backfill work. */
export type SchemaStore = { tails: Map<string, Promise<void>> };

export function createSchemaStore(): SchemaStore {
  return { tails: new Map() };
}

export type SchemaDeps = {
  ledger: Ledger;
  casedesk: CaseDeskStore;
  /** The interview engine's derived state (rebuilt under the new feature model after each change). */
  interview: InterviewStore;
  engineConfig: EngineConfig;
  /** Null without a vision model (no ANTHROPIC_API_KEY): every backfill is `Unknown{backfill_failed}` (no_model). */
  reread: ConceptReread | null;
  store: SchemaStore;
  now: () => number;
  log: Pick<Console, "info" | "warn" | "error">;
};
