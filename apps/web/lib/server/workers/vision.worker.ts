/** The vision worker thread: frame decoding and read planning (perception/prepare.ts) off the request event loop. */
import { prepareFrame } from "../perception/prepare";
import { serveRpc } from "./serve";
import { VISION_OPS } from "./vision-ops";

serveRpc(VISION_OPS, {
  prepare: async (input) => {
    const read = prepareFrame(input);
    // The output schema is rebuilt on the main thread (vision.ts): a zod object does not cross threads.
    const { schema: _schema, ...request } = read.request;
    const planned = { request, thumbnail: read.context.thumbnail, switchPossible: read.context.switchPossible };
    return read.mode === "local" ? { mode: "local" as const, rect: read.rect, ...planned } : { mode: read.mode, ...planned };
  },
});
