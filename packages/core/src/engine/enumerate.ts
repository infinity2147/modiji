import type { DomainConfig, Feature } from "../schemas/domain";
import { evaluatePredicate } from "../logic/evaluate";
import { predicateNode } from "../logic/node";
import { typecheckPredicate } from "../logic/typecheck";
import { isVarRef, type ComparisonOp, type Predicate, type VarRef } from "../schemas/predicate";
import type { ActionId, FeatureId, Value } from "../schemas/primitives";
import type { CandidateRule } from "../schemas/rules";
import { canonicalJson, contentId } from "./canonical";
import type { EngineConfig } from "./config";
import { findFeature } from "./describe";
import { actionIndex, recordLookup, type FamilyModel, type Observation } from "./model";
import { isMeaningfulRound, meaningfulRoundsIn, tidy, type NumberFeature } from "./numbers";

/** A candidate before it is weighted into a hypothesis set. */
export type CandidateSeed = Omit<CandidateRule, "weight" | "hypothesisSetId">;

/** Deterministic id: the same (family, predicate, action) always gets the same id, across rebuilds. */
export function candidateId(familyId: string, predicate: Predicate, action: ActionId): string {
  return contentId("cand", canonicalJson({ familyId, predicate, action }));
}

/**
 * Description length of a predicate: one per condition, plus one per numeric threshold that is not
 * a domain-meaningful round number (27.5 % costs more than 25 %).
 */
export function predicateComplexity(p: Predicate, domain: DomainConfig): number {
  const node = predicateNode(p);
  switch (node.key) {
    case "and":
    case "or":
    case "!":
      return node.args.reduce((s: number, c) => s + predicateComplexity(c, domain), 0);
    case "in":
      return 1;
    default: {
      const [l, r] = node.args;
      const feature = isVarRef(l) ? findFeature(domain, l.var) : isVarRef(r) ? findFeature(domain, r.var) : undefined;
      const literal = isVarRef(l) ? r : l;
      const roundPenalty =
        feature?.type === "number" && typeof literal === "number" && !isMeaningfulRound(feature, literal) ? 1 : 0;
      return 1 + roundPenalty;
    }
  }
}

type Atom = { featureIndex: number; predicate: Predicate; complexity: number };

/**
 * Candidate hypotheses "if p then a else default" for one decision family (plan §7.3 A).
 *
 * Conditions (atoms), in domain feature order:
 *   - boolean: f == true, f == false;
 *   - enum: f == v for every declared value, f != v when the enum has more than two values (for two
 *     values, != is the other ==);
 *   - string: f == v, f != v for every observed value;
 *   - number: f > t, f >= t, f < t, f <= t for t in the observed decision boundaries: between
 *     adjacent observed values whose actions differ, the midpoint plus up to
 *     `roundThresholdsPerBoundary` domain-meaningful round numbers in [lo, hi] (numbers.ts).
 * Atoms are deduplicated by the set of values they accept (cheap and exact: `== false` ≡ `!= true`,
 * `x > 24` ≡ `x >= 25` for integers; the first, rounder form is kept) and atoms true or false on the
 * whole feature range are dropped.
 *
 * Candidates: every atom × every non-default family action; conjunctions of 2 (3 with
 * `maxConditions: 3`) atoms on distinct features, for actions observed in the family, kept only
 * when they cover at least one observation of their action and every conjunct earns its place on
 * the observed data (dropping it strictly enlarges the set of observations the rule fires on).
 * Without that filter a conjunction with any condition that happens to hold on every case so far
 * ("entity is a company") would duplicate each single condition and swamp the prior by sheer count;
 * conjunctions appear as soon as the data (or an answered counterfactual) demands them.
 *
 * Bounded: the `maxCandidates` simplest are kept (complexity, then generation order). Every
 * candidate type-checks against the domain. Pure and deterministic.
 */
