import type { Strategy } from "./session";

/** (A) Record-only: watches every decision, asks nothing. */
export const recordOnly: Strategy = async (session) => {
  session.stream.forEach((_, i) => session.decide(i));
};
