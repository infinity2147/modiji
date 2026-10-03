// Negative control: browser code that (wrongly) imports the server-only oracle.
import { fixturePolicy } from "./fixture.oracle.server";

export function decide(amount: number): string {
  return fixturePolicy.evaluate(amount);
}
