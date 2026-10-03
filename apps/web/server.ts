/**
 * The single persistent Node service (plan §5) and the composition root: it builds the runtime
 * (database, ledger, authorization store, ElevenLabs client, Z3 warm-up) unbundled, then hands
 * pages and route handlers to Next.js, whose routes reach the runtime through `getRuntime()`.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
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

async function main(): Promise<void> {
  const { createRuntime } = await import("./lib/server/runtime-init");
  // Variables already set in the environment win over the file (process.loadEnvFile never overrides).
  if (process.env.NODE_ENV !== "production" && existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
  const { runtime, close: closeRuntime } = createRuntime(process.env);
  const port = runtime.env.PORT;
  const dev = runtime.env.NODE_ENV !== "production";
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
