/**
 * ElevenLabs Procedure export (plan §7.6, sponsor export; api-notes §6). A deterministic compiler
 * from confirmed rules to Procedure content: per rule, *when* (the predicate in plain language),
 * *then* (the effect) and *why* (the expert's exact quote with attribution). The content embeds the
 * same rules as a machine-readable JSON block, and `parseProcedure` recovers them from it, which is
 * how the export is round-trip validated against the source rules.
 */
import { z } from "zod";
import {
  IdSchema,
  PredicateSchema,
  RuleEffectSchema,
  RuleKindSchema,
  SymbolIdSchema,
  type ConfirmedRule,
  type DomainConfig,
  type RuleEffect,
} from "@vashistha/core";
import { formatClock } from "../cite";
import { inline, renderPredicate } from "./render-predicate";

/** ElevenLabs caps Procedure content at 50,000 characters (api-notes §6). */
export const PROCEDURE_CONTENT_LIMIT = 50_000;
export const PROCEDURE_RULES_FORMAT = "vashistha.procedure-rules/1";

/** The decision-relevant part of a confirmed rule, as embedded in the Procedure. */
export const ProcedureRuleSchema = z.strictObject({
  id: IdSchema,
  decisionFamily: SymbolIdSchema,
  kind: RuleKindSchema,
  predicate: PredicateSchema,
  effect: RuleEffectSchema,
  priority: z.int(),
  overrides: z.array(IdSchema),
});
export type ProcedureRule = z.infer<typeof ProcedureRuleSchema>;

const ProcedureRulesBlockSchema = z.strictObject({
  format: z.literal(PROCEDURE_RULES_FORMAT),
  domainId: SymbolIdSchema,
  rulebookRevision: z.int().nonnegative(),
  rules: z.array(ProcedureRuleSchema),
});
export type ProcedureRules = z.infer<typeof ProcedureRulesBlockSchema>;

export class ProcedureError extends Error {
  override readonly name: string = "ProcedureError";
}

export function procedureRule(rule: ConfirmedRule): ProcedureRule {
  const { id, decisionFamily, kind, predicate, effect, priority, overrides } = rule;
  return { id, decisionFamily, kind, predicate, effect, priority, overrides };
}

/** Domain family order, then priority (highest first), then id: independent of the input order. */
function ordered(rules: readonly ConfirmedRule[], domain: DomainConfig): ConfirmedRule[] {
  const familyIndex = new Map(domain.decisionFamilies.map((f, i) => [f.id, i]));
  const family = (r: ConfirmedRule): number => familyIndex.get(r.decisionFamily) ?? Number.MAX_SAFE_INTEGER;
  return [...rules].sort((a, b) => family(a) - family(b) || b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function actionRef(domain: DomainConfig, actionId: string): string {
  const label = domain.actions.find((a) => a.id === actionId)?.label;
  return label === undefined ? `"${actionId}"` : `"${inline(label)}" (${actionId})`;
}

function renderEffect(effect: RuleEffect, familyLabel: string, domain: DomainConfig): string {
  switch (effect.type) {
    case "forbid":
      return `Do not take the action ${actionRef(domain, effect.action)}.`;
    case "require_approval":
      return `Any "${familyLabel}" decision needs approval from a ${inline(effect.role)} before it is committed.`;
    case "recommend":
      return `The expected action is ${actionRef(domain, effect.action)}.`;
    case "route":
      return `Route the case to ${inline(effect.destination)}.`;
  }
}

function renderRule(rule: ConfirmedRule, domain: DomainConfig): string[] {
  const familyLabel = inline(domain.decisionFamilies.find((f) => f.id === rule.decisionFamily)?.label ?? rule.decisionFamily);
  const quote = rule.evidence[0];
  return [
    `### Rule ${inline(rule.id)} (${rule.kind})`,
    "",
    `- **When:** ${renderPredicate(rule.predicate, domain)}`,
    `- **Then:** ${renderEffect(rule.effect, familyLabel, domain)}`,
    ...(rule.overrides.length === 0
      ? []
      : [`- **Overrides:** when this rule applies, rule${rule.overrides.length === 1 ? "" : "s"} ${rule.overrides.map(inline).join(", ")} do${rule.overrides.length === 1 ? "es" : ""} not.`]),
    `- **Why:** the expert (${inline(rule.expertId)}, ${formatClock(quote.t0Ms)}–${formatClock(quote.t1Ms)}) said:`,
    "",
    // Every quote line is blockquoted, so no quote can open or close the fenced block below.
    ...quote.exactQuote.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)),
    "",
  ];
}

function rulesBlock(block: ProcedureRules): string {
  const rules = block.rules.map((r) => JSON.stringify(r)).join(",\n");
  const head = JSON.stringify({ format: block.format, domainId: block.domainId, rulebookRevision: block.rulebookRevision });
  return `${head.slice(0, -1)},"rules":[${rules === "" ? "" : `\n${rules}\n`}]}`;
}

export type CompileProcedureInput = { domain: DomainConfig; rules: readonly ConfirmedRule[]; revision: number };

