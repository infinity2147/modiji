/** The engine's question generation in process: what the server's engine worker runs (workers/engine.worker.ts). */
import { familyModel, generateQuestions } from "@vashistha/core";
import type { QuestionGenerator } from "../../lib/server/interview/questions";

export const inProcessQuestions: QuestionGenerator = async ({ domain, familyId, set, ctx, recent, concepts, config }) =>
  generateQuestions({ model: familyModel(domain, familyId, config), set, ctx, ...(recent !== undefined && { recent }), concepts, config });