export function enumerateCandidates(model: FamilyModel, observations: readonly Observation[], config: EngineConfig): CandidateSeed[] {
  for (const o of observations) actionIndex(model, o.action);
  const { domain, family, defaultAction } = model;
  const atoms = enumerateAtoms(domain, observations, config);
  const ruleActions = family.actions.filter((a) => a !== defaultAction);
  const seeds: CandidateSeed[] = [];
  const seen = new Set<string>();
  const push = (predicate: Predicate, action: ActionId, complexity: number): void => {
    const id = candidateId(family.id, predicate, action);
    if (seen.has(id)) return;
    seen.add(id);
    seeds.push({ id, predicate, predictedAction: action, complexity, origin: "enumerated" });
  };

  for (const atom of atoms) for (const a of ruleActions) push(atom.predicate, a, atom.complexity);

  const lookups = observations.map((o) => recordLookup(o.features));
  const coverage = (p: Predicate): bigint =>
    lookups.reduce((mask, lookup, i) => (evaluatePredicate(p, lookup).truth === true ? mask | (1n << BigInt(i)) : mask), 0n);
  const positives = new Map<ActionId, bigint>();
  observations.forEach((o, i) => {
    if (o.action !== defaultAction) positives.set(o.action, (positives.get(o.action) ?? 0n) | (1n << BigInt(i)));
  });
  const anyPositive = [...positives.values()].reduce((m, x) => m | x, 0n);
  const covering = atoms.map((atom) => ({ atom, mask: coverage(atom.predicate) })).filter((x) => (x.mask & anyPositive) !== 0n);

  const emit = (parts: readonly { atom: Atom; mask: bigint }[]): void => {
    const mask = parts.reduce((m, x) => m & x.mask, ~0n);
    // Every conjunct must narrow coverage: the conjunction without part k fires on strictly more observations.
    for (let k = 0; k < parts.length; k++) {
      const without = parts.reduce((m, x, i) => (i === k ? m : m & x.mask), ~0n);
      if (without === mask) return;
    }
    const predicate: Predicate = { and: parts.map((x) => x.atom.predicate) as [Predicate, ...Predicate[]] };
    const complexity = parts.reduce((s, x) => s + x.atom.complexity, 0);
    for (const [a, pos] of positives) if ((mask & pos) !== 0n) push(predicate, a, complexity);
  };

  for (let i = 0; i < covering.length; i++) {
    const x = covering[i];
    if (x === undefined) continue;
    for (let j = i + 1; j < covering.length; j++) {
      const y = covering[j];
      if (y === undefined || y.atom.featureIndex === x.atom.featureIndex) continue;
      emit([x, y]);
      if (config.maxConditions < 3) continue;
      for (let k = j + 1; k < covering.length; k++) {
        const z = covering[k];
        if (z === undefined || z.atom.featureIndex === y.atom.featureIndex || z.atom.featureIndex === x.atom.featureIndex) continue;
        emit([x, y, z]);
      }
    }
  }

  return seeds
    .map((s, order) => ({ s, order }))
    .sort((p, q) => p.s.complexity - q.s.complexity || p.order - q.order)
    .slice(0, config.maxCandidates)
    .map(({ s }) => s);
}

function enumerateAtoms(domain: DomainConfig, observations: readonly Observation[], config: EngineConfig): Atom[] {
  const atoms: Atom[] = [];
  const keys = new Set<string>();
  domain.features.forEach((f, featureIndex) => {
    for (const { op, value, key } of featureConditions(f, observations, config)) {
      if (key === undefined || keys.has(key)) continue;
      const predicate = comparison(op, f.id, value);
      if (typecheckPredicate(predicate, domain.features).length > 0) continue;
      keys.add(key);
      atoms.push({ featureIndex, predicate, complexity: predicateComplexity(predicate, domain) });
    }
  });
  return atoms;
}

/** `{op: [{var: feature}, value]}`. */
export function comparison(op: ComparisonOp, feature: FeatureId, value: Value): Predicate {
  const args: [VarRef, Value] = [{ var: feature }, value];
  switch (op) {
    case "==":
      return { "==": args };
    case "!=":
      return { "!=": args };
    case "<":
      return { "<": args };
    case "<=":
      return { "<=": args };
    case ">":
      return { ">": args };
    case ">=":
      return { ">=": args };
  }
}