/** Markdown Procedure content. Throws `ProcedureError` above `PROCEDURE_CONTENT_LIMIT` characters. */
export function compileProcedure({ domain, rules, revision }: CompileProcedureInput): string {
  const sorted = ordered(rules, domain);
  const sections = domain.decisionFamilies.flatMap((family) => {
    const inFamily = sorted.filter((r) => r.decisionFamily === family.id);
    return inFamily.length === 0 ? [] : [`## ${inline(family.label)}`, "", ...inFamily.flatMap((r) => renderRule(r, domain))];
  });
  const block: ProcedureRules = {
    format: PROCEDURE_RULES_FORMAT,
    domainId: domain.id,
    rulebookRevision: revision,
    rules: sorted.map(procedureRule),
  };
  const content = [
    `# ${inline(domain.title)}: confirmed rules`,
    "",
    `Rulebook revision ${revision}. Compiled by code from rules a human expert confirmed. Each rule quotes the expert's own words. Do not edit by hand; export again instead.`,
    "",
    "Before you confirm any action on a case, check every rule below. When a rule's condition holds, follow its instruction and tell the user the expert's quote. When a condition depends on information you do not have, ask for it before acting. Never assume it.",
    "",
    ...(sections.length === 0 ? ["No confirmed rules yet.", ""] : sections),
    "## Machine-readable copy",
    "",
    "The same rules as data, generated together with the text above. Used to validate this export.",
    "",
    "```json",
    rulesBlock(block),
    "```",
    "",
  ].join("\n");
  if (content.length > PROCEDURE_CONTENT_LIMIT)
    throw new ProcedureError(`procedure content is ${content.length} characters; the ElevenLabs limit is ${PROCEDURE_CONTENT_LIMIT}`);
  return content;
}

const FENCED_JSON = /^```json\n([\s\S]*?)\n```$/gm;

/** Recovers the rules embedded by `compileProcedure`. Throws `ProcedureError`, or a ZodError for an invalid block. */
export function parseProcedure(content: string): ProcedureRules {
  const blocks = [...content.matchAll(FENCED_JSON)];
  const [only] = blocks;
  if (blocks.length !== 1 || only?.[1] === undefined)
    throw new ProcedureError(`expected exactly one fenced json block, found ${blocks.length}`);
  let json: unknown;
  try {
    json = JSON.parse(only[1]);
  } catch {
    throw new ProcedureError("the rules block is not valid JSON");
  }
  return ProcedureRulesBlockSchema.parse(json);
}

// --- Publishing (api-notes §6) -------------------------------------------------------------------

export type ProcedureDraft = { name: string; content: string; type: "free_form"; trigger?: string };

/** The three ElevenLabs calls publishing needs; `createElevenLabsProcedureApi` implements them over fetch. */
export type ProcedureApi = {
  createProcedure(agentId: string, branchId: string, body: Pick<ProcedureDraft, "name" | "type" | "trigger">): Promise<{ procedureId: string }>;
  updateProcedureDraft(agentId: string, branchId: string, procedureId: string, body: ProcedureDraft): Promise<void>;
  /** `PATCH /v1/convai/agents/{id}?branch_id=…` without `procedures`, which publishes every pending draft on the branch. */
  publish(agentId: string, branchId: string, versionDescription: string): Promise<void>;
};

export type PublishProcedureInput = {
  client: ProcedureApi;
  agentId: string;
  branchId: string;
  name: string;
  content: string;
  /** When the agent should use the procedure; omitted, ElevenLabs derives it from the content. */
  trigger?: string;
  /** Update this existing procedure instead of creating one. */
  procedureId?: string;
};

/** Create (unless `procedureId` is given) → write the draft (name, content and type, every time) → publish the branch. */
export async function publishProcedure(input: PublishProcedureInput): Promise<{ procedureId: string }> {
  if (input.content.length > PROCEDURE_CONTENT_LIMIT)
    throw new ProcedureError(`procedure content is ${input.content.length} characters; the ElevenLabs limit is ${PROCEDURE_CONTENT_LIMIT}`);
  const trigger = input.trigger === undefined ? {} : { trigger: input.trigger };
  const { client, agentId, branchId, name } = input;
  const procedureId =
    input.procedureId ?? (await client.createProcedure(agentId, branchId, { name, type: "free_form", ...trigger })).procedureId;
  await client.updateProcedureDraft(agentId, branchId, procedureId, { name, content: input.content, type: "free_form", ...trigger });
  await client.publish(agentId, branchId, `Publish procedure "${name}" (${procedureId})`);
  return { procedureId };
}

export type ElevenLabsProcedureApiOptions = { apiKey: string; baseUrl?: string; fetch?: typeof globalThis.fetch };

const CreateProcedureResponseSchema = z.object({ procedure_id: z.string().min(1) });
const ERROR_DETAIL_LIMIT = 300;

export function createElevenLabsProcedureApi(options: ElevenLabsProcedureApiOptions): ProcedureApi {
  if (options.apiKey.trim() === "") throw new TypeError("apiKey is empty");
  const baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const seg = encodeURIComponent;
  const procedures = (agentId: string, branchId: string): string => `/v1/convai/agents/${seg(agentId)}/branches/${seg(branchId)}/procedures`;

  async function call(method: "POST" | "PATCH", path: string, body: object): Promise<string> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new ProcedureError(`ElevenLabs ${method} ${path} failed (HTTP ${response.status}): ${text.slice(0, ERROR_DETAIL_LIMIT)}`);
    return text;
  }

  return {
    async createProcedure(agentId, branchId, body) {
      const parsed = CreateProcedureResponseSchema.parse(JSON.parse(await call("POST", procedures(agentId, branchId), body)));
      return { procedureId: parsed.procedure_id };
    },
    async updateProcedureDraft(agentId, branchId, procedureId, body) {
      await call("PATCH", `${procedures(agentId, branchId)}/${seg(procedureId)}/draft`, body);
    },
    async publish(agentId, branchId, versionDescription) {
      await call("PATCH", `/v1/convai/agents/${seg(agentId)}?branch_id=${seg(branchId)}`, { version_description: versionDescription });
    },
  };
}
