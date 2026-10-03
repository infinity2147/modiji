/**
 * Local guardrail MCP server for the demo and for verifying the agent client without the web app:
 * `check_action` at http://127.0.0.1:<port>/mcp over the SYNTHETIC demo rulebook (demo/kyc-demo-rulebook.ts).
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/mcp-guardrails/demo/serve.ts [--port 4318]
 *
 * Set MCP_BEARER_TOKEN to require `Authorization: Bearer <token>`.
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { createGuardrailMcpServer, createMcpHttpHandler } from "../src";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "./kyc-demo-rulebook";

const { values } = parseArgs({ options: { port: { type: "string", default: "4318" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError(`invalid --port ${values.port}`);

const bearerToken = process.env.MCP_BEARER_TOKEN;
const handler = createMcpHttpHandler(
  () => createGuardrailMcpServer({ domain: KYC_DOMAIN, rulebook: () => ({ rules: DEMO_RULES, revision: DEMO_RULEBOOK_REVISION }) }),
  bearerToken === undefined || bearerToken === "" ? {} : { bearerToken },
);

const server = createServer((req, res) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname === "/mcp") void handler(req, res);
  else res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => {
  console.info(`guardrail MCP server on http://127.0.0.1:${port}/mcp (synthetic demo rulebook, revision ${DEMO_RULEBOOK_REVISION}, ${DEMO_RULES.length} rules)`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
