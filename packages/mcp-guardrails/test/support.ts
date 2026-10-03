import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { unknown, type FeatureLookup, type Value } from "@vashistha/core";
import { KYC_DOMAIN, caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
import { createGuardrailMcpServer, createMcpHttpHandler, type McpHttpHandlerOptions } from "../src";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "../demo/kyc-demo-rulebook";

export type Running = { url: URL; close: () => Promise<void> };

/** A real HTTP server on an ephemeral port with the handler mounted at /mcp (404 elsewhere). */
export async function startGuardrailServer(options: McpHttpHandlerOptions = {}): Promise<Running> {
  const handler = createMcpHttpHandler(
    () => createGuardrailMcpServer({ domain: KYC_DOMAIN, rulebook: () => ({ rules: DEMO_RULES, revision: DEMO_RULEBOOK_REVISION }) }),
    options,
  );
  const server: Server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/mcp") void handler(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export async function connectClient(url: URL, bearerToken?: string): Promise<Client> {
  const client = new Client({ name: "mcp-guardrails-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    url,
    bearerToken === undefined ? {} : { requestInit: { headers: { authorization: `Bearer ${bearerToken}` } } },
  );
  await client.connect(transport as Transport);
  return client;
}

/** Decision features of a CaseDesk case, as the tutor's interlock derives them. */
export function kycCaseFeatures(caseId: string): Record<string, Value> {
  const found = findKycCase(caseId);
  if (found === undefined) throw new Error(`no case ${caseId}`);
  return caseFeatures(found);
}

/** A clean company case: no rule in the demo rulebook fires on `approve`. */
export const CLEAN_CASE: Readonly<Record<string, Value>> = {
  entityType: "company",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "low",
  uboOwnershipPct: 40,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 20_000,
  riskRating: "unrated",
};

/** The tutor's lookup (apps/web interlock): absent or null → unknown. */
export function tutorLookup(values: Readonly<Partial<Record<string, Value | null>>>): FeatureLookup {
  return (id) => (Object.hasOwn(values, id) ? values[id] : undefined) ?? unknown("not_extracted");
}
