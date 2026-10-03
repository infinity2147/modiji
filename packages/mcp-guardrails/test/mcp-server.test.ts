import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Value } from "@vashistha/core";
import { CHECK_ACTION_TOOL, CheckActionOutputSchema, type CheckActionOutput } from "../src";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "../demo/kyc-demo-rulebook";
import { CLEAN_CASE, connectClient, kycCaseFeatures, startGuardrailServer, type Running } from "./support";

const quoteOf = (id: string): string => {
  const rule = DEMO_RULES.find((r) => r.id === id);
  if (rule === undefined) throw new Error(id);
  return rule.evidence[0].exactQuote;
};

type ToolText = { type: "text"; text: string };

describe("check_action over Streamable HTTP", () => {
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

  async function check(caseValues: Record<string, Value | null>, proposedAction = "approve"): Promise<CheckActionOutput> {
    const result = await client.callTool({ name: CHECK_ACTION_TOOL, arguments: { context: { case: caseValues }, proposedAction } });
    expect(result.isError).toBeFalsy();
    const output = CheckActionOutputSchema.parse(result.structuredContent);
    expect(result.content).toEqual([
      { type: "text", text: output.explanation },
      { type: "text", text: JSON.stringify(output) },
    ]);
    return output;
  }

  async function toolError(args: unknown): Promise<string> {
    const result = await client.callTool({ name: CHECK_ACTION_TOOL, arguments: args as Record<string, unknown> });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    return (result.content as ToolText[]).map((c) => c.text).join("\n");
  }

  it("lists exactly one tool, check_action, with typed input and output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([CHECK_ACTION_TOOL]);
    const [tool] = tools;
    expect(tool?.description).toContain("before committing any review outcome");
    expect(tool?.inputSchema.required).toEqual(["context", "proposedAction"]);
    expect(JSON.stringify(tool?.inputSchema)).toContain('"enum":["approve","enhancedReview"');
    expect(JSON.stringify(tool?.inputSchema)).toContain("jurisdictionRisk (Country risk (Northstar list)): one of low, medium, high");
    expect(tool?.outputSchema?.required).toEqual(
      expect.arrayContaining(["decision", "matchedRules", "missingFeatures", "evidence", "rulebookRevision", "explanation"]),
    );
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("forbids approving the unseen held-out case and quotes the expert", async () => {
    const out = await check(kycCaseFeatures("NS-2026-0201"));
    expect(out.decision).toBe("forbid");
    expect(out.matchedRules).toEqual(["R-high-risk-country"]);
    expect(out.missingFeatures).toEqual([]);
    expect(out.rulebookRevision).toBe(DEMO_RULEBOOK_REVISION);
    expect(out.evidence.map((e) => e.exactQuote)).toEqual([quoteOf("R-high-risk-country")]);
    expect(out.explanation).toBe(
      `Blocked by rule R-high-risk-country: "${quoteOf("R-high-risk-country")}" (expert expert-demo, 2:12.4–2:19.1). ` +
        `Do not take "approve" (Approve onboarding) on this case.`,
    );
  });

  it("forbids on several rules at once, in rule-id order", async () => {
    const out = await check(kycCaseFeatures("NS-2026-0202"));
    expect(out.decision).toBe("forbid");
    expect(out.matchedRules).toEqual(["R-sanctions"]);
    const both = await check({ ...CLEAN_CASE, sanctionsHit: true, jurisdictionRisk: "high" });
    expect(both.matchedRules).toEqual(["R-high-risk-country", "R-sanctions"]);
    expect(both.explanation.indexOf("R-high-risk-country")).toBeLessThan(both.explanation.indexOf("R-sanctions"));
  });

  it("lets a true exception lift the high-risk-country guardrail", async () => {
    const out = await check({ ...CLEAN_CASE, jurisdictionRisk: "high", customerStatus: "existing", accountAgeMonths: 36 });
    expect(out.decision).toBe("allow");
  });

  it("returns needs_approval with the approver role", async () => {
    const out = await check({ ...CLEAN_CASE, pep: true });
    expect(out.decision).toBe("needs_approval");
    expect(out.matchedRules).toEqual(["R-pep-approval"]);
    expect(out.explanation).toContain("Needs approval from a compliance officer under rule R-pep-approval");
    expect(out.explanation).toContain(quoteOf("R-pep-approval"));
  });

  it("returns insufficient_information for a null feature and names it", async () => {
    const out = await check({ ...CLEAN_CASE, sanctionsHit: null });
    expect(out).toMatchObject({ decision: "insufficient_information", matchedRules: ["R-sanctions"], missingFeatures: ["sanctionsHit"] });
    expect(out.explanation).toContain("these case features are unknown: sanctionsHit (Sanctions screening match)");
  });

  it("treats a feature left out as unknown", async () => {
    const { sanctionsHit: _omitted, ...rest } = CLEAN_CASE;
    const out = await check(rest);
    expect(out.decision).toBe("insufficient_information");
    expect(out.missingFeatures).toEqual(["sanctionsHit"]);
  });

  it("allows a clean case", async () => {
    const out = await check(CLEAN_CASE);
    expect(out).toMatchObject({ decision: "allow", matchedRules: [], missingFeatures: [], evidence: [] });
    expect(out.explanation).toBe(
      `Allowed: no confirmed rule (rulebook revision ${DEMO_RULEBOOK_REVISION}) forbids "approve" (Approve onboarding) or requires approval for it on this case.`,
    );
  });

  it("rejects unknown features and invalid values with a tool error naming each problem", async () => {
    const text = await toolError({
      context: { case: { ...CLEAN_CASE, favouriteColour: "red", jurisdictionRisk: "extreme", accountAgeMonths: 9000, pep: "no" } },
      proposedAction: "approve",
    });
    expect(text).toContain('unknown feature "favouriteColour"');
    expect(text).toContain('feature "jurisdictionRisk": value is not one of low, medium, high');
    expect(text).toContain('feature "accountAgeMonths": 9000 is outside [0, 600]');
    expect(text).toContain('feature "pep": expected a boolean, got a string');
  });

  it("rejects an unknown action and malformed input", async () => {
    expect(await toolError({ context: { case: CLEAN_CASE }, proposedAction: "launderMoney" })).toContain("proposedAction");
    expect(await toolError({ proposedAction: "approve" })).toContain("context");
    expect(await toolError({ context: { case: { pep: [true] } }, proposedAction: "approve" })).toContain("Input validation error");
  });
});

describe("HTTP surface", () => {
  it("requires the bearer token when configured", async () => {
    const running = await startGuardrailServer({ bearerToken: "s3cret-token" });
    try {
      await expect(connectClient(running.url)).rejects.toThrow();
      await expect(connectClient(running.url, "wrong-token")).rejects.toThrow();
      const raw = await fetch(running.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(raw.status).toBe(401);
      expect(raw.headers.get("www-authenticate")).toBe("Bearer");

      const client = await connectClient(running.url, "s3cret-token");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([CHECK_ACTION_TOOL]);
      await client.close();
    } finally {
      await running.close();
    }
  });

  it("needs no token when none is configured, and answers only POST", async () => {
    const running = await startGuardrailServer();
    try {
      const client = await connectClient(running.url, "ignored");
      expect((await client.listTools()).tools).toHaveLength(1);
      await client.close();
      const get = await fetch(running.url, { headers: { accept: "text/event-stream" } });
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
    } finally {
      await running.close();
    }
  });
});
