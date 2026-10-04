/** A worker for the RPC client tests (workers.test.ts): an echo, a sleep, a failure, a bad output and an exit. */
import { setTimeout as sleep } from "node:timers/promises";
import { serveRpc } from "../../lib/server/workers/serve";
import { TEST_OPS } from "./rpc-test-ops";

serveRpc(TEST_OPS, {
  echo: async ({ text }) => ({ text }),
  sleep: async ({ ms }) => {
    await sleep(ms);
    return { text: `slept ${ms}` };
  },
  fail: async ({ text }) => {
    const error = new Error(text);
    error.name = "BoomError";
    throw error;
  },
  badOutput: async () => ({ text: 42 }) as unknown as { text: string },
  exit: async () => process.exit(3),
  ping: async ({ text }) => ({ text }),
});
