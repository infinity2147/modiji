/**
 * Unseen practice cases (plan §7.7): Z3 boundary cases (`practiceCases`) for the weakest rules of
 * the novice's ladder, each turned into a complete synthetic KYC case, and cases a judge enters by
 * hand. Both are recorded as `case.generated` in the session (source `engine` for the solver's,
 * `client` for a judge's) and are then worked like any other case of the session.
 *
 * From witness to case: the witness is a complete valid assignment. The generator is pinned to it on
 * every feature the rulebook reads (closed under the domain constraints that couple features, e.g.
 * entity type and ownership share), so every rule fires on the case exactly as the solver verified;
 * the remaining features are drawn by the seeded generator. The built case is then checked against
 * KycCaseSchema, the domain constraints, and the pinned values; a case that fails is skipped, never
 * patched. Ids come from reserved ranges and seeds from (session, id): the same request on the same
 * ledger yields the same cases.
 */
import "server-only";
import { createHash } from "node:crypto";
import {
  FeatureIdSchema,
  MASTERY_LEVELS,
  evaluatePredicate,
  featuresReferenced,
  recordLookup,
  validateFeatureValue,
  type Assignment,
  type ConfirmedRule,
  type FeatureId,
  type MasteryLevel,
} from "@vashistha/core";
import {
  KYC_DOMAIN,
  KycCaseSchema,
  RiskRatingSchema,
  caseFeatures,
  generateKycCase,
  mulberry32,
  type KycCase,
  type KycFeatureTargets,
} from "@vashistha/core/domains/kyc";
import { JudgeFeaturesSchema, type JudgeFeatures } from "../../contracts/tutor";
import { ApiFailure } from "../casedesk/http";
import { CASEDESK_SCHEMA_VERSION, type LoadedSession } from "../casedesk/session";
import { entry } from "../interview/ledger";
import type { BoundaryWitness, TutorDeps } from "./deps";
import { taughtRules } from "./rules";
import { entryContext, ruleEntryIds } from "./session";
import { tutorRecord } from "./state";

/** Practice cases made per request. */
export const PRACTICE_BATCH = 3;
/** Reserved id ranges (cases.ts uses 01xx–03xx and 4000+): practice NS-2026-1000…1999, judge NS-2026-2000…2999. */
const PRACTICE_FIRST_ID = 1000;
const JUDGE_FIRST_ID = 2000;
const RANGE_SIZE = 1000;

/** The reviewer-editable rating: pinned through the case's opened rating, not a generator target. */
const RISK_RATING = FeatureIdSchema.parse("riskRating");

function caseId(n: number): string {
  return `NS-2026-${String(n).padStart(4, "0")}`;
}

function nextId(existing: readonly string[], first: number): string {
  const used = existing.filter((id) => {
    const n = Number(id.slice(-4));
    return n >= first && n < first + RANGE_SIZE;
  }).length;
  if (used >= RANGE_SIZE) throw new ApiFailure(409, "case_limit", "this session has no case ids left in the reserved range");
  return caseId(first + used);
}

/** A 32-bit generator seed from the session and the case id. */
function seedOf(sessionId: string, id: string): number {
  return createHash("sha256").update(`${sessionId}\u0000${id}`).digest().readUInt32BE(0);
}

/** Every domain constraint holds on the case's decision features. */
function satisfiesConstraints(kycCase: KycCase): boolean {
  const lookup = recordLookup(caseFeatures(kycCase));
  return KYC_DOMAIN.domainConstraints.every((c) => evaluatePredicate(c, lookup).truth === true);
}

/** Features the rulebook reads, closed under the domain constraints that couple features. */
export function pinnedFeatures(rules: readonly ConfirmedRule[]): Set<FeatureId> {
  const pinned = new Set(rules.flatMap((r) => featuresReferenced(r.predicate)));
  const groups = KYC_DOMAIN.domainConstraints.map((c) => featuresReferenced(c));
  for (let grew = true; grew; ) {
    grew = false;
    for (const group of groups)
      if (group.some((f) => pinned.has(f)) && group.some((f) => !pinned.has(f))) {
        for (const f of group) pinned.add(f);
        grew = true;
      }
  }
  return pinned;
}

/**
 * The complete case for a witness assignment, pinned on `pinned`; throws when the generator cannot
 * honour the assignment or the result fails any check.
 */
export function caseFromAssignment(input: { id: string; seed: number; assignment: Assignment; pinned: ReadonlySet<FeatureId> }): KycCase {
  const picked = Object.fromEntries(Object.entries(input.assignment).filter(([f]) => input.pinned.has(f as FeatureId) && f !== RISK_RATING));
  const parsed = JudgeFeaturesSchema.partial().safeParse(picked);
  if (!parsed.success) throw new RangeError(`the witness cannot be built as a case: ${parsed.error.issues[0]?.message ?? "invalid values"}`);
  // Only the pinned features are targets; the generator draws the others.
  const targets = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as Partial<KycFeatureTargets>;
  const generated = generateKycCase(mulberry32(input.seed), { id: input.id, set: "practice", ...targets });
  const rating = input.pinned.has(RISK_RATING) ? RiskRatingSchema.parse(input.assignment[RISK_RATING]) : generated.review.riskRating;
  const kycCase = KycCaseSchema.parse({ ...generated, review: { riskRating: rating } });
  const features = caseFeatures(kycCase);
  const mismatch = [...input.pinned].find((f) => features[f] !== input.assignment[f]);
  if (mismatch !== undefined) throw new RangeError(`the built case differs from the witness on ${mismatch}`);
  if (!satisfiesConstraints(kycCase)) throw new RangeError("the built case violates a domain constraint");
  return kycCase;
}

