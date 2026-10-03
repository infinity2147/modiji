import type { Truth } from "../schemas/guardrail";

/** Strong Kleene conjunction: false dominates, then unknown. `and()` is true. */
export function and(...ts: Truth[]): Truth {
  let result: Truth = true;
  for (const t of ts) {
    if (t === false) return false;
    if (t === "unknown") result = "unknown";
  }
  return result;
}

/** Strong Kleene disjunction: true dominates, then unknown. `or()` is false. */
export function or(...ts: Truth[]): Truth {
  let result: Truth = false;
  for (const t of ts) {
    if (t === true) return true;
    if (t === "unknown") result = "unknown";
  }
  return result;
}

export function not(t: Truth): Truth {
  return t === "unknown" ? "unknown" : !t;
}