/** `key` is the canonical accepted-value set; undefined for a condition that is constant on the feature's range. */
type Condition = { op: ComparisonOp; value: Value; key: string | undefined };

function featureConditions(f: Feature, observations: readonly Observation[], config: EngineConfig): Condition[] {
  switch (f.type) {
    case "boolean":
      return [true, false].map((v) => ({ op: "==", value: v, key: `${f.id}∈{${v}}` }));
    case "enum": {
      const set = (vs: readonly string[]): string | undefined =>
        vs.length === 0 || vs.length === f.values.length ? undefined : `${f.id}∈{${[...vs].sort().join(",")}}`;
      const eq = f.values.map((v): Condition => ({ op: "==", value: v, key: set([v]) }));
      const ne = f.values.length > 2 ? f.values.map((v): Condition => ({ op: "!=", value: v, key: set(f.values.filter((w) => w !== v)) })) : [];
      return [...eq, ...ne];
    }
    case "string": {
      const seen = [...new Set(observations.flatMap((o) => (typeof o.features[f.id] === "string" ? [o.features[f.id] as string] : [])))].sort();
      return seen.flatMap((v): Condition[] => [
        { op: "==", value: v, key: `${f.id}==${JSON.stringify(v)}` },
        { op: "!=", value: v, key: `${f.id}!=${JSON.stringify(v)}` },
      ]);
    }
    case "number":
      return boundaryThresholds(f, observations, config).flatMap((t) =>
        (["<", "<=", ">", ">="] as const).map((op): Condition => ({ op, value: t, key: numericKey(f, op, t) })),
      );
  }
}

/** Thresholds at the observed decision boundaries of a numeric feature: round numbers first, then midpoints. */
function boundaryThresholds(f: NumberFeature, observations: readonly Observation[], config: EngineConfig): number[] {
  const byValue = new Map<number, Set<ActionId>>();
  for (const o of observations) {
    const v = o.features[f.id];
    if (typeof v !== "number") continue;
    const actions = byValue.get(v) ?? new Set<ActionId>();
    actions.add(o.action);
    byValue.set(v, actions);
  }
  const values = [...byValue.keys()].sort((a, b) => a - b);
  const round: number[] = [];
  const mids: number[] = [];
  for (let i = 0; i + 1 < values.length; i++) {
    const lo = values[i] as number;
    const hi = values[i + 1] as number;
    const a = byValue.get(lo) ?? new Set();
    const b = byValue.get(hi) ?? new Set();
    const same = a.size === 1 && b.size === 1 && [...a][0] === [...b][0];
    if (same) continue;
    round.push(...meaningfulRoundsIn(f, lo, hi, config.roundThresholdsPerBoundary));
    const mid = tidy((lo + hi) / 2);
    mids.push(f.integer ? Math.floor(mid) : mid);
  }
  return [...new Set([...round, ...mids])];
}

/** Canonical accepted interval of `x op t` on the feature's range (integers normalised to >= / <=). */
function numericKey(f: NumberFeature, op: ComparisonOp, t: number): string | undefined {
  let lower: number | undefined;
  let upper: number | undefined;
  let lowerOpen = false;
  let upperOpen = false;
  if (op === ">" || op === ">=") {
    lower = f.integer ? (op === ">" ? Math.floor(t) + 1 : Math.ceil(t)) : t;
    lowerOpen = !f.integer && op === ">";
  } else {
    upper = f.integer ? (op === "<" ? Math.ceil(t) - 1 : Math.floor(t)) : t;
    upperOpen = !f.integer && op === "<";
  }
  const lo = lower ?? f.min;
  const hi = upper ?? f.max;
  const empty = lo > hi || (lo === hi && (lowerOpen || upperOpen));
  const full = (lower === undefined || lower < f.min || (lower === f.min && !lowerOpen)) && (upper === undefined || upper > f.max || (upper === f.max && !upperOpen));
  if (empty || full) return undefined;
  return `${f.id}∈${lowerOpen ? "(" : "["}${lo},${hi}${upperOpen ? ")" : "]"}`;
}
