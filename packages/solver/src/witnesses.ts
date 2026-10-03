/**
 * Solver queries (plan §7.5, §7.7, §7.10, §9). Each runs on a fresh solver in the shared Z3 context,
 * asserts the domain's typed bounds and `domainConstraints`, and returns schema-valid witnesses with
 * deterministic ids. Every witness is re-verified with the Kleene evaluator over the decoded
 * assignment (domain constraints, and the property the query claims, via the reference semantics in
 * semantics.ts); a disagreement throws, since it would be a solver bug.
 *
 * Soundness: the encoding is exact (encode.ts, numbers.ts), so an empty result from `findUnresolved`,
 * `findConflicts` or `findDisagreements` proves that no such case exists under the current feature
 * model. The `limit` caps only how many witnesses are listed.
 */
import { createHash } from "node:crypto";
import {
  SchemaVersionSchema,
  WitnessSchema,
  evaluatePredicate,
  typecheckPredicate,
  type Assignment,
  type DecisionFamily,
  type DomainConfig,
  type FeatureLookup,
  type Predicate,
  type Witness,
} from "@vashistha/core";
import type { Bool, Context, Solver } from "z3-solver";
import { Encoding, leaves, stepAt, thresholdAtoms, type ThresholdAtom } from "./encode";
import { add, rationalOf, toNumber, type Rational } from "./numbers";
import {
  SolverInputError,
  UNRESOLVED,
  decisionFamily,
  decisionRules,
  effectiveDecision,
  encodeFamilyDecision,
  fires,
  firingPredicates,
  prepareRulebook,
  type Outcome,
  type Rulebook,
  type SolverRule,
} from "./semantics";
import { getZ3 } from "./z3";

export type UnresolvedWitness = Extract<Witness, { kind: "unresolved" }>;
export type ConflictWitness = Extract<Witness, { kind: "conflict" }>;
export type BoundaryWitness = Extract<Witness, { kind: "boundary" }>;
export type DisagreementWitness = Extract<Witness, { kind: "disagreement" }>;

type Common = { domain: DomainConfig; schemaVersion: number; limit?: number };
export type FamilyQuery = Common & { rules: readonly SolverRule[]; family: string };
export type BoundaryQuery = Common & { rules: readonly SolverRule[]; ruleId: string };
export type DisagreementQuery = Common & {
  rulesA: readonly SolverRule[];
  rulesB: readonly SolverRule[];
  /** Expert ids for rulebooks A and B, in that order. */
  experts: readonly [string, string];
  family: string;
};
export type PracticeQuery = { domain: DomainConfig; rules: readonly SolverRule[]; ruleIds: readonly string[]; count: number; schemaVersion: number };
export type EquivalenceResult = { equivalent: true } | { equivalent: false; counterexample: Assignment };

export const DEFAULT_LIMITS = { unresolved: 5, conflict: 10, boundary: 30, disagreement: 5 } as const;
const MAX_LIMIT = 1000;

/**
 * Valid cases where no decision rule of the family fires. Successive witnesses lie in different
 * cells of the family's decision partition (the truth values of the leaf conditions of its decision
 * rules and their overriders), so each one is a distinct question rather than a nudged copy.
 */
export async function findUnresolved(q: FamilyQuery): Promise<UnresolvedWitness[]> {
  const { schemaVersion, limit } = options(q, DEFAULT_LIMITS.unresolved);
  const book = prepareRulebook(q.domain, q.rules);
  const family = decisionFamily(q.domain, q.family);
  const relevant = firingPredicates(book, decisionRules(book, family).map((d) => d.rule));
  return withSolver(async (ctx, solver) => {
    const enc = new Encoding(ctx, q.domain, relevant);
    solver.add(...enc.constraints, encodeFamilyDecision(ctx, (p) => enc.encode(p), book, family).unresolved);
    const cell = uniqueLeaves(relevant);
    const out: UnresolvedWitness[] = [];
    while (out.length < limit) {
      const assignment = await enc.solveCanonical(solver);
      if (assignment === undefined) break;
      const lookup = enc.verify(assignment);
      if (effectiveDecision(book, family, lookup).kind !== "unresolved") soundnessFailure("unresolved", assignment);
      out.push(witness<UnresolvedWitness>({ kind: "unresolved", decisionFamily: family.id, assignment, schemaVersion }));
      solver.add(enc.blockCell(cell, lookup));
    }
    return out;
  });
}

