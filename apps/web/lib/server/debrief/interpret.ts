/**
 * Reads an expert's free reply in the debrief conversation (Sonnet 5.5, structured output). The model only
 * proposes: its output is checked by code here (ids against the domain, conditions converted and type-checked)
 * and then read back to the expert, and nothing is saved until the expert says yes to that read-back. Plain yes,
 * no and skip replies never reach the model (conversation.ts reads them by rule). The prompt is built from the
 * session's PUBLIC feature model only; `runtime.claude` refuses any prompt carrying an oracle marker.
 */
import "server-only";
import { z } from "zod";
import {
  APPROVAL_ROLES,
  LlmConditionSchema,
  conditionListToPredicate,
  promptDomain,
  typecheckPredicate,
  type ActionId,
  type DomainConfig,
  type Predicate,
} from "@vashistha/core";
import type { Claude } from "@vashistha/core/server";
import { REASONING_MODEL } from "../interview/llm";

const DEADLINE_MS = 20_000;

/** What the model may say a reply means. Flat and fully required, as constrained decoding needs. */
export const LlmDebriefReplySchema = z.strictObject({
  kind: z
    .enum(["decision_rule", "stop_rule", "choose_action", "choose_rule", "escalate", "out_of_scope", "range", "retire_rule", "unclear"])
    .describe("What the expert's reply says, from the kinds allowed for this turn"),
  combinator: z.enum(["all", "any"]).describe("all = every condition must hold; any = at least one"),
  conditions: z.array(LlmConditionSchema).max(8).describe("The conditions the expert stated; empty when none"),
  action: z.string().describe("An action id exactly as listed, or empty"),
  effect: z.enum(["forbid", "require_approval", "none"]).describe("For a stop rule: forbid the action, or require approval before it"),
  role: z.string().describe("For require_approval: an approval role id exactly as listed, or empty"),
  rule: z.enum(["first", "second", "none"]).describe("For a conflict: which of the two rules should win"),
  min: z.number().describe("For a range: the smallest value; 0 otherwise"),
  max: z.number().describe("For a range: the largest value; 0 otherwise"),
  integer: z.boolean().describe("For a range: whole numbers only"),
  ruleNumber: z.int().describe("For retire_rule: the number of the confirmed rule to delete, as listed; 0 otherwise"),
});
export type LlmDebriefReply = z.infer<typeof LlmDebriefReplySchema>;

export type ReplyKind = LlmDebriefReply["kind"];

/** What the turn was about, in the words the model needs (no ids it could misuse beyond the listed ones). */
export type InterpretContext = {
  question: string;
  reply: string;
  allowed: readonly ReplyKind[];
  /** Plain-language context: the proposed rule, the case, the two conflicting rules, the concept. */
  context: string;
  /** Actions the reply may name (one decision family's, or all for a stop rule). */
  actions: readonly ActionId[];
  /** The expert's confirmed rules in plain language, numbered from 1 for retire_rule; empty when deleting is not on offer. */
  rules?: readonly string[];
};

/** A reading that passed the code-side checks, ready to be read back. */
export type Reading =
  | { kind: "decision_rule"; predicate: Predicate; conditions: LlmDebriefReply["conditions"]; combinator: "all" | "any"; action: ActionId }
  | { kind: "stop_rule"; predicate: Predicate; conditions: LlmDebriefReply["conditions"]; combinator: "all" | "any"; action: ActionId; effect: "forbid" | "require_approval"; role: (typeof APPROVAL_ROLES)[number] | null }
  | { kind: "choose_action"; action: ActionId }
  | { kind: "choose_rule"; rule: "first" | "second" }
  | { kind: "escalate" }
  | { kind: "out_of_scope" }
  | { kind: "range"; min: number; max: number; integer: boolean }
  /** `index` into `InterpretContext.rules` (0-based). */
  | { kind: "retire_rule"; index: number }
  | { kind: "unclear"; why: string };

const SYSTEM = `You read an expert's reply in a short debrief conversation about how they review customer onboarding cases (synthetic data, fictional policy).
Say what the reply means, using only the kinds allowed for this turn. Rules:
- Use only feature ids, enum values, action ids and approval role ids exactly as listed. Never invent a condition the expert did not state.
- A decision rule: the conditions under which the expert takes one action ("a company whose largest owner holds over 25% and isn't verified goes to enhanced review").
- A stop rule: something the expert would never allow ("never approve when there is a sanctions match"), or only allow with sign-off ("a politically exposed person can only be approved with compliance sign-off" = require_approval, role compliance_officer, action approve).
- choose_action: the action the expert would take for the case described. choose_rule: which of the two conflicting rules should win.
- escalate: the expert says such cases go to a controller or a human above them. out_of_scope: the expert says the case does not matter or cannot happen.
- range: the smallest and largest value a new numeric concept takes.
- retire_rule: the expert wants one of their confirmed rules deleted ("drop the rule about politically exposed people"); give its number from the list. Only when they clearly ask to delete or drop a rule.
- If the reply does not clearly say one allowed thing, answer unclear. Fill unused fields with empty values (empty string, empty list, none, 0, false).`;

