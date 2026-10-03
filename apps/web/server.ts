/**
 * The single persistent Node service (plan §5). Next.js handles pages and route handlers;
 * later phases mount the custom-LLM SSE endpoint and the MCP server on this same process.
 */
import { createServer } from "node:http";
import type { Socket } from "node:net";
import next from "next";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const HOSTNAME = "0.0.0.0";

type ServerConfig = { port: number; dev: boolean };

/**
 * Reads the only two variables this process needs today. Full env validation lives in
 * `@vashistha/core/server` (packages/core/src/server/env.ts); swap this for it once it lands.
 */
function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env["PORT"] ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65_535) {
    throw new Error(`PORT must be an integer in 0..65535, got "${rawPort}"`);
  }
  return { port, dev: env["NODE_ENV"] !== "production" };
}

async function main(): Promise<void> {
  const { port, dev } = readServerConfig(process.env);
  const httpServer = createServer();
  // Passing httpServer lets Next attach its own WebSocket upgrade handling (dev HMR).
  const app = next({ dev, dir: import.meta.dirname, hostname: HOSTNAME, port, httpServer });
  await app.prepare();
  const handle = app.getRequestHandler();

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
    handle(req, res).catch((error: unknown) => {
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
        .finally(() => process.exit(closeError ? 1 : 0));
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
  console.error("Server failed to start", error);
  process.exit(1);
});