/**
 * Genuine conflicts (semantics.ts): for each pair of decision rules of the family with equal priority,
 * different outcomes and no override edge between them, one valid case where both fire and no
 * higher-priority decision rule fires. One witness per pair, pairs in rule-id order.
 */
export async function findConflicts(q: FamilyQuery): Promise<ConflictWitness[]> {
  const { schemaVersion, limit } = options(q, DEFAULT_LIMITS.conflict);
  const book = prepareRulebook(q.domain, q.rules);
  const family = decisionFamily(q.domain, q.family);
  const rules = decisionRules(book, family).sort((a, b) => byId(a.rule, b.rule));
  const pairs = rules.flatMap((a, i) =>
    rules
      .slice(i + 1)
      .filter(
        (b) =>
          a.rule.priority === b.rule.priority &&
          a.outcome.key !== b.outcome.key &&
          !a.rule.overrides.includes(b.rule.id) &&
          !b.rule.overrides.includes(a.rule.id),
      )
      .map((b) => [a, b] as const),
  );
  if (pairs.length === 0) return [];
  return withSolver(async (ctx, solver) => {
    const enc = new Encoding(ctx, q.domain, firingPredicates(book, rules.map((d) => d.rule)));
    const decision = encodeFamilyDecision(ctx, (p) => enc.encode(p), book, family);
    solver.add(...enc.constraints);
    const out: ConflictWitness[] = [];
    for (const [a, b] of pairs) {
      if (out.length >= limit) break;
      solver.push();
      solver.add(fired(decision.fires, a.rule.id), fired(decision.fires, b.rule.id), ctx.Not(decision.firesAbove(a.rule.priority)));
      const assignment = await enc.solveCanonical(solver).finally(() => solver.pop());
      if (assignment === undefined) continue;
      const lookup = enc.verify(assignment);
      const eff = effectiveDecision(book, family, lookup);
      if (eff.kind !== "conflict" || !fires(book, a.rule, lookup) || !fires(book, b.rule, lookup)) soundnessFailure("conflict", assignment);
      out.push(
        witness<ConflictWitness>({
          kind: "conflict",
          decisionFamily: family.id,
          assignment,
          schemaVersion,
          ruleIds: [a.rule.id, b.rule.id],
          actions: [a.outcome.label, b.outcome.label],
        }),
      );
    }
    return out;
  });
}

/**
 * For every comparison of a number feature with a literal threshold t in the rule's predicate (first
 * occurrence of each feature/threshold): a valid case with the feature at t ("at"), just below and just
 * above (integer features t ∓ 1; real features t ∓ one more decimal digit than t has, e.g. 25 → 24.9 /
 * 25.1), where the rule is not overridden and that comparison is pivotal: flipping its truth value
 * flips the rule's predicate. Sides with no such case (or outside the feature's bounds) are omitted.
 */
export async function findBoundaries(q: BoundaryQuery): Promise<BoundaryWitness[]> {
  const { schemaVersion, limit } = options(q, DEFAULT_LIMITS.boundary);
  const book = prepareRulebook(q.domain, q.rules);
  const rule = book.byId.get(q.ruleId);
  if (rule === undefined) throw new SolverInputError([`unknown rule "${q.ruleId}"`]);
  const atoms = uniqueBy(thresholdAtoms(rule.predicate, q.domain), (a) => `${a.feature}\u0000${a.threshold}`);
  if (atoms.length === 0) return [];
  const overriders = book.overriders.get(rule.id) ?? [];
  return withSolver(async (ctx, solver) => {
    const enc = new Encoding(ctx, q.domain, firingPredicates(book, [rule]));
    solver.add(...enc.constraints, ctx.Not(ctx.Or(...overriders.map((o) => enc.encode(o.predicate)))));
    const out: BoundaryWitness[] = [];
    for (const atom of atoms) {
      const feature = q.domain.features.find((f) => f.id === atom.feature);
      if (feature?.type !== "number") throw new Error(`threshold atom on non-number feature "${atom.feature}"`);
      const t = rationalOf(atom.threshold);
      const step = stepAt(feature, atom.threshold);
      const sides: [BoundaryWitness["side"], Rational][] = [
        ["below", add(t, { num: -step.num, den: step.den })],
        ["at", t],
        ["above", add(t, step)],
      ];
      for (const [side, value] of sides) {
        if (out.length >= limit) return out;
        const js = toNumber(value);
        if (js === undefined || js < feature.min || js > feature.max) continue;
        solver.push();
        solver.add(
          enc.numberEquals(atom.feature, value),
          ctx.Xor(enc.encode(rule.predicate, { path: atom.path, value: true }), enc.encode(rule.predicate, { path: atom.path, value: false })),
        );
        const assignment = await enc.solveCanonical(solver).finally(() => solver.pop());
        if (assignment === undefined) continue;
        const lookup = enc.verify(assignment);
        if (assignment[atom.feature] !== js || !isPivotal(rule.predicate, atom, lookup) || overriders.some((o) => holdsIn(o.predicate, lookup)))
          soundnessFailure("boundary", assignment);
        out.push(
          witness<BoundaryWitness>({
            kind: "boundary",
            decisionFamily: rule.decisionFamily,
            assignment,
            schemaVersion,
            ruleId: rule.id,
            feature: atom.feature,
            threshold: atom.threshold,
            side,
          }),
        );
      }
    }
    return out;
  });
}