function userPrompt(domain: DomainConfig, input: InterpretContext): string {
  return JSON.stringify({
    domain: promptDomain(domain),
    approvalRoles: APPROVAL_ROLES,
    allowedKinds: input.allowed,
    allowedActions: input.actions,
    confirmedRules: (input.rules ?? []).map((text, i) => `Rule ${i + 1}: ${text}`),
    context: input.context,
    question: input.question,
    expertReply: input.reply,
  });
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reply reader did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The code-side check of the model's output: anything that does not hold becomes `unclear`, never a guess. */
export function checkReading(domain: DomainConfig, input: InterpretContext, out: LlmDebriefReply): Reading {
  if (!input.allowed.includes(out.kind)) return { kind: "unclear", why: out.kind === "unclear" ? "I couldn't tell what you meant" : "that didn't sound like an answer to this question" };
  const actionOk = (a: string): a is ActionId => input.actions.includes(a as ActionId);
  const ruleOf = (): { predicate: Predicate } | { why: string } => {
    if (out.conditions.length === 0) return { why: "I didn't hear when the rule applies" };
    const converted = conditionListToPredicate({ combinator: out.combinator, conditions: out.conditions });
    if (!converted.ok) return { why: "I couldn't match that to the case fields" };
    const issues = typecheckPredicate(converted.predicate, domain.features);
    if (issues.length > 0) return { why: "I couldn't match that to the case fields" };
    return { predicate: converted.predicate };
  };
  switch (out.kind) {
    case "decision_rule": {
      if (!actionOk(out.action)) return { kind: "unclear", why: "I couldn't tell which decision you meant" };
      const r = ruleOf();
      return "why" in r ? { kind: "unclear", why: r.why } : { kind: "decision_rule", predicate: r.predicate, conditions: out.conditions, combinator: out.combinator, action: out.action };
    }
    case "stop_rule": {
      if (!actionOk(out.action)) return { kind: "unclear", why: "I couldn't tell which decision you meant" };
      if (out.effect === "none") return { kind: "unclear", why: "I couldn't tell if it is never allowed or needs sign-off" };
      const role = APPROVAL_ROLES.find((r) => r === out.role) ?? null;
      if (out.effect === "require_approval" && role === null) return { kind: "unclear", why: "I couldn't tell who has to sign off" };
      const r = ruleOf();
      if ("why" in r) return { kind: "unclear", why: r.why };
      return { kind: "stop_rule", predicate: r.predicate, conditions: out.conditions, combinator: out.combinator, action: out.action, effect: out.effect, role: out.effect === "require_approval" ? role : null };
    }
    case "choose_action":
      return actionOk(out.action) ? { kind: "choose_action", action: out.action } : { kind: "unclear", why: "I couldn't tell which decision you meant" };
    case "choose_rule":
      return out.rule === "none" ? { kind: "unclear", why: "I couldn't tell which rule should win" } : { kind: "choose_rule", rule: out.rule };
    case "range":
      return Number.isFinite(out.min) && Number.isFinite(out.max) && out.min < out.max ? { kind: "range", min: out.min, max: out.max, integer: out.integer } : { kind: "unclear", why: "I didn't hear a smallest and largest value" };
    case "retire_rule": {
      const count = input.rules?.length ?? 0;
      return Number.isInteger(out.ruleNumber) && out.ruleNumber >= 1 && out.ruleNumber <= count
        ? { kind: "retire_rule", index: out.ruleNumber - 1 }
        : { kind: "unclear", why: "I couldn't tell which rule you want to delete" };
    }
    case "escalate":
    case "out_of_scope":
      return { kind: out.kind };
    case "unclear":
      return { kind: "unclear", why: "I couldn't tell what you meant" };
  }
}

/** Reads one reply. A model failure or a late answer is reported as unclear, never replaced by a guess. */
export async function interpretReply(claude: Claude, domain: DomainConfig, input: InterpretContext, log: Pick<Console, "warn">): Promise<Reading> {
  try {
    const { output } = await withDeadline(
      claude.structured({ model: REASONING_MODEL, system: SYSTEM, messages: [{ role: "user", content: userPrompt(domain, input) }], maxTokens: 1024, cacheSystem: true, schema: LlmDebriefReplySchema }),
      DEADLINE_MS,
    );
    return checkReading(domain, input, output);
  } catch (error) {
    log.warn(`[debrief] reply reader failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { kind: "unclear", why: "I couldn't read that just now" };
  }
}
