/**
 * Domain → Z3 encoding (plan §7.5).
 *
 * Variables, one per declared feature (string features only when a predicate in scope reads them):
 *   - number  → Int when `integer`, else Real; min ≤ x ≤ max. Literals are exact decimals (numbers.ts).
 *   - boolean → Bool.
 *   - enum    → Int index into `values`, 0 ≤ i < |values|. Chosen over a Z3 datatype because it needs
 *               no sort declarations in the shared context and decodes trivially; equality between two
 *               enum features maps through the value names, so different value orders stay correct.
 *   - string  → Int code into one finite universe shared by all string features: every string literal
 *               the predicates in scope compare a string feature with, plus one "other" value per
 *               string feature. Predicates only test (in)equality with literals and with each other, so
 *               any string outside the literals behaves like an "other" value, and one "other" per
 *               feature realises every equality pattern among them: the encoding is exact.
 * `domainConstraints` are always asserted (`constraints`).
 *
 * Witness values (`solveCanonical`). A Z3 model is turned into a canonical case by fixing each
 * feature, in domain order, to the first value of a fixed preference list that keeps the query
 * satisfiable: false before true, enum values in declared order, and for numbers ascending over
 * {min, max, and each threshold t that the predicates compare the feature with, t ± 1, and for real
 * features t ± one more decimal digit than t has}. The result depends only on the set of solutions,
 * not on Z3's search, so witnesses are deterministic and readable (integers and short decimals).
 * Between thresholds a feature can only be constrained by another feature (feature-to-feature
 * comparison); then the model's value is used, rounded to a short decimal when that stays satisfiable.
 */
import {
  AssignmentSchema,
  evaluatePredicate,
  featuresReferenced,
  isVarRef,
  predicateNode,
  type Assignment,
  type ComparisonOp,
  type DomainConfig,
  type Feature,
  type FeatureId,
  type FeatureLookup,
  type Operand,
  type Predicate,
  type Value,
} from "@vashistha/core";
import type { Arith, Bool, Context, Expr, Model, Solver } from "z3-solver";
import { add, compare, decimalPlaces, rationalOf, roundTo, toNumber, type Rational } from "./numbers";

type Z3Bool = Bool<"main">;
type Z3Arith = Arith<"main">;
type NumberFeature = Extract<Feature, { type: "number" }>;

export type FeatureVar =
  | { type: "boolean"; feature: Feature; expr: Z3Bool }
  | { type: "number"; feature: NumberFeature; expr: Z3Arith }
  | { type: "coded"; feature: Feature; values: readonly string[]; expr: Z3Arith };

/** A comparison of a number feature with a number literal, normalised to `feature op threshold`. */
export type ThresholdAtom = { path: string; feature: FeatureId; op: ComparisonOp; threshold: number };

/** A leaf (comparison or `in`) of a predicate, with its path (`/and/1/>` style, as the evaluator reports). */
export type Leaf = { path: string; leaf: Predicate };

/** Forces the leaf at `path` to a truth value while encoding (used for pivotality). */
export type Forced = { path: string; value: boolean };

type Candidate = { js: Value; expr: Expr<"main"> };

