/**
 * The single persistent Node service (plan §5) and the composition root: it builds the runtime
 * (database, ledger, authorization store, ElevenLabs client, Z3 warm-up) unbundled, then hands
 * pages and route handlers to Next.js, whose routes reach the runtime through `getRuntime()`.
 */
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { registerHooks } from "node:module";
import type { Socket } from "node:net";
import next from "next";
import { EnvError } from "@vashistha/core/server";

const SHUTDOWN_TIMEOUT_MS = 10_000;
/** Local development reads the repo-root `.env` (the same file scripts use); production env comes from Railway only. */
const ROOT_ENV_FILE = new URL("../../.env", import.meta.url);
const HOSTNAME = "0.0.0.0";

/**
 * `server-only` throws unless resolved under the `react-server` condition, which Next applies inside
 * its bundles. This process IS the server, and the composition root loads `*.oracle.server.ts`
 * modules (whose first import is `server-only`) unbundled, so resolve it the same way here. Only
 * that one specifier changes; it must be registered before the runtime's module graph is loaded.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "server-only"
      ? nextResolve(specifier, { ...context, conditions: [...context.conditions, "react-server"] })
      : nextResolve(specifier, context);
  },
});

/** A request the front door turned away: 401 for an API, a redirect to sign-in for a page, 403 for a cross-site write. */
function refuse(res: ServerResponse, verdict: { kind: "unauthenticated" } | { kind: "sign_in"; location: string } | { kind: "cross_site" }): void {
  res.setHeader("Cache-Control", "no-store");
  if (verdict.kind === "sign_in") {
    res.writeHead(302, { Location: verdict.location }).end();
    return;
  }
  const [status, body] =
    verdict.kind === "unauthenticated"
      ? [401, { error: "unauthenticated", detail: "sign in first" }]
      : [403, { error: "cross_site", detail: "a signed-in write must come from this site" }];
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const { createRuntime } = await import("./lib/server/runtime-init");
  const { MCP_PATH, createMcpEndpoint } = await import("./lib/server/debrief/mcp");
  const { createReplayService } = await import("./lib/server/replay/service");
  const { registerReplay } = await import("./lib/server/replay/registry");
  const { gate } = await import("./lib/server/auth/gate");
  // Variables already set in the environment win over the file (process.loadEnvFile never overrides).
  if (process.env.NODE_ENV !== "production" && existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const { runtime, close: closeRuntime } = createRuntime(process.env);
  // Verified replay (plan §10): recorded runs from DATA_DIR/replays, derived read-only with the runtime's Z3 and exports.
  registerReplay(createReplayService({ dataDir: runtime.env.DATA_DIR, engines: { solver: runtime.debrief.solver, exports: runtime.debrief.exports } }));
  const port = runtime.env.PORT;
  const dev = runtime.env.NODE_ENV !== "production";
  const httpServer = createServer();
  // Passing httpServer lets Next attach its own WebSocket upgrade handling (dev HMR).
  const app = next({ dev, dir: import.meta.dirname, hostname: HOSTNAME, port, httpServer });
  await app.prepare();
  const handle = app.getRequestHandler();
  // Agents' guardrail endpoint (plan §7.9), served beside Next: `check_action` over the confirmed rulebook.
  const mcp = createMcpEndpoint(runtime);

  // Tracked so shutdown can drop connections that never end on their own: idle keep-alives and
  // upgraded sockets (HMR WebSockets), which `closeAllConnections()` does not cover.
  const sockets = new Set<Socket>();
  let inFlightRequests = 0;
  let shuttingDown = false;
  const destroySockets = (): void => {
    for (const socket of sockets) socket.destroy();
  };

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  httpServer.on("request", (req, res) => {
    inFlightRequests += 1;
    res.once("close", () => {
      inFlightRequests -= 1;
      if (shuttingDown && inFlightRequests === 0) destroySockets();
    });
    const isMcp = new URL(req.url ?? "/", "http://localhost").pathname === MCP_PATH;
    // The front door (lib/server/auth/gate.ts); /mcp checks its own bearer.
    if (!isMcp) {
      const verdict = gate(req, { accounts: runtime.accounts, operatorSecret: runtime.env.CUSTOM_LLM_SECRET, publicBaseUrl: runtime.env.PUBLIC_BASE_URL, now: Date.now() });
      if (verdict.kind !== "pass") {
        refuse(res, verdict);
        return;
      }
    }
    (isMcp ? mcp(req, res) : handle(req, res)).catch((error: unknown) => {
      console.error("Unhandled request error", req.method, req.url, error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, HOSTNAME, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  console.info(`> ${dev ? "dev" : "production"} server ready on http://${HOSTNAME}:${port}`);

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      console.warn(`Received ${signal} during shutdown; exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.info(`Received ${signal}; draining ${inFlightRequests} in-flight request(s)`);
    // Stop accepting; the callback runs once every socket is gone.
    httpServer.close((closeError) => {
      app
        .close()
        .catch((error: unknown) => console.error("Error while closing Next.js", error))
        .finally(() => {
          closeRuntime();
          process.exit(closeError ? 1 : 0);
        });
    });
    if (inFlightRequests === 0) destroySockets();
    else httpServer.closeIdleConnections();
    // Requests that never finish (e.g. SSE streams) are cut after a grace period.
    setTimeout(() => {
      console.warn(`Shutdown grace period of ${SHUTDOWN_TIMEOUT_MS} ms elapsed; closing remaining connections`);
      destroySockets();
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  // EnvError messages name variables only; print just the message so nothing else is echoed.
  if (error instanceof EnvError) console.error(`Server failed to start. ${error.message}`);
  else console.error("Server failed to start", error);
  process.exit(1);
});
