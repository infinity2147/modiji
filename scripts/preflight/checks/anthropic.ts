import { CLAUDE_MODELS, type ClaudeModel, type TextResult } from "../../../packages/core/src/server/claude";
import { UnknownSchema } from "../../../packages/core/src/schemas/primitives";
import { describeError, requireVars } from "../http";
import type { CheckOutcome, Facts, PreflightContext } from "../types";

/** Opus 5.5 and Sonnet 5.5 run adaptive thinking when it is not configured, and thinking counts against max_tokens. */
const LIVENESS_MAX_TOKENS = 512;
const STRUCTURED_MAX_TOKENS = 256;

type Usage = TextResult["usage"];

function usageFacts(usage: Usage): Facts {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function usageLine(model: ClaudeModel, latencyMs: number, usage: Usage): string {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return `${model} ${Math.round(latencyMs)} ms (in ${usage.input_tokens}/out ${usage.output_tokens}, cache r${cacheRead}/w${cacheWrite})`;
}

/**
 * One real structured-output call on the frame-events model, validated by the app's own zod schema (`UnknownSchema`,
 * a strict object with a literal and an enum), and a minimal text call on each of the other two routed models.
 */
export async function checkAnthropic(ctx: Pick<PreflightContext, "env" | "createClaude">): Promise<CheckOutcome> {
  const { ANTHROPIC_API_KEY } = requireVars(ctx.env, ["ANTHROPIC_API_KEY"]);
  const claude = ctx.createClaude(ANTHROPIC_API_KEY);

  const structured = claude
    .structured({
      model: CLAUDE_MODELS.frameEvents,
      system: "You label why a feature value is missing from a decision context. Answer only with the requested JSON.",
      messages: [
        {
          role: "user",
          content:
            "The field 'beneficial owner percentage' could not be read because it was scrolled out of view, so it was not visible on screen. Return the Unknown record with the matching reason.",
        },
      ],
      maxTokens: STRUCTURED_MAX_TOKENS,
      schema: UnknownSchema,
    })
    .then((r) => ({ ok: true as const, r }), (error: unknown) => ({ ok: false as const, error }));

  const liveness = [CLAUDE_MODELS.reasoning, CLAUDE_MODELS.prose].map((model) =>
    claude
      .text({
        model,
        system: "Preflight liveness check.",
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        maxTokens: LIVENESS_MAX_TOKENS,
      })
      .then((r) => ({ model, ok: true as const, r }), (error: unknown) => ({ model, ok: false as const, error })),
  );

  const [s, ...texts] = await Promise.all([structured, ...liveness]);
  const problems: string[] = [];
  const lines: string[] = [];
  const facts: Facts = {};

  if (s.ok) {
    lines.push(`structured ${usageLine(CLAUDE_MODELS.frameEvents, s.r.latencyMs, s.r.usage)} → reason=${s.r.output.reason}`);
    facts.structured = {
      model: CLAUDE_MODELS.frameEvents,
      latencyMs: Math.round(s.r.latencyMs),
      stopReason: s.r.stopReason,
      output: { unknown: s.r.output.unknown, reason: s.r.output.reason },
      usage: usageFacts(s.r.usage),
    };
  } else {
    problems.push(`structured output on ${CLAUDE_MODELS.frameEvents}: ${describeError(s.error)}`);
  }
  for (const t of texts) {
    if (t.ok) {
      lines.push(usageLine(t.model, t.r.latencyMs, t.r.usage));
      facts[t.model] = { latencyMs: Math.round(t.r.latencyMs), usage: usageFacts(t.r.usage) };
    } else {
      problems.push(`${t.model}: ${describeError(t.error)}`);
    }
  }
  if (problems.length > 0) return { status: "fail", detail: [...problems, ...lines].join("; "), facts };
  return { status: "pass", detail: lines.join("; "), facts };
}
