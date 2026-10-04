import { z } from "zod";
import type { RpcOps } from "../../lib/server/workers/rpc";

const Text = z.strictObject({ text: z.string() });

export const TEST_OPS = {
  echo: { input: Text, output: Text, timeoutMs: 10_000 },
  sleep: { input: z.strictObject({ ms: z.int().nonnegative() }), output: Text, timeoutMs: 2_000 },
  fail: { input: Text, output: Text, timeoutMs: 10_000 },
  badOutput: { input: z.strictObject({}), output: Text, timeoutMs: 10_000 },
  exit: { input: z.strictObject({}), output: Text, timeoutMs: 10_000 },
  ping: { input: Text, output: Text, timeoutMs: 10_000, urgent: true },
} satisfies RpcOps;
