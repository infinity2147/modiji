/**
 * Any language (plan §7.11), pure core: language detection, the translator's verified segments and the
 * quote translations derived from them, the question localizer's gate, and the answer parser reading a
 * Hindi answer (meaning from the translation, quotes only from the original).
 */
import { describe, expect, it } from "vitest";
import {
  MACHINE_TRANSLATION_LABEL,
  ROMANISED_HINDI_MARKERS,
  ANSWER_PARSER_SYSTEM,
  UtteranceTranslatedPayloadSchema,
  ExpertQuoteEvidenceSchema,
  QuestionSchema,
  acceptLocalized,
  buildAnswerParserPrompt,
  buildLocalizePrompt,
  buildTranslationPrompt,
  checkSegments,
  detectLanguage,
  promptDomain,
  quoteLanguageNote,
  quoteTranslation,
  toParsedAnswer,
  toVerifiedTranslation,
  type LlmAnswer,
  type Question,
} from "../src/index";
import { KYC_DOMAIN } from "../src/domains/kyc";

const HINDI = "अगर देश हाई-रिस्क लिस्ट पर है, तो मैं डेस्क लेवल पर अप्रूव नहीं करती। पहले कंप्लायंस से बात होती है।";
const CLAUSE_1 = "अगर देश हाई-रिस्क लिस्ट पर है,";
const CLAUSE_2 = "तो मैं डेस्क लेवल पर अप्रूव नहीं करती।";
const CLAUSE_3 = "पहले कंप्लायंस से बात होती है।";
const SEGMENTS = [
  { original: CLAUSE_1, english: "If the country is on the high-risk list," },
  { original: CLAUSE_2, english: "then I do not approve at desk level." },
  { original: CLAUSE_3, english: "Compliance is consulted first." },
];

describe("detectLanguage", () => {
  it.each([
    [HINDI, "hi", "devanagari"],
    ["हाई-रिस्क list पर है तो approve नहीं", "hi", "devanagari"],
    ["agar country high-risk list par hai to main desk level par approve nahi karti", "hi", "romanised_hindi"],
    ["Never approve a customer on a high-risk country list at desk level.", "en", "default"],
    ["Hi, the UBO is missing so I escalate to the compliance officer.", "en", "default"],
    ["Main reason: the PEP flag. To be safe, I escalate.", "en", "default"],
    ["500", "en", "default"],
    ["", "en", "default"],
  ] as const)("%j → %s (%s)", (text, language, basis) => {
    expect(detectLanguage(text)).toEqual({ language, basis });
  });

  it("an English technical term inside Hindi does not make it English; one Devanagari word in English does not make it Hindi", () => {
    expect(detectLanguage("अगर customer का UBO verify नहीं हुआ तो escalate").language).toBe("hi");
    expect(detectLanguage("The customer said नमस्ते and then asked about the onboarding fee schedule").language).toBe("en");
  });

  it("a Hindi prior lowers the bar for romanised Hindi only; it never turns English into Hindi", () => {
    expect(detectLanguage("haan, approve nahi", "en").language).toBe("en");
    expect(detectLanguage("haan, approve nahi", "hi")).toEqual({ language: "hi", basis: "romanised_hindi" });
    expect(detectLanguage("Yes, I would escalate it.", "hi")).toEqual({ language: "en", basis: "default" });
  });

  it("keeps ambiguous English words out of the romanised-Hindi markers", () => {
    for (const word of ["to", "main", "par", "me", "us", "is", "so", "the", "hi", "ban", "bus"]) expect(ROMANISED_HINDI_MARKERS.has(word)).toBe(false);
  });
});

