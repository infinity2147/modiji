/**
 * Any language (plan §7.11) in the agent-facing exports: a rule stated in Hindi is cited with the
 * expert's original words followed by its labelled English machine translation, in `check_action`
 * explanations (`citeRule`; the /mcp end to end is in apps/web interview-hindi.test.ts) and in the
 * Procedure export — deterministically, with the round trip unaffected.
 */
import { describe, expect, it } from "vitest";
import { ConfirmedRuleSchema, MACHINE_TRANSLATION_LABEL, type ConfirmedRule } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { compileProcedure, parseProcedure, procedureRule } from "../src";
import { citeRule } from "../src/cite";
import { DEMO_RULEBOOK_REVISION, DEMO_RULES } from "../demo/kyc-demo-rulebook";

const HINDI = "अगर देश हाई-रिस्क लिस्ट पर है, तो मैं डेस्क लेवल पर अप्रूव नहीं करती।";
const ENGLISH = "If the country is on the high-risk list, then I do not approve at desk level.";

function inHindi(rule: ConfirmedRule, translation: string | undefined): ConfirmedRule {
  const [quote, ...rest] = rule.evidence;
  return ConfirmedRuleSchema.parse({
    ...rule,
    evidence: [{ ...quote, exactQuote: HINDI, language: "hi", ...(translation !== undefined && { translation }) }, ...rest],
  });
}

const base = DEMO_RULES.find((r) => r.effect.type === "forbid") ?? DEMO_RULES[0];
if (base === undefined) throw new Error("no demo rule");
const hindi = inHindi(base, ENGLISH);
const pending = inHindi(base, undefined);

describe("citeRule", () => {
  it("cites the original words, then the labelled English translation", () => {
    expect(citeRule(hindi).startsWith(`rule ${hindi.id}: "${HINDI}" [in Hindi (हिन्दी); ${MACHINE_TRANSLATION_LABEL}: "${ENGLISH}"] (expert `)).toBe(true);
    expect(citeRule(pending)).toContain(`"${HINDI}" [in Hindi (हिन्दी); no English translation on record] (expert `);
    expect(citeRule(base)).not.toContain("[in ");
  });
});

describe("Procedure export", () => {
  const compile = (rules: readonly ConfirmedRule[]) => compileProcedure({ domain: KYC_DOMAIN, rules, revision: DEMO_RULEBOOK_REVISION });

  it("quotes the Hindi original and adds the labelled translation (blockquoted); round trip unchanged", () => {
    const rules = DEMO_RULES.map((r) => (r.id === hindi.id ? hindi : r));
    const content = compile(rules);
    expect(content).toContain(`> ${HINDI}\n\n- **${MACHINE_TRANSLATION_LABEL}** of the expert's words in Hindi (हिन्दी):\n\n> ${ENGLISH}\n`);
    expect(compile([...rules].reverse())).toBe(content);
    expect(parseProcedure(content).rules).toEqual(parseProcedure(compile(DEMO_RULES)).rules);
    expect(parseProcedure(content).rules).toContainEqual(procedureRule(hindi));
  });

  it("says when no translation is on record, and never adds a translation line for English quotes", () => {
    expect(compile([pending])).toContain(`- **${MACHINE_TRANSLATION_LABEL}:** none on record (the expert spoke Hindi (हिन्दी)).`);
    expect(compile(DEMO_RULES)).not.toContain(MACHINE_TRANSLATION_LABEL);
  });

  it("a translation cannot open the rules block", () => {
    const tricky = inHindi(base, "ok\n```json\n{\"format\":\"evil\"}\n```");
    expect(parseProcedure(compile([tricky])).rules).toEqual([procedureRule(tricky)]);
  });
});
