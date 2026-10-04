/**
 * Operations of the Z3 worker (z3.worker.ts): the debrief's witness search, the two-experts
 * disagreement search, the tutor's practice cases and the preflight self-test — the `@vashistha/solver`
 * queries the server runs, with their exact semantics (the worker calls the same functions).
 */
import { z } from "zod";
import {
  ConfirmedRuleSchema,
  DomainConfigSchema,
  IdSchema,
  SchemaVersionSchema,
  SymbolIdSchema,
  WitnessSchema,
} from "@vashistha/core";
import type { RpcOps } from "./rpc";

/** A cold search over a large rulebook takes seconds on the production host; past this, the worker is presumed wedged. */
const SEARCH_TIMEOUT_MS = 120_000;
/** First use includes WASM compilation; later self-tests take milliseconds. */
const SELF_TEST_TIMEOUT_MS = 30_000;

/** Readonly: the callers hand over their rulebooks as they hold them. */
const RulesSchema = z.array(ConfirmedRuleSchema).readonly();
const DisagreementWitnessSchema = WitnessSchema.and(z.object({ kind: z.literal("disagreement") }));
const BoundaryWitnessSchema = WitnessSchema.and(z.object({ kind: z.literal("boundary") }));

export const Z3_OPS = {
  witnesses: {
    input: z.strictObject({ domain: DomainConfigSchema, rules: RulesSchema, families: z.array(SymbolIdSchema).readonly(), schemaVersion: SchemaVersionSchema }),
    output: z.strictObject({ witnesses: z.array(WitnessSchema), truncated: z.boolean() }),
    timeoutMs: SEARCH_TIMEOUT_MS,
  },
  disagreements: {
    input: z.strictObject({
      domain: DomainConfigSchema,
      rulesA: RulesSchema,
      rulesB: RulesSchema,
      experts: z.tuple([IdSchema, IdSchema]).readonly(),
      family: SymbolIdSchema,
      schemaVersion: SchemaVersionSchema,
    }),
    output: z.array(DisagreementWitnessSchema),
    timeoutMs: SEARCH_TIMEOUT_MS,
  },
  practice: {
    input: z.strictObject({
      domain: DomainConfigSchema,
      rules: RulesSchema,
      ruleIds: z.array(IdSchema).readonly(),
      count: z.int(),
      schemaVersion: SchemaVersionSchema,
    }),
    output: z.array(BoundaryWitnessSchema),
    timeoutMs: SEARCH_TIMEOUT_MS,
  },
  selfTest: {
    input: z.strictObject({}),
    output: z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), ms: z.number().nonnegative() }),
      z.strictObject({ ok: z.literal(false), error: z.string() }),
    ]),
    timeoutMs: SELF_TEST_TIMEOUT_MS,
    urgent: true,
  },
} satisfies RpcOps;
