/**
 * The message protocol between the server's main thread and its compute worker threads (Z3 and the
 * hypothesis engine, see `z3.ts` / `engine.ts`). Each side validates what it RECEIVES with zod: the
 * worker validates the envelope and the operation's input before running it, the main thread
 * validates the envelope and the operation's output before handing it to a caller. Inputs are typed,
 * not re-validated, on the main thread: the event loop the request handlers share never pays for
 * parsing a hypothesis set or a rulebook.
 *
 * Imported by the composition root and by the worker entry files only, never by route bundles.
 */
import { z } from "zod";

/** One operation a worker serves: its input and output schemas and how long a run may take. */
export type RpcOp = {
  input: z.ZodType;
  output: z.ZodType;
  /** From dispatch to the worker (not from enqueueing); a run past it is abandoned and the worker restarted. */
  timeoutMs: number;
  /** Dispatched before every queued non-urgent request (health probes: tiny, and must not wait behind a long search). */
  urgent?: true;
};
export type RpcOps = Record<string, RpcOp>;

export type RpcInput<Op extends RpcOp> = z.input<Op["input"]>;
export type RpcOutput<Op extends RpcOp> = z.output<Op["output"]>;

export const RpcRequestSchema = z.strictObject({ id: z.int().nonnegative(), op: z.string().min(1), input: z.unknown() });
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.strictObject({ name: z.string(), message: z.string() });

export const RpcResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ id: z.int().nonnegative(), ok: z.literal(true), output: z.unknown() }),
  z.strictObject({ id: z.int().nonnegative(), ok: z.literal(false), error: RpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** The worker refused a request: unknown operation or an input that does not match its schema. */
export const INVALID_INPUT_ERROR = "WorkerInputError";
