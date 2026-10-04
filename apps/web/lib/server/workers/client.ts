/**
 * Main-thread side of the RPC protocol (rpc.ts): one long-lived worker thread per client (started at
 * once, so it is warm before the first request), a request queue, a cap on requests in flight, and a
 * timeout per request measured from dispatch (a request dispatched to a restarting worker includes its boot).
 *
 * - Requests are dispatched in arrival order (urgent operations first), at most `maxInFlight` at once.
 * - A request past its timeout is rejected (`WorkerTimeoutError`) and the worker is replaced: whatever
 *   it was computing cannot be interrupted, and a wedged worker must not hold the queue. The other
 *   requests it had in flight are re-dispatched, first, to the new worker (operations are pure).
 * - A worker that dies (an uncaught error, a crash) fails the requests it had in flight
 *   (`WorkerUnavailableError`): one of them may be what killed it. Queued requests go to a new worker.
 * - A failed operation is rejected with `WorkerTaskError` carrying the worker-side error's name and message.
 * - The worker is ref'd only while requests are in flight, so an idle worker never keeps the process alive.
 *
 * The worker loads TypeScript through tsx's loader, as the server process itself does.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { INVALID_INPUT_ERROR, RpcResponseSchema, type RpcInput, type RpcOp, type RpcOps, type RpcOutput } from "./rpc";

/** Exactly tsx's loader: flags of the server process (e.g. `--cpu-prof`) are not passed on. */
const WORKER_EXEC_ARGV = ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];

export class WorkerTaskError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class WorkerTimeoutError extends Error {
  override name = "WorkerTimeoutError";
}

export class WorkerUnavailableError extends Error {
  override name = "WorkerUnavailableError";
}

export type RpcClient<Ops extends RpcOps> = {
  call<K extends keyof Ops & string>(op: K, input: RpcInput<Ops[K]>): Promise<RpcOutput<Ops[K]>>;
  /** Fails everything queued or in flight and stops the worker. */
  close(): Promise<void>;
};

type Task = {
  id: number;
  op: string;
  spec: RpcOp;
  input: unknown;
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

export function createRpcWorker<Ops extends RpcOps>(options: {
  /** Thread name (shown in profiles and errors). */
  name: string;
  entry: URL;
  ops: Ops;
  maxInFlight: number;
  log: Pick<Console, "warn" | "error">;
}): RpcClient<Ops> {
  const { name, entry, ops, maxInFlight, log } = options;
  const queue: Task[] = [];
  const inFlight = new Map<number, Task>();
  let nextId = 0;
  let closed = false;
  let worker: Worker | null = spawn();

  function spawn(): Worker {
    const w = new Worker(entry, { name, execArgv: WORKER_EXEC_ARGV });
    w.on("message", (raw: unknown) => receive(w, raw));
    w.on("error", (error) => stopped(w, error.message));
    w.on("exit", (code) => stopped(w, `exited with code ${code}`));
    w.unref();
    return w;
  }

  function settle(task: Task): void {
    clearTimeout(task.timer);
    task.timer = undefined;
    inFlight.delete(task.id);
    if (inFlight.size === 0) worker?.unref();
  }

  function receive(w: Worker, raw: unknown): void {
    if (w !== worker) return;
    const response = RpcResponseSchema.safeParse(raw);
    if (!response.success) {
      replace(`sent a malformed response`);
      return;
    }
    const task = inFlight.get(response.data.id);
    if (task === undefined) return;
    settle(task);
    if (!response.data.ok) task.reject(new WorkerTaskError(response.data.error.name, response.data.error.message));
    else {
      const output = task.spec.output.safeParse(response.data.output);
      if (output.success) task.resolve(output.data);
      else task.reject(new WorkerTaskError("WorkerOutputError", `${name} ${task.op}: invalid output: ${output.error.message}`));
    }
    pump();
  }

  /** The worker died: what it had in flight fails; the queue continues on a new worker. */
  function stopped(w: Worker, reason: string): void {
    if (w !== worker) return;
    worker = null;
    if (closed) return;
    log.error(`[workers] ${name} worker stopped (${reason}); ${inFlight.size} request(s) failed`);
    for (const task of [...inFlight.values()]) {
      settle(task);
      task.reject(new WorkerUnavailableError(`${name} worker stopped while running ${task.op}: ${reason}`));
    }
    pump();
  }

  /** Replaces the worker after a protocol violation, failing what it had in flight. */
  function replace(reason: string): void {
    const w = worker;
    if (w === null) return;
    stopped(w, reason);
    void w.terminate();
  }

  function timedOut(task: Task): void {
    const w = worker;
    if (w === null || !inFlight.has(task.id)) return;
    settle(task);
    task.reject(new WorkerTimeoutError(`${name} ${task.op} did not finish within ${task.spec.timeoutMs} ms`));
    log.warn(`[workers] ${name} ${task.op} timed out; restarting the worker (${inFlight.size} other request(s) re-dispatched)`);
    const victims = [...inFlight.values()];
    for (const v of victims) settle(v);
    queue.unshift(...victims);
    worker = null;
    void w.terminate();
    pump();
  }

  function pump(): void {
    while (!closed && inFlight.size < maxInFlight && queue.length > 0) {
      const task = queue.shift() as Task;
      worker ??= spawn();
      worker.ref();
      inFlight.set(task.id, task);
      task.timer = setTimeout(() => timedOut(task), task.spec.timeoutMs);
      try {
        worker.postMessage({ id: task.id, op: task.op, input: task.input });
      } catch (error) {
        settle(task);
        task.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    call(op, input) {
      const spec = ops[op];
      if (spec === undefined) return Promise.reject(new WorkerTaskError(INVALID_INPUT_ERROR, `${name}: unknown operation "${op}"`));
      if (closed) return Promise.reject(new WorkerUnavailableError(`${name} worker is closed`));
      return new Promise((resolve, reject) => {
        nextId += 1;
        const task: Task = { id: nextId, op, spec, input, resolve: resolve as (output: unknown) => void, reject, timer: undefined };
        const at = spec.urgent === true ? queue.findIndex((t) => t.spec.urgent !== true) : -1;
        if (at === -1) queue.push(task);
        else queue.splice(at, 0, task);
        pump();
      });
    },

    async close() {
      closed = true;
      const error = new WorkerUnavailableError(`${name} worker is closed`);
      for (const task of [...inFlight.values()]) {
        settle(task);
        task.reject(error);
      }
      for (const task of queue.splice(0)) task.reject(error);
      const w = worker;
      worker = null;
      await w?.terminate();
    },
  };
}
