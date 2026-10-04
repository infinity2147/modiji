/**
 * The interview's model calls (plan §5: Sonnet 5.5 for answer parsing, concept proposals and question
 * phrasing; §7.11: utterance translation and questions in the expert's language), built only from the
 * engine's prompt builders and output schemas. The model only proposes: every output goes through the
 * engine's code-side conversion (`toParsedAnswer`, `toProposedConcepts`, `acceptRephrase`,
 * `toVerifiedTranslation`, `acceptLocalized`) before anything uses it. `runtime.claude` refuses any prompt
 * carrying an oracle marker. Each call is bounded by a deadline; a late or failed call is reported to
 * the caller, never replaced by a made-up result.
 */
import "server-only";
import {
  LlmAnswerSchema,
  LlmConceptProposalSchema,
  LlmLocalizedQuestionSchema,
  LlmRephraseSchema,
  LlmTranslationSchema,
  acceptLocalized,
  acceptRephrase,
  buildAnswerParserPrompt,
  buildConceptProposerPrompt,
  buildLocalizePrompt,
  buildRephrasePrompt,
  buildTranslationPrompt,
  formatValue,
  promptDomain,
  requiredPhrases,
  summarizeCandidates,
  toParsedAnswer,
  toProposedConcepts,
  toVerifiedTranslation,
  type AnswerConversion,
  type AnsweredUtterance,
  type BuiltPrompt,
  type ConceptConversion,
  type DomainConfig,
  type ExpertLanguage,
  type HypothesisSet,
  type ProposedConcept,
  type Question,
  type RephraseDecision,
  type TranscriptLine,
  type VerifiedTranslation,
} from "@vashistha/core";
import type { CLAUDE_MODELS, Claude } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import type { z } from "zod";
import type { DecisionRecord } from "./engine-state";

/**
 * `CLAUDE_MODELS.reasoning`, checked against it at compile time: a value import of
 * `@vashistha/core/server` would pull SQLite and the Anthropic SDK into Next's route bundles.
 */
export const REASONING_MODEL = "claude-sonnet-5-5" satisfies (typeof CLAUDE_MODELS)["reasoning"];
const PROMPT_DOMAIN = promptDomain(KYC_DOMAIN);
/** Candidates the parser sees (the heaviest; ids outside the set are ignored by `applyAnswer` anyway). */
const PARSER_CANDIDATES = 12;
const DEADLINE_MS = { parse: 20_000, concepts: 20_000, rephrase: 5_000, translate: 15_000, localize: 8_000 } as const;

class LlmDeadlineError extends Error {
  override readonly name: string = "LlmDeadlineError";
}

async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmDeadlineError(`${what} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function ask<S extends z.ZodType>(claude: Claude, prompt: BuiltPrompt, schema: S, maxTokens: number, deadlineMs: number, what: string): Promise<z.infer<S>> {
  const result = await withDeadline(
    claude.structured({
      model: REASONING_MODEL,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      maxTokens,
      cacheSystem: true,
      schema,
    }),
    deadlineMs,
    what,
  );
  return result.output;
}

export async function parseAnswer(
  claude: Claude,
  input: {
    decisionFamily: string;
    question: Question;
    utterance: AnsweredUtterance;
    set: HypothesisSet;
    /** The session's feature model: stated rules may use the concepts the expert confirmed. */
    domain: DomainConfig;
    pendingConcepts: readonly ProposedConcept[];
  },
): Promise<AnswerConversion> {
  const prompt = buildAnswerParserPrompt({
    domain: promptDomain(input.domain),
    decisionFamily: input.decisionFamily,
    question: { id: input.question.id, kind: input.question.kind, text: input.question.text },
    utterance: input.utterance,
    candidates: summarizeCandidates(input.set, input.domain, PARSER_CANDIDATES),
  });
  const output = await ask(claude, prompt, LlmAnswerSchema, 2048, DEADLINE_MS.parse, "answer parser");
  return toParsedAnswer(output, {
    questionId: input.question.id,
    utterance: input.utterance,
    domain: input.domain,
    pendingConcepts: input.pendingConcepts.map((c) => c.name),
  });
}

export async function proposeConcepts(
  claude: Claude,
  input: { transcript: readonly TranscriptLine[]; unexplained: readonly DecisionRecord[]; pendingConcepts: readonly ProposedConcept[] },
): Promise<ConceptConversion> {
  const pendingConcepts = input.pendingConcepts.map((c) => c.name);
  const prompt = buildConceptProposerPrompt({
    domain: PROMPT_DOMAIN,
    transcript: input.transcript,
    unexplained: input.unexplained.map((d) => ({
      caseId: d.caseId,
      action: d.recent.observation.action,
      visibleFeatures: Object.fromEntries(
        KYC_DOMAIN.features.flatMap((f) => {
          const v = d.features[f.id];
          return v === undefined ? [] : [[f.id, formatValue(f, v)]];
        }),
      ),
    })),
    pendingConcepts,
  });
  const output = await ask(claude, prompt, LlmConceptProposalSchema, 1024, DEADLINE_MS.concepts, "concept proposer");
  return toProposedConcepts(output, { domain: KYC_DOMAIN, transcript: input.transcript, pendingConcepts });
}

/** Sonnet may reword a question within ≤25 words; `acceptRephrase` keeps the template unless the target is intact. */
export async function rephraseQuestion(claude: Claude, question: Question): Promise<RephraseDecision> {
  const prompt = buildRephrasePrompt({
    domain: PROMPT_DOMAIN,
    question: { kind: question.kind, text: question.text },
    targetFeature: question.target.feature ?? null,
    mustKeep: requiredPhrases(question, KYC_DOMAIN),
  });
  const output = await ask(claude, prompt, LlmRephraseSchema, 256, DEADLINE_MS.rephrase, "question rephraser");
  return acceptRephrase(question, output, KYC_DOMAIN);
}

/**
 * English translation of a non-English utterance, verified by `toVerifiedTranslation` (verbatim,
 * in-order segments covering every word). A rejected translation is reported, never stored.
 */
export async function translateUtterance(claude: Claude, input: { text: string; language: ExpertLanguage }): Promise<VerifiedTranslation> {
  const output = await ask(claude, buildTranslationPrompt(input), LlmTranslationSchema, 4096, DEADLINE_MS.translate, "utterance translator");
  return toVerifiedTranslation(output, input.text);
}

/**
 * The question in the expert's language (plan §7.11), for the interview's live questions and the
 * two-expert disagreement questions: `text` becomes the accepted translation, `textEnglish` the
 * English original. Never throws: without a model, for English, for an already-localized question, or
 * when the translation fails or is rejected by `acceptLocalized`, the English question is returned
 * unchanged (it is spoken as is).
 */
export async function localizeQuestion(
  claude: Claude | null,
  question: Question,
  language: ExpertLanguage,
  log?: Pick<Console, "info" | "warn">,
): Promise<Question> {
  if (claude === null || language === "en" || question.language !== undefined) return question;
  try {
    const prompt = buildLocalizePrompt({ question, language });
    const output = await ask(claude, prompt, LlmLocalizedQuestionSchema, 512, DEADLINE_MS.localize, "question localizer");
    const decision = acceptLocalized(question, output, language);
    if (decision.accepted) return decision.question;
    log?.info(`[interview] question ${question.id} kept in English: ${decision.reason}`);
  } catch (error) {
    log?.warn(`[interview] localizing question ${question.id} failed; kept in English: ${error instanceof Error ? error.message : String(error)}`);
  }
  return question;
}
