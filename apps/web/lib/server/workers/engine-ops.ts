/**
 * Operations of the hypothesis-engine worker (engine.worker.ts). `questions` is the engine's question
 * generation for one family (`generateQuestions`: counterfactual EIG over every candidate, the
 * why-probe, concept probes), the heaviest step of the live interview: it runs after every committed
 * decision and every applied answer, so it must never run on the event loop that serves the gate and
 * the custom LLM. Same function, same inputs, same questions (ids included).
 */
import { z } from "zod";
import {
  DecisionContextSchema,
  DomainConfigSchema,
  EngineConfigSchema,
  EpochMsSchema,
  HypothesisSetSchema,
  IdSchema,
  ObservationSchema,
  ProposedConceptSchema,
  QuestionSchema,
  SymbolIdSchema,
} from "@vashistha/core";
import type { RpcOps } from "./rpc";

/** Generation takes tens of milliseconds; past this the worker is presumed wedged. */
const QUESTIONS_TIMEOUT_MS = 30_000;

/** `RecentDecision`; a decision the hypotheses gave probability 0 has infinite surprise. */
const RecentDecisionSchema = z.strictObject({
  observation: ObservationSchema,
  surprise: z.strictObject({ observationId: z.string(), probability: z.number(), bits: z.union([z.number(), z.literal(Infinity)]) }),
  explainedMass: z.number(),
});

export const ENGINE_OPS = {
  questions: {
    input: z.strictObject({
      /** The session's feature model; the family model is rebuilt from it with `config` (`familyModel`). */
      domain: DomainConfigSchema,
      familyId: SymbolIdSchema,
      set: HypothesisSetSchema,
      ctx: z.strictObject({
        sessionId: IdSchema,
        createdAt: EpochMsSchema,
        contextVersion: z.int().nonnegative(),
        caseId: z.string().min(1),
        context: DecisionContextSchema,
        parentIds: z.array(IdSchema),
      }),
      recent: RecentDecisionSchema.optional(),
      concepts: z.array(ProposedConceptSchema),
      config: EngineConfigSchema,
    }),
    output: z.array(QuestionSchema),
    timeoutMs: QUESTIONS_TIMEOUT_MS,
  },
} satisfies RpcOps;
