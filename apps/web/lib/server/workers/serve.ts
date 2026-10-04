/**
 * Worker-thread side of the RPC protocol (rpc.ts): validates each request and its input, runs the
 * handler, and posts the result or the error (name and message). Requests run concurrently; their
 * order of completion is the handlers' business.
 */
import { constants, setPriority } from "node:os";
import { parentPort } from "node:worker_threads";
import { z } from "zod";
import { INVALID_INPUT_ERROR, RpcRequestSchema, type RpcOps, type RpcOutput, type RpcResponse } from "./rpc";

export type RpcHandlers<Ops extends RpcOps> = { [K in keyof Ops]: (input: z.output<Ops[K]["input"]>) => Promise<RpcOutput<Ops[K]>> };

function errorOf(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

/**
 * On Linux a thread's nice value is its own (`setpriority(PRIO_PROCESS, 0)` targets the calling thread)
 * and threads it creates inherit it (Z3's own pool included): compute workers run below the request
 * thread's priority, so a CPU-bound search never starves the event loop on a busy host. Elsewhere the
 * call would lower the whole process, so it is Linux only.
 */
function yieldCpuToRequestThread(): void {
  if (process.platform === "linux") setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
}

export function serveRpc<Ops extends RpcOps>(ops: Ops, handlers: RpcHandlers<Ops>): void {
  const port = parentPort;
  if (port === null) throw new Error("serveRpc runs in a worker thread");
  yieldCpuToRequestThread();
  const reply = (response: RpcResponse): void => port.postMessage(response);

  async function run(raw: unknown): Promise<void> {
    // A malformed envelope is a bug in the main thread's client: throwing ends this worker, and the
    // client fails whatever it had in flight.
    const { id, op, input } = RpcRequestSchema.parse(raw);
    const spec = Object.hasOwn(ops, op) ? ops[op] : undefined;
    // The handler's input type is its op's input schema output: exactly what `safeParse` returns below.
    const handler = Object.hasOwn(handlers, op) ? (handlers[op] as (input: unknown) => Promise<unknown>) : undefined;
    if (spec === undefined || handler === undefined) return reply({ id, ok: false, error: { name: INVALID_INPUT_ERROR, message: `unknown operation "${op}"` } });
    const parsed = spec.input.safeParse(input);
    if (!parsed.success)
      return reply({ id, ok: false, error: { name: INVALID_INPUT_ERROR, message: `${op}: ${z.prettifyError(parsed.error)}` } });
    try {
      reply({ id, ok: true, output: await handler(parsed.data) });
    } catch (error) {
      reply({ id, ok: false, error: errorOf(error) });
    }
  }

  // A rejection here (only a malformed envelope) is unhandled on purpose: it ends the worker.
  port.on("message", (raw: unknown) => void run(raw));
}
