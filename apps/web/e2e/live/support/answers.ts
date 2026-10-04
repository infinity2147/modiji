/**
 * The scripted expert's knowledge: which rating and outcome they choose for each case, and how they
 * answer the question the agent ACTUALLY asked (simple keyword rules over the agent's words and the
 * case just decided). The content follows the synthetic policy's public narrative (country risk,
 * ownership threshold, long-standing-customer exception, PEP escalation, missing funds at high
 * volume, adverse media). Every line is spoken as synthetic voice input (ElevenLabs TTS).
 *
 * `stopRules: false` (the P3 gate runs) keeps every answer free of "never …" statements, so the gate
 * runs do not add stop-rules to the shared production rulebook; the P4 run states them on purpose.
 */
import type { Outcome, Rating } from "./expert";

export type CasePlan = { rating: Rating; outcome: Outcome; why: string };

export const CASE_PLANS: Record<string, CasePlan> = {
  "NS-2026-0101": {
    rating: "medium",
    outcome: "enhancedReview",
    why: "The largest owner holds thirty-five percent and isn't verified. Anything over twenty-five percent that isn't verified goes to enhanced review.",
  },
  "NS-2026-0102": {
    rating: "high",
    outcome: "approve",
    why: "They've banked with us for three years and their source of funds is verified, so the high-risk country on its own doesn't send them to enhanced review.",
  },
  "NS-2026-0103": {
    rating: "high",
    outcome: "escalateCompliance",
    why: "She's a politically exposed person, so it goes to the compliance officer, whatever else the file says.",
  },
  "NS-2026-0301": { rating: "low", outcome: "approve", why: "A low-risk individual we've known for years. Nothing flags it, so I approve." },
  "NS-2026-0302": {
    rating: "medium",
    outcome: "requestDocuments",
    why: "No source of funds at eighty-five thousand a month. Above fifty thousand a month without a source of funds, I request documents.",
  },
  "NS-2026-0303": { rating: "medium", outcome: "enhancedReview", why: "Adverse media in a medium-risk country sends it to enhanced review." },
  "NS-2026-0304": { rating: "medium", outcome: "enhancedReview", why: "The trust's largest owner holds forty percent and isn't verified, so it goes to enhanced review." },
  "NS-2026-0305": { rating: "high", outcome: "approve", why: "High-risk country, but they've banked with us thirty months with verified funds, so I approve." },
  "NS-2026-0306": { rating: "medium", outcome: "approve", why: "A long-standing individual customer in a medium-risk country with nothing else flagged, so I approve." },
};

export const STOP_RULE_HIGH_RISK =
  "Never approve a customer from a high-risk country at desk level unless they've banked with us for two years with verified funds.";
export const STOP_RULE_PEP = "Never approve a politically exposed person without compliance sign-off.";

const LINES = {
  countryOnApproved: "Country risk alone isn't it. A long relationship with verified funds lets me approve high-risk customers.",
  countryOnOwner: "No, the country doesn't drive this one. It's the unverified owner holding thirty-five percent.",
  countryOnPep: "The country doesn't matter here. A politically exposed person always goes to the compliance officer.",
  country: "Country risk matters, but a long relationship with verified funds can outweigh a high-risk country.",
  owner: "If the largest owner holds more than twenty-five percent and isn't verified, it goes to enhanced review.",
  ownerUnder: "At twenty-five percent or less the owner threshold doesn't apply, so ownership wouldn't change it.",
  pep: "A politically exposed person always goes to the compliance officer, whatever the other factors.",
  relationship: "Relationship length matters for high-risk countries. Two years or more with verified funds and I can approve.",
  funds: "Verified source of funds is what makes the long relationship count. Without it I'd want enhanced review.",
  volume: "The expected volume didn't matter for this decision, only when the source of funds is missing.",
  sanctions: "Any sanctions match is a rejection.",
  media: "Adverse media outside a low-risk country sends it to enhanced review.",
  entity: "For a company or a trust I look at the largest owner. For an individual the owner threshold doesn't apply.",
  concept: "It's what the case file shows in that section. On its own it didn't change this decision.",
  fallback: "It's the combination of country risk, ownership, and how long they've banked with us.",
} as const;

/** All lines the answerer can say (pre-generated before a run). */
export function allAnswerLines(caseIds: readonly string[], stopRules: boolean): string[] {
  const lines: string[] = [...Object.values(LINES), ...caseIds.map((id) => CASE_PLANS[id]?.why ?? LINES.fallback)];
  if (stopRules) lines.push(STOP_RULE_HIGH_RISK, STOP_RULE_PEP);
  return [...new Set(lines)];
}

/** Chooses the answer to the question the agent actually asked, about the case just decided. */
export function answerFor(question: string, caseId: string): { text: string; rule: string } {
  const q = question.toLowerCase();
  const plan = CASE_PLANS[caseId];
  const has = (...words: string[]) => words.some((w) => q.includes(w));
  if (has("what counts as", "what do you mean", "where would i see", "define")) return { text: LINES.concept, rule: "concept_definition" };
  if (has("sanction")) return { text: LINES.sanctions, rule: "sanctions" };
  if (has("politically", "pep")) return { text: LINES.pep, rule: "pep" };
  if (has("country", "jurisdiction")) {
    if (caseId === "NS-2026-0102" || caseId === "NS-2026-0305") return { text: LINES.countryOnApproved, rule: "country_on_approved_high_risk" };
    if (caseId === "NS-2026-0101") return { text: LINES.countryOnOwner, rule: "country_on_owner_case" };
    if (caseId === "NS-2026-0103") return { text: LINES.countryOnPep, rule: "country_on_pep_case" };
    return { text: LINES.country, rule: "country" };
  }
  if (has("owner", "ownership", "percent", "%", "stake", "share")) {
    if (has("25", "twenty-five", "below", "under", "less")) return { text: LINES.ownerUnder, rule: "owner_under_threshold" };
    return { text: LINES.owner, rule: "owner_threshold" };
  }
  if (has("existing", "new customer", "relationship", "months", "how long", "banked", "years", "account age", "tenure")) return { text: LINES.relationship, rule: "relationship" };
  if (has("source of funds", "funds", "unverified", "verified")) return { text: LINES.funds, rule: "funds" };
  if (has("volume", "monthly", "per month", "a month")) return { text: LINES.volume, rule: "volume" };
  if (has("adverse", "media", "news")) return { text: LINES.media, rule: "media" };
  if (has("company", "individual", "trust", "entity")) return { text: LINES.entity, rule: "entity" };
  if (has("what told you", "why", "what made you", "what led", "changed your mind", "reason")) return { text: plan?.why ?? LINES.fallback, rule: "why_probe" };
  return { text: plan?.why ?? LINES.fallback, rule: "fallback_case_reason" };
}
