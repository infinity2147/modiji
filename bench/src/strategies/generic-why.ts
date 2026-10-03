import type { Strategy } from "./session";

/** (B) Generic why: after every observed decision, "why did you decide that?", until the budget runs out. */
export const genericWhy: Strategy = async (session) => {
  session.stream.forEach((_, i) => {
    const { caseId } = session.decide(i);
    if (session.canAsk) session.ask({ kind: "why", caseId }, { phase: "live", pause: i });
  });
};
