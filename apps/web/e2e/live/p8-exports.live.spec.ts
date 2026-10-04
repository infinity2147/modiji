/**
 * @live @p8 — P8 exports round trip, LIVE against production (plan §11 P8): the Work Map JSON and the
 * ElevenLabs Procedure exported by production for the expert sessions whose stop-rules are in the
 * production rulebook, verified against `GET /api/rulebook` (the rules in force):
 *   - Work Map JSON imports (schema-valid) and re-exports to the same bytes;
 *   - every Work Map rule is in the production rulebook, deep-equal;
 *   - the Procedure's machine-readable block parses and equals the Work Map's rules (procedureRule
 *     projection), at the same rulebook revision, and its text quotes every rule's expert words;
 *   - MCP `check_action` on production agrees with a local `checkAction` over the production rulebook
 *     on every demo case × outcome.
 * The live Claude agent run (agent-blocked.ts) is a separate command; see README.md.
 * Session ids: LIVE_P8_SESSIONS (comma-separated) or docs/evidence/live/p4/**\/latest-session.txt.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ActionIdSchema, checkAction, type ConfirmedRule } from "@vashistha/core";
import { caseFeatures, kycCases, KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { exportWorkMapJson, importWorkMapJson, parseProcedure, procedureRule } from "@vashistha/mcp-guardrails";
import { BASE_URL, EVIDENCE_DIR, REPO_ROOT } from "./support/env";
import { evidencePath } from "./support/report";

const GROUP = "p8";

function sessions(): string[] {
  const fromEnv = process.env.LIVE_P8_SESSIONS;
  if (fromEnv) return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
  const files = ["p4/latest-session.txt", "p4/attempt-3-single-sentence-stop-rules/latest-session.txt"];
  return [...new Set(files.flatMap((f) => {
    try {
      return [readFileSync(join(EVIDENCE_DIR, f), "utf8").trim()];
    } catch {
      return [];
    }
  }))];
}

/** The MCP SDK is a dependency of @vashistha/mcp-guardrails (not of the web app): resolve it from there. */
type McpClient = {
  connect: (transport: unknown) => Promise<void>;
  callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
};
async function mcpClient(url: URL, token: string): Promise<McpClient> {
  const req = createRequire(join(REPO_ROOT, "packages/mcp-guardrails/package.json"));
  const load = async (spec: string) => (await import(pathToFileURL(req.resolve(spec)).href)) as Record<string, unknown>;
  const { Client } = (await load("@modelcontextprotocol/sdk/client/index.js")) as { Client: new (info: { name: string; version: string }) => McpClient };
  const { StreamableHTTPClientTransport } = (await load("@modelcontextprotocol/sdk/client/streamableHttp.js")) as {
    StreamableHTTPClientTransport: new (url: URL, opts: { requestInit: RequestInit }) => unknown;
  };
  const client = new Client({ name: "vashistha-live-p8", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

test("@live @p8 Work Map JSON + Procedure + MCP round trip against the production rulebook", async ({ request }) => {
  test.setTimeout(10 * 60_000);
  const rulebook = (await (await request.get("/api/rulebook")).json()) as { revision: number; rules: ConfirmedRule[] };
  writeFileSync(evidencePath(GROUP, `rulebook-r${rulebook.revision}.json`), `${JSON.stringify(rulebook, null, 2)}\n`);
  const byId = new Map(rulebook.rules.map((r) => [r.id, r]));
  const report: string[] = [`P8 exports round trip — ${BASE_URL} — production rulebook revision ${rulebook.revision} (${rulebook.rules.length} rules)`, ""];
  const results: Record<string, unknown>[] = [];

  for (const sessionId of sessions()) {
    const jsonResponse = await request.get(`/api/sessions/${sessionId}/workmap/export?format=json`);
    expect(jsonResponse.ok(), await jsonResponse.text()).toBe(true);
    const jsonText = await jsonResponse.text();
    writeFileSync(evidencePath(GROUP, `workmap-${sessionId}.json`), jsonText);
    const procResponse = await request.get(`/api/sessions/${sessionId}/workmap/export?format=procedure`);
    expect(procResponse.ok()).toBe(true);
    const procText = await procResponse.text();
    writeFileSync(evidencePath(GROUP, `procedure-${sessionId}.md`), procText);

    const workMap = importWorkMapJson(jsonText);
    const reexported = exportWorkMapJson(workMap);
    const jsonByteRoundTrip = reexported === jsonText;
    const notInRulebook = workMap.rules.filter((r) => byId.get(r.id) === undefined).map((r) => r.id);
    const differsFromRulebook = workMap.rules.filter((r) => byId.has(r.id) && canonical(byId.get(r.id)) !== canonical(r)).map((r) => r.id);
    const procedure = parseProcedure(procText);
    const procedureEqualsWorkMap =
      canonical([...procedure.rules].sort((a, b) => a.id.localeCompare(b.id))) ===
      canonical(workMap.rules.map(procedureRule).sort((a, b) => a.id.localeCompare(b.id)));
    const procedureEqualsRulebookProjection = procedure.rules.every((p) => {
      const r = byId.get(p.id);
      return r !== undefined && canonical(procedureRule(r)) === canonical(p);
    });
    const quotesInProcedureText = workMap.rules.every((r) => r.evidence.filter((e) => e.kind === "expert_quote").every((e) => procText.includes(e.exactQuote)));
    const stopRules = workMap.rules.filter((r) => r.effect.type === "forbid" || r.effect.type === "require_approval");
    const row = {
      sessionId,
      workMapRules: workMap.rules.length,
      stopRules: stopRules.map((r) => ({ id: r.id, effect: r.effect, quote: r.evidence[0].exactQuote })),
      workMapRevision: workMap.rulebookRevision,
      procedureRevision: procedure.rulebookRevision,
      rulebookRevision: rulebook.revision,
      jsonByteRoundTrip,
      notInRulebook,
      differsFromRulebook,
      procedureRules: procedure.rules.length,
      procedureEqualsWorkMap,
      procedureEqualsRulebookProjection,
      quotesInProcedureText,
      rulebookRulesNotInWorkMap: rulebook.rules.filter((r) => !workMap.rules.some((w) => w.id === r.id)).map((r) => r.id),
    };
    results.push(row);
    report.push(
      `Session ${sessionId}: Work Map ${workMap.rules.length} rules (${stopRules.length} stop-rules), revision ${workMap.rulebookRevision}; Procedure ${procedure.rules.length} rules, revision ${procedure.rulebookRevision}`,
      `  JSON import→export byte-identical: ${jsonByteRoundTrip}`,
      `  every Work Map rule in /api/rulebook: ${notInRulebook.length === 0} · deep-equal: ${differsFromRulebook.length === 0}`,
      `  Procedure block == Work Map rules: ${procedureEqualsWorkMap} · == rulebook projection: ${procedureEqualsRulebookProjection} · every expert quote in the Procedure text: ${quotesInProcedureText}`,
      `  rulebook rules not in this session's Work Map: ${row.rulebookRulesNotInWorkMap.length} (the Work Map is per session/expert)`,
      ...stopRules.map((r) => `  stop-rule ${r.id} ${JSON.stringify(r.effect)}: "${r.evidence[0].exactQuote}"`),
      "",
    );
    expect.soft(jsonByteRoundTrip, `${sessionId}: JSON round trip`).toBe(true);
    expect.soft(notInRulebook, `${sessionId}: rules missing from the rulebook`).toEqual([]);
    expect.soft(differsFromRulebook, `${sessionId}: rules differing from the rulebook`).toEqual([]);
    expect.soft(procedureEqualsWorkMap, `${sessionId}: procedure == work map`).toBe(true);
    expect.soft(procedureEqualsRulebookProjection, `${sessionId}: procedure == rulebook`).toBe(true);
    expect.soft(quotesInProcedureText, `${sessionId}: quotes in procedure`).toBe(true);
  }

  // MCP check_action (production) vs a local checkAction over the production rulebook.
  const mcp = await mcpClient(new URL(`${BASE_URL}/mcp`), process.env.MCP_BEARER_TOKEN ?? "");
  const mismatches: string[] = [];
  let compared = 0;
  const outcomes = ["approve", "enhancedReview", "requestDocuments", "escalateCompliance", "reject"];
  for (const set of ["training", "heldout", "practice"] as const)
    for (const c of kycCases(set)) {
      const features = caseFeatures(c);
      for (const action of outcomes) {
        const raw = (await mcp.callTool({ name: "check_action", arguments: { context: { case: features }, proposedAction: action } })) as { structuredContent?: { decision?: string; rulebookRevision?: number } };
        const local = checkAction({ rules: rulebook.rules, features: (f) => (features as Record<string, unknown>)[f] as never, action: ActionIdSchema.parse(action), domain: KYC_DOMAIN });
        compared += 1;
        const remote = raw.structuredContent?.decision;
        if (remote !== local.decision || raw.structuredContent?.rulebookRevision !== rulebook.revision)
          mismatches.push(`${c.id} ${action}: mcp=${remote} r${raw.structuredContent?.rulebookRevision} local=${local.decision} r${rulebook.revision}`);
      }
    }
  await mcp.close();
  report.push(`MCP check_action vs local checkAction over /api/rulebook: ${compared - mismatches.length}/${compared} agree`, ...mismatches.map((m) => `  MISMATCH ${m}`));
  writeFileSync(evidencePath(GROUP, "exports-roundtrip.json"), `${JSON.stringify({ target: BASE_URL, rulebookRevision: rulebook.revision, sessions: results, mcp: { compared, mismatches } }, null, 2)}\n`);
  writeFileSync(evidencePath(GROUP, "exports-roundtrip.txt"), `${report.join("\n")}\n`);
  console.info(report.join("\n"));
  expect.soft(mismatches).toEqual([]);
});
