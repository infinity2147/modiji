/** Sweep worker: runs one episode per message. Its Z3 equivalence cache lives as long as the thread. */
import { parentPort } from "node:worker_threads";
import { runEpisode } from "./episode";
import type { Job } from "./sweep";

const port = parentPort;
if (port === null) throw new Error("worker.ts must run as a worker thread");
const cache = new Map<string, boolean>();
port.on("message", (job: Job) => {
  runEpisode(job.spec, cache).then(
    (results) => port.postMessage({ index: job.index, results }),
    (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
});