/**
 * Valid cases where two rulebooks (two experts, plan §7.10) reach different effective decisions for
 * the family, `unresolved` included (reported as the action label "unresolved"). Only cases where
 * neither rulebook is in conflict count; conflicts are `findConflicts`' job. One witness per ordered
 * pair of differing decisions.
 */
export async function findDisagreements(q: DisagreementQuery): Promise<DisagreementWitness[]> {
  const { schemaVersion, limit } = options(q, DEFAULT_LIMITS.disagreement);
  const experts = q.experts;
  const bookA = prepareRulebook(q.domain, q.rulesA);
  const bookB = prepareRulebook(q.domain, q.rulesB);
  const family = decisionFamily(q.domain, q.family);
  const relevant = [bookA, bookB].flatMap((book) => firingPredicates(book, decisionRules(book, family).map((d) => d.rule)));
  return withSolver(async (ctx, solver) => {
    const enc = new Encoding(ctx, q.domain, relevant);
    const decided = (book: Rulebook): Map<string, Bool<"main">> => {
      const d = encodeFamilyDecision(ctx, (p) => enc.encode(p), book, family);
      return new Map([[UNRESOLVED_KEY, d.unresolved], ...[...d.decides].map(([key, v]) => [key, v.expr] as const)]);
    };
    const a = decided(bookA);
    const b = decided(bookB);
    const differing = [...a].flatMap(([ka, ea]) => [...b].filter(([kb]) => kb !== ka).map(([, eb]) => ctx.And(ea, eb)));
    solver.add(...enc.constraints, ctx.Or(...differing));
    const out: DisagreementWitness[] = [];
    while (out.length < limit) {
      const assignment = await enc.solveCanonical(solver);
      if (assignment === undefined) break;
      const lookup = enc.verify(assignment);
      const oa = outcomeOf(bookA, family, lookup);
      const ob = outcomeOf(bookB, family, lookup);
      const ea = oa && a.get(oa.key);
      const eb = ob && b.get(ob.key);
      if (oa === undefined || ob === undefined || oa.key === ob.key || ea === undefined || eb === undefined) soundnessFailure("disagreement", assignment);
      out.push(
        witness<DisagreementWitness>({
          kind: "disagreement",
          decisionFamily: family.id,
          assignment,
          schemaVersion,
          experts: [experts[0], experts[1]],
          actions: [oa.label, ob.label],
        }),
      );
      solver.add(ctx.Not(ctx.And(ea, eb)));
    }
    return out;
  });
}

/**
 * Unseen practice cases for the tutor (plan §7.7): boundary cases of the given rules (weakest first),
 * interleaved round-robin across rules, distinct assignments, at most `count`.
 */
