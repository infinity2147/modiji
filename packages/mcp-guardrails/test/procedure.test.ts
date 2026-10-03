import { describe, expect, it } from "vitest";
import { ConfirmedRuleSchema, PredicateSchema, checkAction, type ActionId, type ConfirmedRule } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import {
  PROCEDURE_CONTENT_LIMIT,
  ProcedureError,
  compileProcedure,
  createElevenLabsProcedureApi,
  parseProcedure,
  procedureRule,
  publishProcedure,
  renderPredicate,
  type ProcedureApi,
} from "../src";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "../demo/kyc-demo-rulebook";
import { CLEAN_CASE, tutorLookup } from "./support";

const render = (p: unknown): string => renderPredicate(PredicateSchema.parse(p), KYC_DOMAIN);
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const compileDemo = (rules: readonly ConfirmedRule[] = DEMO_RULES): string =>
  compileProcedure({ domain: KYC_DOMAIN, rules, revision: DEMO_RULEBOOK_REVISION });

describe("renderPredicate", () => {
  it("renders comparisons with labels, enum values, units and yes/no", () => {
    expect(render({ "==": [{ var: "jurisdictionRisk" }, "high"] })).toBe("Country risk (Northstar list) is high");
    expect(render({ ">=": [{ var: "accountAgeMonths" }, 24] })).toBe("Relationship age (months) is at least 24 months");
    expect(render({ ">": [{ var: "uboOwnershipPct" }, 25] })).toBe("Largest beneficial owner share is more than 25%");
    expect(render({ "<": [{ var: "expectedMonthlyVolume" }, 50_000] })).toBe("Expected monthly volume is less than 50,000 EUR");
    expect(render({ "!=": [{ var: "pep" }, true] })).toBe("Politically exposed person is not yes");
    expect(render({ "==": [{ var: "uboVerified" }, false] })).toBe("Largest owner identity verified is no");
  });

  it("puts the feature first when the literal comes first", () => {
    expect(render({ "<=": [24, { var: "accountAgeMonths" }] })).toBe("Relationship age (months) is at least 24 months");
  });

  it("renders membership, and/or nesting and negation unambiguously", () => {
    expect(render({ in: [{ var: "entityType" }, ["company", "trust"]] })).toBe("Entity type is one of company or trust");
    expect(render({ in: [{ var: "sourceOfFunds" }, ["unverified", "not_provided", "verified"]] })).toBe(
      "Source of funds is one of unverified, not_provided or verified",
    );
    expect(
      render({
        and: [
          { "==": [{ var: "jurisdictionRisk" }, "high"] },
          { or: [{ "==": [{ var: "pep" }, true] }, { "==": [{ var: "adverseMedia" }, true] }] },
        ],
      }),
    ).toBe("Country risk (Northstar list) is high and (Politically exposed person is yes or Adverse media is yes)");
    expect(render({ "!": [{ and: [{ "==": [{ var: "pep" }, true] }, { "==": [{ var: "sanctionsHit" }, false] }] }] })).toBe(
      "not (Politically exposed person is yes and Sanctions screening match is no)",
    );
  });
});

describe("compileProcedure", () => {
  const content = compileDemo();

  it("states when / then / why for every rule, quoting the expert exactly", () => {
    for (const rule of DEMO_RULES) {
      expect(content).toContain(`### Rule ${rule.id} (${rule.kind})`);
      expect(content).toContain(`- **When:** ${renderPredicate(rule.predicate, KYC_DOMAIN)}`);
      expect(content).toContain(`> ${rule.evidence[0].exactQuote}`);
    }
    expect(content).toContain('- **Then:** Do not take the action "Approve onboarding" (approve).');
    expect(content).toContain('- **Then:** Any "Review outcome" decision needs approval from a compliance officer before it is committed.');
    expect(content).toContain("- **Overrides:** when this rule applies, rule R-high-risk-country does not.");
    expect(content).toContain("- **Why:** the expert (expert-demo, 2:12.4–2:19.1) said:");
    expect(content.length).toBeLessThanOrEqual(PROCEDURE_CONTENT_LIMIT);
  });

  it("is deterministic and independent of rule order", () => {
    expect(compileDemo([...DEMO_RULES].reverse())).toBe(content);
  });

  it("refuses content above the ElevenLabs 50,000-character limit", () => {
    const quote = "x".repeat(1_000);
    const many = Array.from({ length: 60 }, (_, i) =>
      ConfirmedRuleSchema.parse({ ...DEMO_RULES[0], id: `R-${i}`, evidence: [{ ...DEMO_RULES[0]?.evidence[0], exactQuote: quote }] }),
    );
    expect(() => compileDemo(many)).toThrow(ProcedureError);
    expect(() => compileDemo(many.slice(0, 30))).not.toThrow();
  });
});

