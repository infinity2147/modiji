// Positive control: browser code with no path to any oracle module.
export function decide(amount: number): string {
  return amount > 0 ? "review" : "reject";
}