export async function practiceCases(q: PracticeQuery): Promise<BoundaryWitness[]> {
  const count = parseLimit(q.count);
  const perRule: BoundaryWitness[][] = [];
  for (const ruleId of q.ruleIds)
    perRule.push(await findBoundaries({ domain: q.domain, rules: q.rules, ruleId, schemaVersion: q.schemaVersion, limit: MAX_LIMIT }));
  const out: BoundaryWitness[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < count && perRule.some((ws) => i < ws.length); i++)
    for (const ws of perRule) {
      const w = ws[i];
      if (w === undefined || out.length >= count) continue;
      const key = canonicalJson(w.assignment);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  return out;
}

/** Logical equivalence of two predicates over all valid cases (bench metric, plan §9), with a counterexample. */
export async function equivalent(q: { domain: DomainConfig; a: Predicate; b: Predicate }): Promise<EquivalenceResult> {
  const issues = (["a", "b"] as const).flatMap((k) => typecheckPredicate(q[k], q.domain.features).map((i) => `${k}${i.path}: ${i.message}`));
  if (issues.length > 0) throw new SolverInputError(issues);
  return withSolver(async (ctx, solver) => {
    const enc = new Encoding(ctx, q.domain, [q.a, q.b]);
    solver.add(...enc.constraints, ctx.Xor(enc.encode(q.a), enc.encode(q.b)));
    const counterexample = await enc.solveCanonical(solver);
    if (counterexample === undefined) return { equivalent: true };
    const lookup = enc.verify(counterexample);
    if (holdsIn(q.a, lookup) === holdsIn(q.b, lookup)) soundnessFailure("equivalence counterexample", counterexample);
    return { equivalent: false, counterexample };
  });
}

// ---------------------------------------------------------------------------------------------

const UNRESOLVED_KEY = "unresolved";

function outcomeOf(book: Rulebook, family: DecisionFamily, lookup: FeatureLookup): Outcome | undefined {
  const eff = effectiveDecision(book, family, lookup);
  if (eff.kind === "decided") return eff.outcome;
  return eff.kind === "unresolved" ? { key: UNRESOLVED_KEY, label: UNRESOLVED } : undefined;
}

async function withSolver<T>(run: (ctx: Context<"main">, solver: Solver<"main">) => Promise<T>): Promise<T> {
  const { ctx } = await getZ3();
  const solver = new ctx.Solver();
  try {
    return await run(ctx, solver);
  } finally {
    solver.release();
  }
}

function options(q: Common, defaultLimit: number): { schemaVersion: number; limit: number } {
  const version = SchemaVersionSchema.safeParse(q.schemaVersion);
  if (!version.success) throw new SolverInputError([`schemaVersion must be an integer >= 1, got ${String(q.schemaVersion)}`]);
  return { schemaVersion: version.data, limit: parseLimit(q.limit ?? defaultLimit) };
}

function parseLimit(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new SolverInputError([`limit/count must be an integer in [1, ${MAX_LIMIT}], got ${n}`]);
  return n;
}

function fired(map: ReadonlyMap<string, Bool<"main">>, id: string): Bool<"main"> {
  const e = map.get(id);
  if (e === undefined) throw new Error(`no encoding for rule "${id}"`);
  return e;
}

function holdsIn(p: Predicate, lookup: FeatureLookup): boolean {
  return evaluatePredicate(p, lookup).truth === true;
}

/** Re-check of pivotality with the evaluator: the predicate with the atom forced true differs from it forced false. */
function isPivotal(p: Predicate, atom: ThresholdAtom, lookup: FeatureLookup): boolean {
  return forcedTruth(p, atom.path, true, lookup) !== forcedTruth(p, atom.path, false, lookup);
}

function forcedTruth(p: Predicate, target: string, value: boolean, lookup: FeatureLookup, path = ""): boolean {
  if ("and" in p) return p.and.map((c, i) => forcedTruth(c, target, value, lookup, `${path}/and/${i}`)).every(Boolean);
  if ("or" in p) return p.or.map((c, i) => forcedTruth(c, target, value, lookup, `${path}/or/${i}`)).some(Boolean);
  if ("!" in p) return !forcedTruth(p["!"][0], target, value, lookup, `${path}/!/0`);
  const [key] = Object.keys(p);
  return `${path}/${key ?? ""}` === target ? value : holdsIn(p, lookup);
}

function uniqueLeaves(predicates: readonly Predicate[]): Predicate[] {
  return uniqueBy(
    predicates.flatMap((p) => leaves(p).map((l) => l.leaf)),
    canonicalJson,
  );
}

function uniqueBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function byId(a: SolverRule, b: SolverRule): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** JSON with object keys sorted, so equal values serialise equally. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

type WitnessBody<W extends Witness> = Omit<W, "id">;

/** Adds the deterministic id (hash of every field: kind, family, assignment and the kind's own fields) and validates. */
function witness<W extends Witness>(body: WitnessBody<W>): W {
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 24);
  const w = { ...body, id: `w_${body.kind}_${digest}` } as W;
  WitnessSchema.parse(w);
  return w;
}

function soundnessFailure(what: string, assignment: Assignment): never {
  throw new Error(`solver soundness check failed: ${what} witness ${JSON.stringify(assignment)} does not re-verify with the Kleene evaluator`);
}
