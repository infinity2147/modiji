/**
 * One session's schema state, folded from its ledger (plan §6.6, §7.1, §7.3 B, §7.5):
 *
 * - undefined concepts: every concept a model proposed (`concept.proposed` from the interview proposer
 *   or vision, `newConcepts` of an `answer.parsed`), deduplicated by name, minus base features, minus
 *   what the expert confirmed or dismissed. Only the expert's confirm/dismiss makes the count go down;
 *   a later proposal of a confirmed or dismissed name is ignored.
 * - the feature model: base domain + confirmed concepts (`featureModel`), version = base + confirmations;
 * - backfilled values per observed decision (`feature.backfilled`).
 *
 * Reads payloads through the ledger kind registry; an entry that cannot be applied is listed in
 * `skipped` with the reason, never dropped silently. Pure: no clock, no I/O.
 */
import { parseLedgerPayload } from "../schemas/ledger-kinds";
import type { BackfillFailure, ConceptDefinition, ConceptDismissedPayloadSchema } from "../schemas/concepts";
import type { DomainConfig } from "../schemas/domain";
import type { ProposedConcept } from "../schemas/engine";
import type { LedgerEntry } from "../schemas/ledger";
import { unknown, type FeatureId, type FeatureValue } from "../schemas/primitives";
import type { z } from "zod";
import { BASE_SCHEMA_VERSION, baseFeatureModel, featureModel, type FeatureModel } from "./feature-model";

/** Ledger kinds the fold reads; list exactly these to build a session's schema. */
export const SCHEMA_LEDGER_KINDS = [
  "concept.proposed",
  "answer.parsed",
  "concept.confirmed",
  "concept.dismissed",
  "schema.version_bumped",
  "feature.backfilled",
] as const;

/**
 * Kinds after which a session's feature model, concept values or settled concepts change: state derived
 * under the old model (hypotheses, observations, undefined concepts) must be rebuilt.
 */
export const REMODEL_LEDGER_KINDS: ReadonlySet<string> = new Set(["concept.confirmed", "concept.dismissed", "schema.version_bumped", "feature.backfilled"]);

export type ConceptProposal = {
  concept: ProposedConcept;
  /** Entries that proposed it (`concept.proposed` or `answer.parsed`), in ledger order. */
  entryIds: string[];
  /** Who proposed it first: the interview's concept proposer, the answer parser, or the vision channel. */
  origin: "interview" | "answer" | "vision";
};

export type ConfirmedConceptRecord = {
  definition: ConceptDefinition;
  schemaVersion: number;
  entryId: string;
  /** The `schema.version_bumped` entry for it, once written. */
  bumpEntryId: string | undefined;
};

export type DismissedConcept = z.infer<typeof ConceptDismissedPayloadSchema> & { entryId: string };

export type BackfillRecord = { value: FeatureValue; entryId: string; failure: BackfillFailure | undefined; frameIds: string[] };

export type SessionSchema = {
  model: FeatureModel;
  /** Undefined concepts, in order of first proposal. */
  undefinedConcepts: ConceptProposal[];
  confirmed: ConfirmedConceptRecord[];
  dismissed: DismissedConcept[];
  /** decision entry id → feature id → backfilled value. */
  backfills: Map<string, Map<string, BackfillRecord>>;
  skipped: { ledgerEntryId: string; reason: string }[];
};

function originOf(e: LedgerEntry, concept: ProposedConcept): ConceptProposal["origin"] {
  if (e.kind === "answer.parsed") return "answer";
  // The interview proposer always carries the expert's verbatim words; vision proposals come from the screen.
  return concept.exactQuote === undefined ? "vision" : "interview";
}

