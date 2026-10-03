import { z } from "zod";
import type { DomainConfig } from "../../schemas/domain";
import { ProposedConceptSchema, type ProposedConcept } from "../../schemas/engine";
import { containsQuote, findFeature } from "../describe";
import { renderDomain, renderTranscript, type BuiltPrompt, type PromptDomain, type TranscriptLine } from "./inputs";

/** Structured output of the concept proposer (Sonnet 5.5). Flat and strict; `values` is [] unless type is enum. */
export const LlmConceptSchema = z.strictObject({
  name: z.string().describe("New camelCase identifier, letter first, letters/digits/underscore only"),
  label: z.string().describe("Short human label"),
  definition: z.string().describe("What the expert seems to mean, in one sentence"),
  type: z.enum(["boolean", "number", "enum"]),
  values: z.array(z.string()).describe("Enum values; [] for boolean and number"),
  evidenceQuote: z.string().describe("The expert's exact words that use the concept, copied verbatim from the transcript"),
});
export const LlmConceptProposalSchema = z.strictObject({ concepts: z.array(LlmConceptSchema) });
export type LlmConceptProposal = z.infer<typeof LlmConceptProposalSchema>;

export const CONCEPT_PROPOSER_SYSTEM = `You help an apprentice system learn how an expert makes back-office decisions.
The system models decisions with a fixed, typed feature list (given below). Your only job: notice
concepts the expert relies on that the feature list does NOT have (latent concepts such as
"relationship age with the supplier" or "missing asset number"), and propose them as candidate features.

Rules:
- Propose a concept only if the expert's own words use it. Copy those words verbatim into evidenceQuote.
- Never propose something an existing feature already captures, even under another name.
- Never invent decision rules, thresholds or outcomes. Do not judge whether the expert is right.
- Use type "boolean" for yes/no properties, "number" for quantities, "enum" for a small closed set (list values).
- Return an empty list when there is nothing new. Fewer, well-grounded concepts beat many guesses.
Your proposals are shown to the expert, who confirms or rejects each one; nothing you return is applied automatically.`;

/** A decision the hypotheses cannot explain, as shown on screen. */
export type UnexplainedDecision = { caseId: string; action: string; visibleFeatures: Record<string, string> };

export function buildConceptProposerPrompt(input: {
  domain: PromptDomain;
  transcript: readonly TranscriptLine[];
  unexplained: readonly UnexplainedDecision[];
  /** Concepts already awaiting confirmation (do not propose again). */
  pendingConcepts: readonly string[];
}): BuiltPrompt {
  const decisions = input.unexplained.map(
    (d) => `- case ${d.caseId}: ${d.action}; on screen: ${Object.entries(d.visibleFeatures).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
  return {
    system: `${CONCEPT_PROPOSER_SYSTEM}\n\n${renderDomain(input.domain)}`,
    user: [
      "<transcript>",
      renderTranscript(input.transcript),
      "</transcript>",
      "<unexplained_decisions>",
      ...decisions,
      "</unexplained_decisions>",
      `<pending_concepts>${input.pendingConcepts.join(", ")}</pending_concepts>`,
      "Propose new concepts, if any.",
    ].join("\n"),
  };
}

export type ConceptConversion = { concepts: ProposedConcept[]; rejected: { name: string; reason: string }[] };

/**
 * Code-side validation of the proposer's output: identifier syntax, not an existing feature, not
 * already pending, enum values present (≥2), and the quote verbatim in the transcript. Rejections
 * carry reasons; nothing is dropped silently.
 */
export function toProposedConcepts(
  output: LlmConceptProposal,
  ctx: { domain: DomainConfig; transcript: readonly TranscriptLine[]; pendingConcepts: readonly string[] },
): ConceptConversion {
  const expertText = ctx.transcript.filter((l) => l.speaker === "expert").map((l) => l.text).join("\n");
  const out: ConceptConversion = { concepts: [], rejected: [] };
  for (const c of output.concepts) {
    const reject = (reason: string): void => void out.rejected.push({ name: c.name, reason });
    if (findFeature(ctx.domain, c.name) !== undefined) reject("already a feature of the domain");
    else if (ctx.pendingConcepts.includes(c.name) || out.concepts.some((x) => x.name === c.name)) reject("already proposed");
    else if (c.type === "enum" && new Set(c.values).size < 2) reject("an enum concept needs at least two values");
    else if (!containsQuote(expertText, c.evidenceQuote)) reject("evidence quote is not verbatim in the expert's words");
    else {
      const parsed = ProposedConceptSchema.safeParse({
        name: c.name,
        label: c.label,
        definition: c.definition,
        type: c.type,
        ...(c.type === "enum" && { values: [...new Set(c.values)] }),
        exactQuote: c.evidenceQuote,
      });
      if (parsed.success) out.concepts.push(parsed.data);
      else reject(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
  }
  return out;
}
