/** The hypothesis-engine worker thread: question generation (EIG) off the request event loop. */
import { familyModel, generateQuestions } from "@vashistha/core";
import { ENGINE_OPS } from "./engine-ops";
import { serveRpc } from "./serve";

serveRpc(ENGINE_OPS, {
  questions: async ({ domain, familyId, set, ctx, recent, concepts, config }) =>
    generateQuestions({ model: familyModel(domain, familyId, config), set, ctx, ...(recent !== undefined && { recent }), concepts, config }),
});