export function foldSessionSchema(base: DomainConfig, entries: readonly LedgerEntry[], baseVersion: number = BASE_SCHEMA_VERSION): SessionSchema {
  const proposals = new Map<string, ConceptProposal>();
  const confirmed: ConfirmedConceptRecord[] = [];
  const dismissed: DismissedConcept[] = [];
  const backfills = new Map<string, Map<string, BackfillRecord>>();
  const skipped: SessionSchema["skipped"] = [];
  let model = baseFeatureModel(base, baseVersion);

  const propose = (e: LedgerEntry, concept: ProposedConcept): void => {
    const known = proposals.get(concept.name);
    if (known !== undefined) known.entryIds.push(e.id);
    else proposals.set(concept.name, { concept, entryIds: [e.id], origin: originOf(e, concept) });
  };

  for (const e of entries) {
    try {
      switch (e.kind) {
        case "concept.proposed":
          propose(e, parseLedgerPayload(e, "concept.proposed"));
          break;
        case "answer.parsed":
          for (const c of parseLedgerPayload(e, "answer.parsed").newConcepts) propose(e, c);
          break;
        case "concept.confirmed": {
          const p = parseLedgerPayload(e, "concept.confirmed");
          if (p.feature !== p.definition.name) throw new Error(`confirms "${p.feature}" with a definition of "${p.definition.name}"`);
          const next = featureModel(base, [...confirmed, { definition: p.definition, schemaVersion: p.schemaVersion }], baseVersion);
          if (!next.ok) throw new Error(next.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
          model = next.model;
          confirmed.push({ definition: p.definition, schemaVersion: p.schemaVersion, entryId: e.id, bumpEntryId: undefined });
          break;
        }
        case "concept.dismissed":
          dismissed.push({ ...parseLedgerPayload(e, "concept.dismissed"), entryId: e.id });
          break;
        case "schema.version_bumped": {
          const p = parseLedgerPayload(e, "schema.version_bumped");
          const record = confirmed.find((c) => c.definition.name === p.feature && c.schemaVersion === p.to);
          if (record === undefined) throw new Error(`bump to ${p.to} for "${p.feature}" has no matching confirmation`);
          record.bumpEntryId = e.id;
          break;
        }
        case "feature.backfilled": {
          const p = parseLedgerPayload(e, "feature.backfilled");
          if (!model.conceptFeatures.includes(p.feature)) throw new Error(`backfill of "${p.feature}", which is not a confirmed concept`);
          const perDecision = backfills.get(p.decisionEntryId) ?? new Map<string, BackfillRecord>();
          // First write wins: a value once recorded for a decision is never replaced by a later re-read.
          if (!perDecision.has(p.feature)) perDecision.set(p.feature, { value: p.value, entryId: e.id, failure: p.failure, frameIds: p.frameIds });
          backfills.set(p.decisionEntryId, perDecision);
          break;
        }
      }
    } catch (error) {
      skipped.push({ ledgerEntryId: e.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const settled = new Set([...confirmed.map((c) => c.definition.name), ...dismissed.map((d) => d.name)].map((n) => n.toLowerCase()));
  const features = new Set(model.domain.features.map((f) => f.id.toLowerCase()));
  const undefinedConcepts = [...proposals.values()].filter((p) => !settled.has(p.concept.name.toLowerCase()) && !features.has(p.concept.name.toLowerCase()));
  return { model, undefinedConcepts, confirmed, dismissed, backfills, skipped };
}

/**
 * Values of the session's confirmed concepts for one observed decision: the backfilled value, or
 * `Unknown{not_extracted}` while no backfill has been recorded yet (the re-read is pending).
 */
export function conceptValues(schema: SessionSchema, decisionEntryId: string): Record<FeatureId, FeatureValue> {
  const recorded = schema.backfills.get(decisionEntryId);
  return Object.fromEntries(
    schema.model.conceptFeatures.map((id) => [id, recorded?.get(id)?.value ?? unknown("not_extracted")]),
  ) as Record<FeatureId, FeatureValue>;
}

/** (decision, feature) pairs of `decisionEntryIds` with no backfill recorded yet. */
export function pendingBackfills(schema: SessionSchema, decisionEntryIds: readonly string[]): { decisionEntryId: string; feature: string }[] {
  return decisionEntryIds.flatMap((decisionEntryId) =>
    schema.model.conceptFeatures.filter((feature) => schema.backfills.get(decisionEntryId)?.has(feature) !== true).map((feature) => ({ decisionEntryId, feature })),
  );
}