const FLIP: Record<ComparisonOp, ComparisonOp> = { "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

export function leaves(p: Predicate, path = ""): Leaf[] {
  const node = predicateNode(p);
  const at = `${path}/${node.key}`;
  switch (node.key) {
    case "and":
    case "or":
      return node.args.flatMap((c, i) => leaves(c, `${at}/${i}`));
    case "!":
      return leaves(node.args[0], `${at}/0`);
    default:
      return [{ path: at, leaf: p }];
  }
}

/** Threshold atoms of `p` over number features, in predicate order. */
export function thresholdAtoms(p: Predicate, domain: DomainConfig): ThresholdAtom[] {
  return leaves(p).flatMap(({ path, leaf }): ThresholdAtom[] => {
    const node = predicateNode(leaf);
    if (node.key === "in" || node.key === "and" || node.key === "or" || node.key === "!") return [];
    const [a, b] = node.args;
    const [v, lit, op] = isVarRef(a) ? [a, b, node.key] : [b, a, FLIP[node.key]];
    if (!isVarRef(v) || isVarRef(lit) || typeof lit !== "number") return [];
    const feature = domain.features.find((f) => f.id === v.var);
    return feature?.type === "number" ? [{ path, feature: feature.id, op, threshold: lit }] : [];
  });
}

/** The step used "just across" a threshold: 1 for integer features, else one more decimal digit than `t`. */
export function stepAt(feature: NumberFeature, t: number): Rational {
  return feature.integer ? { num: 1n, den: 1n } : { num: 1n, den: 10n ** BigInt(decimalPlaces(t) + 1) };
}

export class Encoding {
  readonly vars: readonly FeatureVar[];
  readonly constraints: readonly Z3Bool[];
  private readonly ctx: Context<"main">;
  private readonly domain: DomainConfig;
  private readonly byId: ReadonlyMap<FeatureId, FeatureVar>;
  private readonly thresholds: ReadonlyMap<FeatureId, readonly number[]>;

  /** `predicates`: everything the query will encode besides the domain constraints. */
  constructor(ctx: Context<"main">, domain: DomainConfig, predicates: readonly Predicate[]) {
    this.ctx = ctx;
    this.domain = domain;
    const scope = [...domain.domainConstraints, ...predicates];
    const referenced = new Set<FeatureId>(scope.flatMap(featuresReferenced));
    const strings = domain.features.filter((f) => f.type === "string" && referenced.has(f.id));
    const universe = stringUniverse(scope, new Set(strings.map((f) => f.id)), strings.length);

    const vars: FeatureVar[] = [];
    for (const feature of domain.features) {
      const name = `${domain.id}.${feature.id}`;
      if (feature.type === "boolean") vars.push({ type: "boolean", feature, expr: ctx.Bool.const(name) });
      else if (feature.type === "number")
        vars.push({ type: "number", feature, expr: feature.integer ? ctx.Int.const(name) : ctx.Real.const(name) });
      else if (feature.type === "enum") vars.push({ type: "coded", feature, values: feature.values, expr: ctx.Int.const(name) });
      else if (referenced.has(feature.id)) vars.push({ type: "coded", feature, values: universe, expr: ctx.Int.const(name) });
    }
    this.vars = vars;
    this.byId = new Map(vars.map((v) => [v.feature.id, v]));

    const thresholds = new Map<FeatureId, number[]>();
    for (const p of scope) {
      for (const atom of thresholdAtoms(p, domain)) thresholds.set(atom.feature, [...(thresholds.get(atom.feature) ?? []), atom.threshold]);
      for (const { leaf } of leaves(p)) {
        const node = predicateNode(leaf);
        if (node.key !== "in" || !isVarRef(node.args[0])) continue;
        const id = node.args[0].var;
        const numbers = node.args[1].filter((x): x is number => typeof x === "number");
        thresholds.set(id, [...(thresholds.get(id) ?? []), ...numbers]);
      }
    }
    this.thresholds = thresholds;

    const bounds = vars.flatMap((v): Z3Bool[] => {
      if (v.type === "boolean") return [];
      if (v.type === "coded") return [v.expr.ge(0), v.expr.lt(v.values.length)];
      return [v.expr.ge(this.numeral(v, rationalOf(v.feature.min))), v.expr.le(this.numeral(v, rationalOf(v.feature.max)))];
    });
    this.constraints = [...bounds, ...domain.domainConstraints.map((c) => this.encode(c))];
  }

  /** Z3 formula for `p`; the leaf at `forced.path` (if given) is replaced by a constant. */
  encode(p: Predicate, forced?: Forced, path = ""): Z3Bool {
    const ctx = this.ctx;
    const node = predicateNode(p);
    const at = `${path}/${node.key}`;
    switch (node.key) {
      case "and":
        return ctx.And(...node.args.map((c, i) => this.encode(c, forced, `${at}/${i}`)));
      case "or":
        return ctx.Or(...node.args.map((c, i) => this.encode(c, forced, `${at}/${i}`)));
      case "!":
        return ctx.Not(this.encode(node.args[0], forced, `${at}/0`));
      case "in": {
        if (forced?.path === at) return ctx.Bool.val(forced.value);
        const [operand, list] = node.args;
        return ctx.Or(...list.map((item) => this.comparison("==", operand, item)));
      }
      default:
        if (forced?.path === at) return ctx.Bool.val(forced.value);
        return this.comparison(node.key, node.args[0], node.args[1]);
    }
  }

  /** Fixes `feature` to a number (exactly). */
  numberEquals(feature: FeatureId, value: Rational): Z3Bool {
    const v = this.var(feature);
    if (v.type !== "number") throw new Error(`feature "${feature}" is not a number`);
    return v.expr.eq(this.numeral(v, value));
  }

  /**
   * Solves and returns a canonical assignment (see the module comment), or `undefined` when unsat.
   * Leaves the solver's assertions unchanged. Throws if Z3 answers `unknown`.
   */
  async solveCanonical(solver: Solver<"main">): Promise<Assignment | undefined> {
    const first = await solver.check();
    if (first === "unsat") return undefined;
    if (first !== "sat") throw new Error(`Z3 returned "${first}"`);
    let model = solver.model();
    const values: Record<string, Value> = {};
    solver.push();
    try {
      for (const v of this.vars) {
        let chosen: Candidate | undefined;
        for (const c of this.candidates(v)) {
          const eq = v.expr.eq(c.expr);
          if (this.ctx.isTrue(model.eval(eq, true))) chosen = c;
          else if ((await solver.check(eq)) === "sat") {
            model = solver.model();
            chosen = c;
          }
          if (chosen !== undefined) break;
        }
        chosen ??= await this.fromModel(solver, model, v);
        solver.add(v.expr.eq(chosen.expr));
        values[v.feature.id] = chosen.js;
      }
    } finally {
      solver.pop();
    }
    return AssignmentSchema.parse(values);
  }

  /** A lookup over a complete assignment of the declared features; reading anything else throws. */
  lookup(assignment: Assignment): FeatureLookup {
    return (id) => {
      const value = Object.hasOwn(assignment, id) ? assignment[id] : undefined;
      if (value === undefined) throw new Error(`witness has no value for feature "${id}"`);
      return value;
    };
  }

  /**
   * Soundness re-check of a decoded witness with the Kleene evaluator: every declared feature has a
   * value of its type within bounds, and every domain constraint is true. Throws on violation (a bug).
   */
  verify(assignment: Assignment): FeatureLookup {
    const problems: string[] = [];
    for (const v of this.vars) {
      const value = assignment[v.feature.id];
      if (v.type === "boolean" && typeof value !== "boolean") problems.push(`${v.feature.id} = ${String(value)} is not a boolean`);
      if (v.type === "coded" && (typeof value !== "string" || (v.feature.type === "enum" && !v.values.includes(value))))
        problems.push(`${v.feature.id} = ${String(value)} is not a value of the feature`);
      if (v.type === "number") {
        const f = v.feature;
        if (typeof value !== "number" || value < f.min || value > f.max || (f.integer && !Number.isInteger(value)))
          problems.push(`${f.id} = ${String(value)} is outside its typed domain`);
      }
    }
    const lookup = this.lookup(assignment);
    if (problems.length === 0)
      this.domain.domainConstraints.forEach((c, i) => {
        if (evaluatePredicate(c, lookup).truth !== true) problems.push(`domain constraint ${i} does not hold`);
      });
    if (problems.length > 0)
      throw new Error(`solver soundness check failed for ${JSON.stringify(assignment)}:\n  ${problems.join("\n  ")}`);
    return lookup;
  }

  /** "The assignment lies in a different cell": some leaf has a different truth value than under `lookup`. */
  blockCell(cellLeaves: readonly Predicate[], lookup: FeatureLookup): Z3Bool {
    return this.ctx.Not(
      this.ctx.And(...cellLeaves.map((leaf) => (evaluatePredicate(leaf, lookup).truth === true ? this.encode(leaf) : this.ctx.Not(this.encode(leaf))))),
    );
  }

  private var(id: FeatureId): FeatureVar {
    const v = this.byId.get(id);
    if (v === undefined) throw new Error(`feature "${id}" is not declared in this encoding`);
    return v;
  }

  private numeral(v: Extract<FeatureVar, { type: "number" }>, r: Rational): Z3Arith {
    return v.feature.integer ? this.ctx.Int.val(r.num / r.den) : this.ctx.Real.val({ numerator: r.num, denominator: r.den });
  }

  private comparison(op: ComparisonOp, a: Operand, b: Operand): Z3Bool {
    const ctx = this.ctx;
    if (!isVarRef(a)) {
      if (!isVarRef(b)) throw new Error(`"${op}" between two literals`);
      return this.comparison(FLIP[op], b, a);
    }
    const left = this.var(a.var);
    const eq = (e: Z3Bool): Z3Bool => {
      if (op === "==") return e;
      if (op === "!=") return ctx.Not(e);
      throw new Error(`"${op}" on ${left.type} feature "${left.feature.id}"`);
    };
    if (left.type === "boolean") {
      if (isVarRef(b)) {
        const right = this.var(b.var);
        if (right.type !== "boolean") throw new Error(`cannot compare "${a.var}" with "${b.var}"`);
        return eq(left.expr.eq(right.expr));
      }
      if (typeof b !== "boolean") throw new Error(`"${a.var}" compared with a ${typeof b}`);
      return eq(left.expr.eq(ctx.Bool.val(b)));
    }
    if (left.type === "coded") {
      if (isVarRef(b)) {
        const right = this.var(b.var);
        if (right.type !== "coded") throw new Error(`cannot compare "${a.var}" with "${b.var}"`);
        if (left.values.join("\u0000") === right.values.join("\u0000")) return eq(left.expr.eq(right.expr));
        const same = left.values.flatMap((value, i) => {
          const j = right.values.indexOf(value);
          return j < 0 ? [] : [ctx.And(left.expr.eq(i), right.expr.eq(j))];
        });
        return eq(ctx.Or(...same));
      }
      const code = typeof b === "string" ? left.values.indexOf(b) : -1;
      if (code < 0) throw new Error(`"${String(b)}" is not a value of "${a.var}"`);
      return eq(left.expr.eq(code));
    }
    let l: Z3Arith = left.expr;
    let r: Z3Arith;
    if (isVarRef(b)) {
      const right = this.var(b.var);
      if (right.type !== "number") throw new Error(`cannot compare "${a.var}" with "${b.var}"`);
      r = right.expr;
      if (left.feature.integer !== right.feature.integer) {
        if (left.feature.integer) l = ctx.ToReal(l);
        else r = ctx.ToReal(r);
      }
    } else {
      if (typeof b !== "number") throw new Error(`"${a.var}" compared with a ${typeof b}`);
      r = this.numeral(left, rationalOf(b));
    }
    switch (op) {
      case "==":
        return l.eq(r);
      case "!=":
        return ctx.Not(l.eq(r));
      case "<":
        return l.lt(r);
      case "<=":
        return l.le(r);
      case ">":
        return l.gt(r);
      case ">=":
        return l.ge(r);
    }
  }

  private candidates(v: FeatureVar): Candidate[] {
    const ctx = this.ctx;
    if (v.type === "boolean") return [false, true].map((b) => ({ js: b, expr: ctx.Bool.val(b) }));
    if (v.type === "coded") return v.values.map((value, i) => ({ js: value, expr: ctx.Int.val(i) }));
    const f = v.feature;
    const min = rationalOf(f.min);
    const max = rationalOf(f.max);
    const points: Rational[] = [min, max];
    for (const t of this.thresholds.get(f.id) ?? []) {
      const r = rationalOf(t);
      const one = { num: 1n, den: 1n };
      const step = stepAt(f, t);
      const minus = (d: Rational): Rational => add(r, { num: -d.num, den: d.den });
      points.push(r, add(r, one), minus(one), add(r, step), minus(step));
    }
    const inRange = points.filter((p) => compare(p, min) >= 0 && compare(p, max) <= 0).sort(compare);
    const unique = inRange.filter((p, i) => i === 0 || compare(p, inRange[i - 1] ?? p) !== 0);
    return unique.map((p) => this.numberCandidate(v, p));
  }

  private numberCandidate(v: Extract<FeatureVar, { type: "number" }>, r: Rational): Candidate {
    const js = toNumber(r);
    if (js === undefined) throw new Error(`no decimal value for ${r.num}/${r.den}`);
    return { js, expr: this.numeral(v, r) };
  }

  /** Fallback when no preferred value fits: the model's value, rounded to a short decimal when possible. */
  private async fromModel(solver: Solver<"main">, model: Model<"main">, v: FeatureVar): Promise<Candidate> {
    const ctx = this.ctx;
    const value = model.eval(v.expr, true);
    if (v.type !== "number") throw new Error(`no preferred value fits ${v.type} feature "${v.feature.id}"`);
    if (ctx.isIntVal(value)) return this.numberCandidate(v, { num: value.value(), den: 1n });
    if (!ctx.isRealVal(value)) throw new Error(`Z3 gave no numeral for "${v.feature.id}"`);
    const { numerator, denominator } = value.value();
    const exact = { num: numerator, den: denominator };
    for (const places of [0, 1, 2, 3, 6, 9]) {
      const rounded = roundTo(exact, places);
      if (compare(rounded, exact) === 0 || (await solver.check(v.expr.eq(this.numeral(v, rounded)))) === "sat")
        return this.numberCandidate(v, rounded);
    }
    return this.numberCandidate(v, exact);
  }
}

/** Sorted string literals compared with string features, plus `others` fresh "other" values. */
function stringUniverse(scope: readonly Predicate[], stringFeatures: ReadonlySet<FeatureId>, others: number): string[] {
  if (others === 0) return [];
  const literals = new Set<string>();
  const isString = (o: Operand): boolean => isVarRef(o) && stringFeatures.has(o.var);
  for (const p of scope)
    for (const { leaf } of leaves(p)) {
      const node = predicateNode(leaf);
      if (node.key === "and" || node.key === "or" || node.key === "!") continue;
      if (node.key === "in") {
        if (isString(node.args[0])) for (const v of node.args[1]) if (typeof v === "string") literals.add(v);
        continue;
      }
      const [a, b] = node.args;
      if (isString(a) && typeof b === "string") literals.add(b);
      if (isString(b) && typeof a === "string") literals.add(a);
    }
  const sorted = [...literals].sort();
  const fresh: string[] = [];
  for (let i = 1; fresh.length < others; i++) if (!literals.has(`other${i}`)) fresh.push(`other${i}`);
  return [...sorted, ...fresh];
}
