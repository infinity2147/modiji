/**
 * Streamable HTTP endpoint for the guardrail MCP server, in stateless JSON-response mode: every POST
 * gets a fresh server and transport, and the reply is a single JSON body (no SSE, no sessions), so it
 * can be mounted on any Node `http` server, e.g. at `/mcp` in apps/web/server.ts (see README).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export type McpHttpHandlerOptions = {
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Unexpected failures (the response is already a JSON-RPC internal error). Defaults to `console.error`. */
  onError?: (error: unknown) => void;
};

/** JSON-RPC error codes used by the MCP SDK for transport-level failures. */
const JSONRPC_SERVER_ERROR = -32000;
const JSONRPC_INTERNAL_ERROR = -32603;

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison: both sides are hashed to equal-length digests first. */
function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  return match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected);
}

export function createMcpHttpHandler(createServer: () => McpServer, options: McpHttpHandlerOptions = {}): McpHttpHandler {
  if (options.bearerToken?.trim() === "") throw new TypeError("bearerToken is empty");
  const expected = options.bearerToken === undefined ? undefined : digest(options.bearerToken);
  const onError = options.onError ?? ((error: unknown) => console.error("MCP request failed", error));

  return async (req, res) => {
    if (expected !== undefined && !bearerMatches(req.headers.authorization, expected)) {
      sendJsonRpcError(res, 401, JSONRPC_SERVER_ERROR, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }
    // Stateless: there is no session to stream to (GET) or to end (DELETE).
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, JSONRPC_SERVER_ERROR, "Method not allowed", { allow: "POST" });
      return;
    }
    const server = createServer();
    // Omitting `sessionIdGenerator` selects stateless mode.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // The SDK's getters return `T | undefined` for optional `Transport` members, which only
      // `exactOptionalPropertyTypes` rejects; the transport is the SDK's own implementation.
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      onError(error);
      if (!res.headersSent) sendJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, "Internal server error");
    }
  };
}
