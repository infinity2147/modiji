/**
 * Teach-back (plan §7.5 #4): the apprentice reads back what it learned, FROM CONFIRMED RULES ONLY,
 * in at most 600 characters (≈90 words, well under 60 s spoken; it is queued as a `teach_back`
 * question, whose text is capped at 600 characters). Opus (CLAUDE_MODELS.prose) writes the prose when
 * available; the prompt carries nothing but the confirmed rules in plain language and the expert's
 * quotes — no candidates, no hypotheses, no oracle. Without a model, or when its output breaks the
 * bounds, a deterministic template is used and labelled as such. Either way the text is
 * non-authoritative: the rules are what the expert confirms.
 */
import "server-only";
import { supportingQuotes, type ConfirmedRule } from "@vashistha/core";
import type { Claude, ClaudeModel } from "@vashistha/core/server";
import { DOMAIN } from "./state";
import { ruleText } from "./text";

export const TEACHBACK_MAX_CHARS = 600;
const CLOSING = "Did I get that right?";
const DEADLINE_MS = 45_000;
/** Opus 5.5 always thinks; the budget covers thinking plus ~100 words of prose. */
const MAX_TOKENS = 4_000;

export const TEACHBACK_SYSTEM = `You are an apprentice reading back to an expert reviewer, out loud, the decision rules you
learned from them, so they can confirm or correct you.

Rules:
- Use ONLY the confirmed rules given. Do not add conditions, thresholds, exceptions, examples or advice.
- Keep every threshold and value exactly as given.
- Speak to the expert in the first person ("I learned that…"), plainly, as one short paragraph.
- At most 90 words and ${TEACHBACK_MAX_CHARS} characters. End with: "${CLOSING}"`;

/** One line per confirmed rule: condition, effect and the expert's own words. Nothing else enters the prompt. */
export function renderRulesForPrompt(rules: readonly ConfirmedRule[]): string {
  return rules
    .map((r, i) => {
      const { when, then } = ruleText(DOMAIN, r);
      const quote = supportingQuotes(r)[0]?.exactQuote;
      return `${i + 1}. When ${when}: ${then}.${quote === undefined ? "" : ` (Expert: "${quote}")`}`;
    })
    .join("\n");
}

export function teachBackPrompt(rules: readonly ConfirmedRule[]): { system: string; user: string } {
  return { system: TEACHBACK_SYSTEM, user: `<confirmed_rules>\n${renderRulesForPrompt(rules)}\n</confirmed_rules>` };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The deterministic teach-back: one sentence per rule (highest priority first), cut to fit with an honest "and N more". */
export function templateTeachBack(rules: readonly ConfirmedRule[]): string {
  const sentences = [...rules]
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1))
    .map((r) => {
      const { when, then } = ruleText(DOMAIN, r);
      return `When ${when}, ${then}.`;
    });
  const head = "Here is what I learned.";
  for (let n = sentences.length; n >= 0; n--) {
    const rest = sentences.length - n;
    const more = rest === 0 ? "" : ` And ${rest} more rule${rest === 1 ? "" : "s"}, shown on screen.`;
    const text = [head, ...sentences.slice(0, n)].join(" ") + more + ` ${CLOSING}`;
    if (text.length <= TEACHBACK_MAX_CHARS) return text;
  }
  return `${head} ${sentences.length} rules, shown on screen. ${CLOSING}`;
}

export type TeachBackText = { text: string; origin: "llm" | "template"; note?: string };

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`teach-back prose did not arrive within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function writeTeachBack(claude: Claude | null, model: ClaudeModel, rules: readonly ConfirmedRule[]): Promise<TeachBackText> {
  if (claude === null) return { text: templateTeachBack(rules), origin: "template", note: "LLM unavailable" };
  const prompt = teachBackPrompt(rules);
  try {
    const { text } = await withDeadline(
      claude.text({ model, system: prompt.system, messages: [{ role: "user", content: prompt.user }], maxTokens: MAX_TOKENS }),
      DEADLINE_MS,
    );
    const prose = text.replace(/\s+/g, " ").trim();
    if (prose !== "" && prose.length <= TEACHBACK_MAX_CHARS) return { text: capitalize(prose), origin: "llm" };
    return { text: templateTeachBack(rules), origin: "template", note: `model prose rejected (${prose.length} characters)` };
  } catch (error) {
    return { text: templateTeachBack(rules), origin: "template", note: `model call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
