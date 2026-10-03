/**
 * `/mcp` (plan §7.9): the guardrail MCP server (`check_action` over the confirmed rulebook in force,
 * with the expert's quotes) mounted on the custom server. Clients send `Authorization: Bearer
 * <MCP_BEARER_TOKEN>`. Without a token the endpoint is open in development and refuses every request
 * in production. Imported only by server.ts (unbundled).
 */
import "server-only";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { createGuardrailMcpServer, createMcpHttpHandler, type McpHttpHandler } from "@vashistha/mcp-guardrails";
import type { ServerEnv } from "@vashistha/core/server";
import type { Runtime } from "../runtime";

export const MCP_PATH = "/mcp";

export function createMcpEndpoint(runtime: Pick<Runtime, "rulebook" | "rulebookRevision"> & { env: Pick<ServerEnv, "NODE_ENV" | "MCP_BEARER_TOKEN"> }): McpHttpHandler {
  const token = runtime.env.MCP_BEARER_TOKEN;
  if (token === undefined && runtime.env.NODE_ENV === "production") {
    return async (_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint disabled: MCP_BEARER_TOKEN is not set" }, id: null }));
    };
  }
  return createMcpHttpHandler(
    () => createGuardrailMcpServer({ domain: KYC_DOMAIN, rulebook: () => ({ rules: runtime.rulebook(), revision: runtime.rulebookRevision() }) }),
    token === undefined ? {} : { bearerToken: token },
  );
}