/** Rules below `mastered`, weakest first (ties: rulebook order). */
export function weakestRules(rules: readonly ConfirmedRule[], levels: ReadonlyMap<string, MasteryLevel>): ConfirmedRule[] {
  const rung = (r: ConfirmedRule): number => MASTERY_LEVELS.indexOf(levels.get(r.id) ?? "untested");
  return rules
    .map((rule, order) => ({ rule, order }))
    .filter(({ rule }) => levels.get(rule.id) !== "mastered")
    .sort((a, b) => rung(a.rule) - rung(b.rule) || a.order - b.order)
    .map(({ rule }) => rule);
}

export type PracticeResult = { cases: KycCase[]; note: string | null };

export async function generatePractice(deps: TutorDeps, loaded: LoadedSession): Promise<PracticeResult> {
  const sessionId = loaded.session.id;
  const book = deps.rulebook();
  const weakest = weakestRules(taughtRules(book.rules), tutorRecord(deps.ledger, sessionId).mastery);
  if (weakest.length === 0)
    return { cases: [], note: book.rules.length === 0 ? "The expert has not confirmed any rules yet." : "Every rule is mastered (heuristic estimate)." };
  const usedBefore = [...tutorRecord(deps.ledger, sessionId).generated.values()].filter((g) => g.payload.origin.kind === "boundary_practice").length;
  const witnesses = await deps.practice({
    domain: KYC_DOMAIN,
    rules: book.rules,
    ruleIds: weakest.map((r) => r.id),
    count: usedBefore + PRACTICE_BATCH,
    schemaVersion: CASEDESK_SCHEMA_VERSION,
  });

  // Re-read after the solver: everything from here to the append is synchronous.
  const record = tutorRecord(deps.ledger, sessionId);
  const usedWitnesses = new Set([...record.generated.values()].flatMap((g) => (g.payload.origin.kind === "boundary_practice" ? [g.payload.origin.witnessId] : [])));
  const ids = [...record.generated.keys()];
  const pinned = pinnedFeatures(book.rules);
  const ruleEntries = ruleEntryIds(book);
  const ctx = entryContext(deps, loaded);
  const made: { kycCase: KycCase; witness: BoundaryWitness }[] = [];
  const skipped: string[] = [];
  for (const witness of witnesses) {
    if (made.length === PRACTICE_BATCH) break;
    if (usedWitnesses.has(witness.id)) continue;
    const id = nextId(ids, PRACTICE_FIRST_ID);
    try {
      made.push({ kycCase: caseFromAssignment({ id, seed: seedOf(sessionId, id), assignment: witness.assignment, pinned }), witness });
      ids.push(id);
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error));
    }
  }
  deps.ledger.appendMany(
    made.map(({ kycCase, witness }) =>
      entry(ctx, "case.generated", "engine", [loaded.info.startedEntryId, ...[ruleEntries.get(witness.ruleId)].filter((id) => id !== undefined)], {
        domainId: KYC_DOMAIN.id,
        case: kycCase,
        origin: { kind: "boundary_practice", witnessId: witness.id, ruleId: witness.ruleId, feature: witness.feature, threshold: witness.threshold, side: witness.side },
      }),
    ),
  );
  for (const reason of skipped) deps.log.warn(`[tutor] practice witness skipped: ${reason}`);
  const note =
    made.length === PRACTICE_BATCH
      ? null
      : made.length === 0 && witnesses.length === 0
        ? "The rules you have not mastered have no numeric thresholds, so the solver finds no boundary cases. Enter a case by hand instead."
        : `Made ${made.length} of ${PRACTICE_BATCH}: the solver has no further distinct boundary cases for these rules.`;
  return { cases: made.map((m) => m.kycCase), note };
}

/** A judge-entered case: every value checked against its domain feature, the domain constraints, then built. */
export function addJudgeCase(deps: TutorDeps, loaded: LoadedSession, features: JudgeFeatures): KycCase {
  for (const [field, value] of Object.entries(features)) {
    const check = validateFeatureValue(KYC_DOMAIN, field, value);
    if (!check.ok) throw new ApiFailure(400, "invalid_value", `features.${field}: ${check.message}`);
  }
  const sessionId = loaded.session.id;
  const id = nextId([...tutorRecord(deps.ledger, sessionId).generated.keys()], JUDGE_FIRST_ID);
  let kycCase: KycCase;
  try {
    kycCase = KycCaseSchema.parse(generateKycCase(mulberry32(seedOf(sessionId, id)), { id, set: "practice", ...features }));
  } catch (error) {
    throw new ApiFailure(400, "invalid_case", error instanceof Error ? error.message : "the values do not form a valid case");
  }
  if (!satisfiesConstraints(kycCase)) throw new ApiFailure(400, "invalid_case", "the values violate a domain constraint");
  deps.ledger.append(
    entry(entryContext(deps, loaded), "case.generated", "client", [loaded.info.startedEntryId], {
      domainId: KYC_DOMAIN.id,
      case: kycCase,
      origin: { kind: "judge" },
    }),
  );
  return kycCase;
}
