/**
 * The MCP `check_action` tool (plan §4 invention 4, §7.9): the agent-facing consumer of the confirmed
 * rulebook. It calls the same `checkAction` as the human tutor's Save interlock, so identical inputs
 * get identical decisions. Deterministic: no model, no clock, no randomness.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  GuardrailResultSchema,
  checkAction,
  unknown,
  validateFeatureValue,
  type ActionDef,
  type ConfirmedRule,
  type DomainConfig,
  type Feature,
  type FeatureId,
  type FeatureLookup,
  type GuardrailResult,
  type Value,
} from "@vashistha/core";
import { citeRule } from "./cite";

export const CHECK_ACTION_TOOL = "check_action";

/** The rulebook in force at call time; read once per call so the decision and the revision agree. */
export type RulebookSnapshot = { rules: readonly ConfirmedRule[]; revision: number };

export type GuardrailServerOptions = {
  domain: DomainConfig;
  rulebook: () => RulebookSnapshot;
};

export const CheckActionOutputSchema = GuardrailResultSchema.extend({
  rulebookRevision: z.int().nonnegative(),
  /** Deterministic human-readable account of the decision, quoting the expert. */
  explanation: z.string().min(1),
});
export type CheckActionOutput = z.infer<typeof CheckActionOutputSchema>;

/** A case feature value as sent by a client; `null` means unknown. */
const CaseValueSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const TOOL_DESCRIPTION = [
  "Checks a proposed action on a case against the rulebook a human expert confirmed. Deterministic: the same input always gives the same decision, and no model is involved.",
  "Call it before committing any review outcome (approve, reject, escalate, request documents, ...) or risk rating, and again whenever the case data changes. Do not commit an action this tool has not allowed.",
  "Pass every case feature you know in context.case. Pass null (or leave the feature out) when you could not determine it. Never guess a value.",
  "Decisions: allow means you may proceed. forbid means do not take the action; the explanation quotes the expert's rule. needs_approval means proceed only with the named approver's sign-off. insufficient_information means find the missingFeatures and call again; do not proceed in the meantime.",
  "When the decision is not allow, tell the user the explanation, including the expert's quote, word for word.",
].join("\n\n");

function featureCatalog(features: readonly Feature[]): string {
  const lines = features.map((f) => `- ${f.id} (${f.label}): ${featureDomain(f)}`);
  return [
    "Case features keyed by feature id. A value of null, or a feature left out, means unknown. Features:",
    ...lines,
  ].join("\n");
}

function featureDomain(f: Feature): string {
  switch (f.type) {
    case "boolean":
      return "true or false";
    case "string":
      return "text";
    case "enum":
      return `one of ${f.values.join(", ")}`;
    case "number":
      return `${f.integer ? "integer" : "number"} from ${f.min} to ${f.max}${f.unit === undefined ? "" : ` (${f.unit})`}`;
  }
}

function inputSchema(domain: DomainConfig) {
  const [first, ...rest] = domain.actions.map((a) => a.id);
  if (first === undefined) throw new RangeError(`domain "${domain.id}" has no actions`);
  return z.strictObject({
    context: z
      .strictObject({ case: z.record(z.string(), CaseValueSchema).describe(featureCatalog(domain.features)) })
      .describe("What is known about the case right now."),
    proposedAction: z
      .enum([first, ...rest])
      .describe(`The action you intend to take: ${domain.actions.map((a) => `${a.id} (${a.label})`).join(", ")}.`),
  });
}

type CaseRead = { ok: true; lookup: FeatureLookup } | { ok: false; issues: string[] };

/** Validates every submitted feature against the domain; absent and null features are unknown. */
function readCase(domain: DomainConfig, submitted: Readonly<Record<string, Value | null>>): CaseRead {
  const known = new Map<FeatureId, Value>();
  const issues: string[] = [];
  for (const [id, value] of Object.entries(submitted)) {
    if (value === null && domain.features.some((f) => f.id === id)) continue;
    const check = validateFeatureValue(domain, id, value);
    if (check.ok) known.set(check.featureId, check.value);
    else issues.push(`context.case: ${check.message}`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, lookup: (id) => known.get(id) ?? unknown("not_extracted") };
}

export function createGuardrailMcpServer({ domain, rulebook }: GuardrailServerOptions): McpServer {
  const server = new McpServer(
    { name: "vashistha-guardrails", version: "1.0.0" },
    { instructions: `Guardrails for "${domain.title}". Call ${CHECK_ACTION_TOOL} before committing any action on a case.` },
  );
  server.registerTool(
    CHECK_ACTION_TOOL,
    {
      title: "Check a proposed action against the expert's confirmed rules",
      description: TOOL_DESCRIPTION,
      inputSchema: inputSchema(domain),
      outputSchema: CheckActionOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ context, proposedAction }): CallToolResult => {
      const action = domain.actions.find((a) => a.id === proposedAction);
      if (action === undefined) return toolError([`proposedAction: unknown action in domain "${domain.id}"`]);
      const read = readCase(domain, context.case);
      if (!read.ok) return toolError(read.issues);

      const { rules, revision } = rulebook();
      const result = checkAction({ rules, features: read.lookup, action: action.id, domain });
      const output: CheckActionOutput = {
        ...result,
        rulebookRevision: revision,
        explanation: explainDecision(result, { action, domain, rules, revision }),
      };
      return {
        content: [
          { type: "text", text: output.explanation },
          { type: "text", text: JSON.stringify(output) },
        ],
        structuredContent: output,
      };
    },
  );
  return server;
}

function toolError(issues: readonly string[]): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `Invalid ${CHECK_ACTION_TOOL} input:\n${issues.map((i) => `- ${i}`).join("\n")}` }] };
}

type ExplainContext = { action: ActionDef; domain: DomainConfig; rules: readonly ConfirmedRule[]; revision: number };

/** A deterministic account of `result`: decision, the deciding rules with the expert's exact words, and what to do next. */
function explainDecision(result: GuardrailResult, { action, domain, rules, revision }: ExplainContext): string {
  const actionRef = `"${action.id}" (${action.label})`;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const matched = result.matchedRules.map((id) => {
    const rule = byId.get(id);
    if (rule === undefined) throw new Error(`matched rule ${id} is not in the rulebook`);
    return rule;
  });
  switch (result.decision) {
    case "allow":
      return `Allowed: no confirmed rule (rulebook revision ${revision}) forbids ${actionRef} or requires approval for it on this case.`;
    case "forbid":
      return [...matched.map((r) => `Blocked by ${citeRule(r)}.`), `Do not take ${actionRef} on this case.`].join(" ");
    case "needs_approval":
      return [
        ...matched.map((r) => `Needs approval${r.effect.type === "require_approval" ? ` from a ${r.effect.role}` : ""} under ${citeRule(r)}.`),
        `Take ${actionRef} only with that approval.`,
      ].join(" ");
    case "insufficient_information": {
      const labels = new Map(domain.features.map((f) => [f.id, f.label]));
      const missing = result.missingFeatures.map((id) => `${id} (${labels.get(id) ?? id})`).join(", ");
      return [
        `Insufficient information: ${matched.length === 1 ? "a rule" : "rules"} could block or require approval for ${actionRef}, but these case features are unknown: ${missing}.`,
        `Find them and call ${CHECK_ACTION_TOOL} again; do not proceed in the meantime.`,
        ...matched.map((r) => `Pending ${citeRule(r)}.`),
      ].join(" ");
    }
  }
}