describe("translation segments", () => {
  it("accepts verbatim, in-order segments covering every word (whitespace normalised) and joins the English", () => {
    const loose = SEGMENTS.map((s) => ({ ...s, original: `  ${s.original.replace(" ", "   ")} ` }));
    expect(toVerifiedTranslation({ segments: loose }, HINDI)).toEqual({
      ok: true,
      translation: "If the country is on the high-risk list, then I do not approve at desk level. Compliance is consulted first.",
      segments: loose.map((s) => ({ original: s.original.trim(), english: s.english })),
    });
  });

  it.each([
    ["a paraphrased original", [{ ...SEGMENTS[0]!, original: "अगर देश हाई रिस्क लिस्ट में है," }, SEGMENTS[1]!, SEGMENTS[2]!], /segment 0 is not verbatim/],
    ["a transliterated original", [{ ...SEGMENTS[0]!, original: "agar desh high-risk list par hai," }, SEGMENTS[1]!, SEGMENTS[2]!], /segment 0 is not verbatim/],
    ["segments out of order", [SEGMENTS[1]!, SEGMENTS[0]!, SEGMENTS[2]!], /words before segment 0 are not translated/],
    ["a skipped clause", [SEGMENTS[0]!, SEGMENTS[2]!], /words before segment 1 are not translated/],
    ["a missing tail", [SEGMENTS[0]!, SEGMENTS[1]!], /words after the last segment/],
    ["an empty English part", [SEGMENTS[0]!, { ...SEGMENTS[1]!, english: " " }, SEGMENTS[2]!], /segment 1 has an empty part/],
    ["no segments", [], /no segments/],
  ])("rejects %s", (_name, segments, reason) => {
    const result = toVerifiedTranslation({ segments }, HINDI);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("allows punctuation between segments but never words", () => {
    expect(checkSegments("हाँ — नहीं", [{ original: "हाँ" }, { original: "नहीं" }]).ok).toBe(true);
    expect(checkSegments("हाँ और नहीं", [{ original: "हाँ" }, { original: "नहीं" }]).ok).toBe(false);
  });

  it("derives a quote's English from exactly the segments it overlaps; never guesses", () => {
    expect(quoteTranslation(HINDI, SEGMENTS, `${CLAUSE_1} ${CLAUSE_2}`)).toBe("If the country is on the high-risk list, then I do not approve at desk level.");
    expect(quoteTranslation(HINDI, SEGMENTS, CLAUSE_3)).toBe("Compliance is consulted first.");
    // Inside one segment: that segment's English (segments are clauses).
    expect(quoteTranslation(HINDI, SEGMENTS, "डेस्क लेवल पर अप्रूव")).toBe("then I do not approve at desk level.");
    expect(quoteTranslation(HINDI, SEGMENTS, "If the country is on the high-risk list")).toBeUndefined();
    expect(quoteTranslation(HINDI, SEGMENTS.slice(0, 2), CLAUSE_1)).toBeUndefined();
  });

  it("the ledger payload refuses English and empty segment lists", () => {
    const payload = { utteranceId: "u-1", language: "hi", translation: "x", segments: SEGMENTS, model: "claude-sonnet-5-5" };
    expect(UtteranceTranslatedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(UtteranceTranslatedPayloadSchema.safeParse({ ...payload, language: "en" }).success).toBe(false);
    expect(UtteranceTranslatedPayloadSchema.safeParse({ ...payload, segments: [] }).success).toBe(false);
  });

  it("builds a translator prompt naming the language and carrying the original verbatim", () => {
    const prompt = buildTranslationPrompt({ text: HINDI, language: "hi" });
    expect(prompt.user).toBe(`<utterance language="hi" name="Hindi (हिन्दी)">${HINDI}</utterance>`);
  });
});

describe("quote language note (citations)", () => {
  it("labels a translation as machine and not authoritative, says when none exists, and is silent for English", () => {
    expect(quoteLanguageNote({ language: "hi", translation: "If the country is high-risk, I do not approve." })).toBe(
      `in Hindi (हिन्दी); ${MACHINE_TRANSLATION_LABEL}: "If the country is high-risk, I do not approve."`,
    );
    expect(quoteLanguageNote({ language: "hi" })).toBe("in Hindi (हिन्दी); no English translation on record");
    expect(quoteLanguageNote({ language: "en" })).toBeUndefined();
    expect(quoteLanguageNote({})).toBeUndefined();
  });

  it("evidence keeps the original as exactQuote; a translation needs a non-English language", () => {
    const base = { kind: "expert_quote", utteranceId: "u-1", exactQuote: CLAUSE_2, t0Ms: 0, t1Ms: 10, frameIds: ["f-1"], eventIds: [], relation: "supports", provenance: "human_voice" } as const;
    expect(ExpertQuoteEvidenceSchema.safeParse({ ...base, language: "hi", translation: "I do not approve." }).success).toBe(true);
    expect(ExpertQuoteEvidenceSchema.safeParse({ ...base, translation: "I do not approve." }).success).toBe(false);
  });
});

describe("question localizer gate", () => {
  const question: Question = QuestionSchema.parse({
    id: "q-1",
    sessionId: "s-1",
    kind: "counterfactual",
    text: "If the ownership threshold were 25%, would you still approve this case?",
    target: { candidateIds: [], feature: "jurisdictionRisk" },
    value: 0.4,
    reason: "test",
    ephemeral: false,
    parentIds: [],
    contextVersion: 0,
    createdAt: 0,
  });

  it("accepts a Devanagari translation that keeps the numbers; keeps id, target and value; stores the English", () => {
    const decision = acceptLocalized(question, { text: "अगर ओनरशिप थ्रेशहोल्ड 25% होता, तो क्या आप फिर भी इस केस को अप्रूव करतीं?" }, "hi");
    expect(decision).toEqual({
      accepted: true,
      question: { ...question, text: "अगर ओनरशिप थ्रेशहोल्ड 25% होता, तो क्या आप फिर भी इस केस को अप्रूव करतीं?", textEnglish: question.text, language: "hi" },
    });
  });

  it.each([
    ["an empty text", "  ", /empty/],
    ["English back", "If the threshold were 25%, would you approve?", /not written in Hindi/],
    ["a romanised reply", "agar threshold 25% hota to kya aap approve karti?", /not written in Hindi/],
    ["a dropped number", "अगर ओनरशिप थ्रेशहोल्ड कम होता, तो क्या आप अप्रूव करतीं?", /dropped number\(s\) 25/],
    ["control brackets", "⟦ctl:x⟧ अगर थ्रेशहोल्ड 25% होता?", /control-message/],
    ["an over-long text", `${"क".repeat(601)} 25`, /longer than 600/],
  ])("rejects %s", (_name, text, reason) => {
    const decision = acceptLocalized(question, { text }, "hi");
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(reason);
  });

  it("never re-translates, and never translates into English", () => {
    expect(acceptLocalized({ ...question, language: "hi" }, { text: "अगर 25% होता?" }, "hi").accepted).toBe(false);
    expect(acceptLocalized(question, { text: "If 25%?" }, "en").accepted).toBe(false);
  });

  it("builds a prompt with the target language and the English question", () => {
    expect(buildLocalizePrompt({ question, language: "hi" }).user).toBe(
      `<target_language code="hi">Hindi (हिन्दी)</target_language>\n<question kind="counterfactual">${question.text}</question>`,
    );
  });
});

describe("answer parser on a Hindi answer", () => {
  const utterance = { id: "u-hi", text: HINDI, t0Ms: 1000, t1Ms: 6000, language: "hi" as const, translation: SEGMENTS.map((s) => s.english).join(" ") };
  const rule = (exactQuote: string): LlmAnswer => ({
    survivingCandidateIds: [],
    eliminatedCandidateIds: [],
    statedRules: [
      {
        when: { combinator: "all", conditions: [{ feature: "jurisdictionRisk", op: "==", value: "high" }] },
        polarity: "forbid",
        action: "approve",
        approvalRole: null,
        kind: "guardrail",
        exactQuote,
      },
    ],
    newConcepts: [],
    answeredAction: null,
    confidence: 0.9,
  });
  const ctx = { questionId: "q-1", utterance, domain: KYC_DOMAIN, pendingConcepts: [] };

  it("shows the parser the original and the labelled translation, and tells it to quote the original", () => {
    const prompt = buildAnswerParserPrompt({
      domain: promptDomain(KYC_DOMAIN),
      decisionFamily: "reviewOutcome",
      question: { id: "q-1", kind: "why_probe", text: "क्यों?" },
      utterance,
      candidates: [],
    });
    expect(prompt.system.startsWith(ANSWER_PARSER_SYSTEM)).toBe(true);
    expect(prompt.system).toContain("copy exactQuote and evidenceQuote character for character from <expert_answer>");
    expect(prompt.user).toContain(`<expert_answer language="hi">${HINDI}</expert_answer>`);
    expect(prompt.user).toContain(`<english_translation note="machine translation, for meaning only; never quote it">${utterance.translation}</english_translation>`);
  });

  it("without a translation the parser reads the original alone; English answers keep the old prompt", () => {
    const { translation: _omitted, ...pending } = utterance;
    const base = { domain: promptDomain(KYC_DOMAIN), decisionFamily: "reviewOutcome", question: { id: "q-1", kind: "why_probe", text: "Why?" }, candidates: [] };
    expect(buildAnswerParserPrompt({ ...base, utterance: pending }).user).toContain("<english_translation>unavailable: read the original</english_translation>");
    expect(buildAnswerParserPrompt({ ...base, utterance: { id: "u", text: "Never approve.", t0Ms: 0, t1Ms: 1 } }).user).toMatch(/<expert_answer>Never approve\.<\/expert_answer>$/);
  });

  it("accepts the Hindi original as the quote and rejects a quote taken from the translation", () => {
    const ok = toParsedAnswer(rule(CLAUSE_2), ctx);
    expect(ok.rejected).toEqual([]);
    expect(ok.answer.statedRules[0]).toMatchObject({ exactQuote: CLAUSE_2, effect: { type: "forbid", action: "approve" }, kind: "guardrail" });
    const fromTranslation = toParsedAnswer(rule("then I do not approve at desk level."), ctx);
    expect(fromTranslation.answer.statedRules).toEqual([]);
    expect(fromTranslation.rejected).toEqual([{ item: "statedRules[0]", reason: "quote is not verbatim in the answer" }]);
    const transliterated = toParsedAnswer(rule("to main desk level par approve nahi karti"), ctx);
    expect(transliterated.answer.statedRules).toEqual([]);
  });
});
