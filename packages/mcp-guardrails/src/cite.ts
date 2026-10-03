import type { ConfirmedRule } from "@vashistha/core";

/** `m:ss.t` (tenths of a second), e.g. 2:12.4. */
export function formatClock(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`;
}

/** `rule <id>: "<exact quote>" (expert <id>, <t0>–<t1>)`, from the rule's leading supporting quote. */
export function citeRule(rule: ConfirmedRule): string {
  const quote = rule.evidence[0];
  return `rule ${rule.id}: "${quote.exactQuote}" (expert ${rule.expertId}, ${formatClock(quote.t0Ms)}–${formatClock(quote.t1Ms)})`;
}
