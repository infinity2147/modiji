/**
 * The debrief's Z3 witness search (plan §7.5): `@vashistha/solver` `searchWitnesses`. The composition
 * root injects it running in the Z3 worker thread (workers/z3.ts), so neither route bundles nor the
 * request event loop ever load or run the solver; tests inject `searchWitnesses` itself.
 */
import type { ConfirmedRule, DomainConfig, Witness } from "@vashistha/core";

export type WitnessSearch = {
  domain: DomainConfig;
  rules: readonly ConfirmedRule[];
  families: readonly string[];
  schemaVersion: number;
};
/** `truncated`: some family listed `UNRESOLVED_LIMIT` unresolved cells, so the list is not exhaustive. */
export type WitnessSearchResult = { witnesses: Witness[]; truncated: boolean };
export type WitnessSolver = (search: WitnessSearch) => Promise<WitnessSearchResult>;
