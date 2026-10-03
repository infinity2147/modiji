/**
 * One rulebook, two consumers (plan §4 invention 4): for identical inputs the MCP tool (agents) and
 * `checkAction` as the tutor's Save interlock calls it (humans) give identical decisions.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { checkAction, type ActionId, type Feature, type GuardrailDecision, type Value } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { CHECK_ACTION_TOOL, CheckActionOutputSchema } from "../src";
import { DEMO_RULES } from "../demo/kyc-demo-rulebook";
import { connectClient, startGuardrailServer, tutorLookup, type Running } from "./support";

const RUNS = { seed: 20261004, numRuns: 300 };

function valueArb(f: Feature): fc.Arbitrary<Value> {
  switch (f.type) {
    case "boolean":
      return fc.boolean();
    case "string":
      return fc.string();
    case "enum":
      return fc.constantFrom(...f.values);
    case "number": {
      // Bias towards the rules' thresholds (24 months, 25 %) so boundaries are exercised.
      const any = f.integer ? fc.integer({ min: f.min, max: f.max }) : fc.double({ min: f.min, max: f.max, noNaN: true });
      return fc.oneof(any, fc.constantFrom(...[0, 1, 23, 24, 25, 26].filter((v) => v >= f.min && v <= f.max)));
    }
  }
}

/** A valid KYC assignment in which each feature is a value, null (unknown) or absent (unknown). */
const assignmentArb: fc.Arbitrary<Partial<Record<string, Value | null>>> = fc.record(
  Object.fromEntries(
    KYC_DOMAIN.features.map((f) => [f.id, fc.oneof({ weight: 8, arbitrary: valueArb(f) }, { weight: 1, arbitrary: fc.constant(null) })]),
  ),
  { requiredKeys: KYC_DOMAIN.features.filter((_, i) => i % 3 !== 0).map((f) => f.id) },
);

const actionArb = fc.oneof({ weight: 3, arbitrary: fc.constant("approve") }, { weight: 1, arbitrary: fc.constantFrom(...KYC_DOMAIN.actions.map((a) => a.id)) });

describe("MCP check_action ≡ tutor checkAction", () => {
  let running: Running;
  let client: Client;
  beforeAll(async () => {
    running = await startGuardrailServer();
    client = await connectClient(running.url);
  });
  afterAll(async () => {
    await client.close();
    await running.close();
  });

  it(`agrees on ${RUNS.numRuns} random valid KYC assignments`, async () => {
    const seen = new Set<GuardrailDecision>();
    await fc.assert(
      fc.asyncProperty(assignmentArb, actionArb, async (assignment, action) => {
        const result = await client.callTool({ name: CHECK_ACTION_TOOL, arguments: { context: { case: assignment }, proposedAction: action } });
        const { rulebookRevision: _r, explanation: _e, ...viaMcp } = CheckActionOutputSchema.parse(result.structuredContent);
        const viaTutor = checkAction({ rules: DEMO_RULES, features: tutorLookup(assignment), action: action as ActionId, domain: KYC_DOMAIN });
        expect(viaMcp).toEqual(viaTutor);
        seen.add(viaTutor.decision);
      }),
      RUNS,
    );
    // The sample must exercise every decision, or the agreement says little.
    expect([...seen].sort()).toEqual(["allow", "forbid", "insufficient_information", "needs_approval"]);
  });
});