describe("parseProcedure (round trip)", () => {
  it("recovers exactly the source rules' ids, predicates, effects, priorities and overrides", () => {
    const parsed = parseProcedure(compileDemo());
    expect(parsed.domainId).toBe(KYC_DOMAIN.id);
    expect(parsed.rulebookRevision).toBe(DEMO_RULEBOOK_REVISION);
    expect([...parsed.rules].sort(byId)).toEqual(DEMO_RULES.map(procedureRule).sort(byId));
  });

  it("recovered rules decide exactly as the source rules", () => {
    const byIdSource = new Map(DEMO_RULES.map((r) => [r.id, r]));
    const recovered = parseProcedure(compileDemo()).rules.map((r) => {
      const source = byIdSource.get(r.id);
      if (source === undefined) throw new Error(r.id);
      return { ...source, ...r };
    });
    for (const values of [CLEAN_CASE, { ...CLEAN_CASE, jurisdictionRisk: "high" }, { ...CLEAN_CASE, pep: true }, { ...CLEAN_CASE, sanctionsHit: null }]) {
      const features = tutorLookup(values);
      const action = "approve" as ActionId;
      expect(checkAction({ rules: recovered, features, action, domain: KYC_DOMAIN })).toEqual(
        checkAction({ rules: DEMO_RULES, features, action, domain: KYC_DOMAIN }),
      );
    }
  });

  it("is not fooled by fences or JSON inside an expert quote", () => {
    const tricky = ConfirmedRuleSchema.parse({
      ...DEMO_RULES[0],
      evidence: [{ ...DEMO_RULES[0]?.evidence[0], exactQuote: 'Look:\n```json\n{"format":"evil"}\n```\nnever approve' }],
    });
    const content = compileDemo([tricky]);
    expect(content).toContain("> ```json");
    expect(parseProcedure(content).rules).toEqual([procedureRule(tricky)]);
  });

  it("round-trips an empty rulebook", () => {
    expect(parseProcedure(compileDemo([])).rules).toEqual([]);
  });

  it("rejects content without exactly one valid rules block", () => {
    const content = compileDemo();
    expect(() => parseProcedure("# no block")).toThrow(ProcedureError);
    expect(() => parseProcedure(`${content}\n${content}`)).toThrow(ProcedureError);
    expect(() => parseProcedure(content.replace('"rulebookRevision":3', '"rulebookRevision":-1'))).toThrow();
    expect(() => parseProcedure(content.replace('{"format"', '{format'))).toThrow(ProcedureError);
  });
});

describe("publishProcedure", () => {
  function fakeApi(): { api: ProcedureApi; calls: unknown[][] } {
    const calls: unknown[][] = [];
    return {
      calls,
      api: {
        createProcedure: async (...args) => (calls.push(["create", ...args]), { procedureId: "proc_new" }),
        updateProcedureDraft: async (...args) => void calls.push(["draft", ...args]),
        publish: async (...args) => void calls.push(["publish", ...args]),
      },
    };
  }
  const content = compileDemo();

  it("creates, writes the full draft, then publishes the branch", async () => {
    const { api, calls } = fakeApi();
    const out = await publishProcedure({ client: api, agentId: "agent_1", branchId: "br_1", name: "KYC rules", content, trigger: "Before any review outcome" });
    expect(out).toEqual({ procedureId: "proc_new" });
    expect(calls).toEqual([
      ["create", "agent_1", "br_1", { name: "KYC rules", type: "free_form", trigger: "Before any review outcome" }],
      ["draft", "agent_1", "br_1", "proc_new", { name: "KYC rules", content, type: "free_form", trigger: "Before any review outcome" }],
      ["publish", "agent_1", "br_1", 'Publish procedure "KYC rules" (proc_new)'],
    ]);
  });

  it("updates an existing procedure without creating one", async () => {
    const { api, calls } = fakeApi();
    await publishProcedure({ client: api, agentId: "agent_1", branchId: "br_1", name: "KYC rules", content, procedureId: "proc_old" });
    expect(calls.map((c) => c[0])).toEqual(["draft", "publish"]);
    expect(calls[0]).toEqual(["draft", "agent_1", "br_1", "proc_old", { name: "KYC rules", content, type: "free_form" }]);
  });

  it("stops before any call when the content is too large", async () => {
    const { api, calls } = fakeApi();
    const huge = "x".repeat(PROCEDURE_CONTENT_LIMIT + 1);
    await expect(publishProcedure({ client: api, agentId: "a", branchId: "b", name: "n", content: huge })).rejects.toThrow(ProcedureError);
    expect(calls).toEqual([]);
  });

  it("maps to the api-notes §6 endpoints over fetch", async () => {
    const requests: { method: string; url: string; body: unknown; key: string | null }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? "GET", url: String(input), body: JSON.parse(String(init?.body)), key: headers.get("xi-api-key") });
      return new Response(init?.method === "POST" ? JSON.stringify({ procedure_id: "proc_9" }) : "{}", { status: 200 });
    };
    const api = createElevenLabsProcedureApi({ apiKey: "xi-test", fetch: fakeFetch, baseUrl: "https://el.test/" });
    await publishProcedure({ client: api, agentId: "agent 1", branchId: "br/1", name: "KYC rules", content: "body" });
    expect(requests).toEqual([
      { method: "POST", url: "https://el.test/v1/convai/agents/agent%201/branches/br%2F1/procedures", body: { name: "KYC rules", type: "free_form" }, key: "xi-test" },
      {
        method: "PATCH",
        url: "https://el.test/v1/convai/agents/agent%201/branches/br%2F1/procedures/proc_9/draft",
        body: { name: "KYC rules", content: "body", type: "free_form" },
        key: "xi-test",
      },
      { method: "PATCH", url: "https://el.test/v1/convai/agents/agent%201?branch_id=br%2F1", body: { version_description: 'Publish procedure "KYC rules" (proc_9)' }, key: "xi-test" },
    ]);
  });

  it("surfaces HTTP failures with status and without the API key", async () => {
    const failing: typeof fetch = async () => new Response('{"detail":"nope"}', { status: 422 });
    const api = createElevenLabsProcedureApi({ apiKey: "xi-secret", fetch: failing });
    const error = await api.createProcedure("a", "b", { name: "n", type: "free_form" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProcedureError);
    expect(String(error)).toContain("HTTP 422");
    expect(String(error)).not.toContain("xi-secret");
  });
});
