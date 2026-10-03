/**
 * The 10-second P8 demo (plan §7.9): a Claude agent, on an unseen held-out case, wants to approve
 * onboarding, calls the guardrail MCP server's `check_action`, is blocked, and reports the expert's
 * quote. The decision comes from the MCP server (deterministic), never from the model.
 *
 *   pnpm --filter @vashistha/web exec tsx ../../packages/mcp-guardrails/demo/agent-blocked.ts \
 *     --url http://127.0.0.1:4318 [--case NS-2026-0201] [--action approve] [--scripted]
 *
 * Env: ANTHROPIC_API_KEY (not needed with --scripted), MCP_BEARER_TOKEN (when the server requires it).
 * --scripted skips the model and makes the same MCP calls, so the server side can be verified
 * without credentials. It never prints model output it did not receive.
 */
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { caseFeatures, findKycCase } from "@vashistha/core/domains/kyc";
// The Anthropic SDK is a dependency of @vashistha/core, not of this package; reuse core's install
// instead of adding a second dependency for a demo script.
import Anthropic from "@anthropic-ai/sdk";
import { CHECK_ACTION_TOOL, CheckActionOutputSchema, type CheckActionOutput } from "../src";

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 6;

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:4318" },
    case: { type: "string", default: "NS-2026-0201" },
    action: { type: "string", default: "approve" },
    scripted: { type: "boolean", default: false },
  },
});

const log = (line = ""): void => console.info(line);

const ToolCallResultSchema = z.object({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
});
type CheckCall = { texts: string[]; isError: boolean; output: CheckActionOutput | undefined };

async function callCheckAction(mcp: Client, input: unknown): Promise<CheckCall> {
  const raw = await mcp.callTool({ name: CHECK_ACTION_TOOL, arguments: z.record(z.string(), z.unknown()).parse(input) });
  const result = ToolCallResultSchema.parse(raw);
  const texts = result.content.flatMap((c) => (c.type === "text" && c.text !== undefined ? [c.text] : []));
  const isError = result.isError === true;
  return { texts, isError, output: isError ? undefined : CheckActionOutputSchema.parse(result.structuredContent) };
}

function logCheck(input: unknown, call: CheckCall): void {
  log(`  → ${CHECK_ACTION_TOOL} ${JSON.stringify(input)}`);
  if (call.output === undefined) log(`  ← tool error: ${call.texts.join(" ")}`);
  else log(`  ← ${call.output.decision} (rulebook revision ${call.output.rulebookRevision}): ${call.output.explanation}`);
}

async function runScripted(mcp: Client, input: { context: { case: object }; proposedAction: string }): Promise<CheckCall[]> {
  log(`[scripted: no model] the agent proposes "${input.proposedAction}" and checks it first`);
  const call = await callCheckAction(mcp, input);
  logCheck(input, call);
  return [call];
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** The MCP tool, offered to Claude as a client tool whose calls are proxied to the MCP server. */
function claudeTool(tool: McpTool): Anthropic.Beta.BetaTool {
  // `$schema` (draft-07) is MCP metadata, not part of the tool's input contract.
  const { required, $schema: _draft, ...schema } = tool.inputSchema;
  return {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: required === undefined ? schema : { ...schema, required },
  };
}

async function runClaude(mcp: Client, tool: McpTool, prompt: string): Promise<CheckCall[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey.trim() === "") throw new Error("ANTHROPIC_API_KEY is not set (use --scripted to run without the model)");
  const anthropic = new Anthropic({ apiKey, logLevel: "warn" });
  const system = [
    "You are an onboarding review agent at Northstar Bank, a fictional bank; every case is synthetic.",
    `Before you commit any review outcome you must call ${CHECK_ACTION_TOOL} with the case's decision features and the outcome you intend. Never commit an outcome it has not allowed.`,
    "End with one line that starts with COMMITTED: and the outcome, or BLOCKED: and the reason, quoting the expert's words from the tool result exactly.",
  ].join("\n");
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const calls: CheckCall[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 8_000,
      system,
      messages,
      tools: [claudeTool(tool)],
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens")
      throw new Error(`the model stopped with ${response.stop_reason}`);
    for (const block of response.content) if (block.type === "text") log(`Claude (${response.model}): ${block.text}`);
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return calls;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name !== tool.name) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `unknown tool ${use.name}` });
        continue;
      }
      const call = await callCheckAction(mcp, use.input);
      logCheck(use.input, call);
      calls.push(call);
      results.push({ type: "tool_result", tool_use_id: use.id, is_error: call.isError, content: call.texts.map((text) => ({ type: "text", text })) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`no final answer after ${MAX_TURNS} turns`);
}

async function main(): Promise<number> {
  const kycCase = findKycCase(args.case);
  if (kycCase === undefined) throw new Error(`unknown case ${args.case}`);
  const features = caseFeatures(kycCase);

  const endpoint = new URL(`${args.url.replace(/\/+$/, "")}/mcp`);
  const token = process.env.MCP_BEARER_TOKEN;
  const mcp = new Client({ name: "vashistha-agent-demo", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    endpoint,
    token === undefined || token === "" ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await mcp.connect(transport as Transport);
  try {
    const { tools } = await mcp.listTools();
    const tool = tools.find((t) => t.name === CHECK_ACTION_TOOL);
    if (tool === undefined) throw new Error(`${endpoint.href} does not offer ${CHECK_ACTION_TOOL}`);
    log(`MCP server ${endpoint.href}: tools [${tools.map((t) => t.name).join(", ")}]`);
    log(`Case ${kycCase.id} (${kycCase.set}): ${kycCase.customer.name}, ${kycCase.customer.entityType} in ${kycCase.customer.country}`);
    log();

    const prompt = [
      `Case ${kycCase.id} as shown in CaseDesk:`,
      "```json",
      JSON.stringify(kycCase, null, 2),
      "```",
      "Decision features CaseDesk derived from it (pass these as context.case):",
      "```json",
      JSON.stringify(features, null, 2),
      "```",
      `The relationship manager asks you to commit the outcome "${args.action}" today.`,
    ].join("\n");
    const calls = args.scripted
      ? await runScripted(mcp, { context: { case: features }, proposedAction: args.action })
      : await runClaude(mcp, tool, prompt);

    // The verdict is read from the MCP server's structured results, not from the model's words.
    const blocking = calls.flatMap((c) => (c.output?.decision === "forbid" ? [c.output] : []));
    log();
    if (calls.length === 0) {
      log(`RESULT: the agent never called ${CHECK_ACTION_TOOL}.`);
      return 1;
    }
    const [first] = blocking;
    if (first === undefined) {
      log(`RESULT: not blocked; decisions: ${calls.map((c) => c.output?.decision ?? "tool error").join(", ")}.`);
      return 1;
    }
    log(`RESULT: blocked by ${first.matchedRules.join(", ")}. Expert quote: "${first.evidence[0]?.exactQuote ?? ""}"`);
    return 0;
  } finally {
    await mcp.close();
  }
}

main().then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
