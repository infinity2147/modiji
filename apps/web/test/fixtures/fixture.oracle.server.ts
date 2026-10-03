import "server-only";

export const ORACLE_MARKER = "oracle:fixture:9e3019f4d3df24eddabea38ef7bba13d";

/** Stand-in for a domain HiddenPolicy: the canary rides along with the oracle logic. */
export const fixturePolicy = {
  marker: ORACLE_MARKER,
  evaluate(amount: number): "approve" | "escalate" {
    return amount > 10_000 ? "escalate" : "approve";
  },
};
