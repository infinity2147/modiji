/**
 * Exact rationals for Z3 numerals. A JS number enters Z3 as the exact value of its shortest decimal
 * representation (`25.1` is 251/10, not the nearest double's binary expansion). That map is
 * strictly monotone on doubles, so every comparison between doubles (what the Kleene evaluator does)
 * has the same truth value between their Z3 images; the solver's answers are therefore exact for
 * double-valued cases, and witness values are chosen as short decimals so they map back losslessly.
 */
export type Rational = { num: bigint; den: bigint };

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

export function rationalOf(n: number): Rational {
  const m = DECIMAL.exec(String(n));
  if (m === null) throw new RangeError(`not a finite number: ${n}`);
  const frac = m[3] ?? "";
  const exp = Number(m[4] ?? "0") - frac.length;
  const num = BigInt(`${m[1] ?? ""}${m[2] ?? ""}${frac}`);
  return exp >= 0 ? { num: num * 10n ** BigInt(exp), den: 1n } : { num, den: 10n ** BigInt(-exp) };
}

/** Digits after the decimal point in the shortest representation of `n`. */
export function decimalPlaces(n: number): number {
  return rationalOf(n).den.toString().length - 1;
}

/** `n` rounded half-up to `places` decimals, exactly. */
export function roundTo(r: Rational, places: number): Rational {
  const den = 10n ** BigInt(places);
  const scaled = r.num * den * 2n + r.den;
  const twice = r.den * 2n;
  const q = scaled >= 0n ? scaled / twice : -((-scaled + twice - 1n) / twice);
  return { num: q, den };
}

export function add(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den + b.num * a.den, den: a.den * b.den };
}

export function compare(a: Rational, b: Rational): number {
  const d = a.num * b.den - b.num * a.den;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/**
 * The JS number for a rational whose denominator divides a power of ten (a terminating decimal), or
 * `undefined`. Parsing the exact decimal string gives the nearest double, the inverse of `rationalOf`.
 */
export function toNumber(r: Rational): number | undefined {
  for (let places = 0; places <= 40; places++) {
    const scaled = r.num * 10n ** BigInt(places);
    if (scaled % r.den !== 0n) continue;
    const q = scaled / r.den;
    if (places === 0) return Number(q);
    const digits = (q < 0n ? -q : q).toString().padStart(places + 1, "0");
    return Number(`${q < 0n ? "-" : ""}${digits.slice(0, -places)}.${digits.slice(-places)}`);
  }
  return undefined;
}
