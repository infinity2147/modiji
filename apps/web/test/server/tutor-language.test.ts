/** The tutor speaks English (plan §7.11): a Hindi quote is shown in the original with its labelled translation, never read aloud in Hindi. */
import { describe, expect, it } from "vitest";
import { ConfirmedRuleSchema, type ActionId } from "@vashistha/core";
import { interventionText, quoteView } from "../../lib/server/tutor/rules";
import { expertRule } from "../support/tutor-harness";

const HINDI = "अगर देश हाई-रिस्क लिस्ट पर है तो मैं डेस्क लेवल पर अप्रूव नहीं करती।";
const ENGLISH = "If the country is on the high-risk list, I do not approve at desk level.";

function hindiRule(translation: string | undefined) {
  const rule = expertRule({ id: "r-hi", kind: "guardrail", effect: { type: "forbid", action: "approve" }, predicate: { "==": [{ var: "jurisdictionRisk" }, "high"] }, quote: HINDI, priority: 40 });
  const [quote, ...rest] = rule.evidence;
  return ConfirmedRuleSchema.parse({ ...rule, evidence: [{ ...quote, language: "hi", ...(translation !== undefined && { translation }) }, ...rest] });
}

const ledger = { get: () => undefined };

describe("tutor and a quote in Hindi", () => {
  it("shows the original words with the machine translation alongside", () => {
    expect(quoteView(ledger, hindiRule(ENGLISH))).toMatchObject({ text: HINDI, language: "hi", translation: ENGLISH });
    expect(quoteView(ledger, hindiRule(undefined))).not.toHaveProperty("translation");
  });

  it("speaks the labelled translation, or points at the screen when none is on record — never the Hindi words", () => {
    const input = { trigger: "guardrail_violation" as const, proposedAction: "approve" as ActionId, missingFeatures: [] };
    const translated = interventionText({ rule: hindiRule(ENGLISH), ...input });
    expect(translated).toContain(`in machine translation: "${ENGLISH}"`);
    expect(translated).not.toContain(HINDI);
    const pending = interventionText({ rule: hindiRule(undefined), ...input });
    expect(pending).toContain("The expert's words are on your screen.");
    expect(pending).not.toContain(HINDI);
  });
});
