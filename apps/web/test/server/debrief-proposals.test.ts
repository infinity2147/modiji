/**
 * Which rules the debrief proposes first. With three decided cases many single-condition explanations tie (every feature
 * on which the lone PEP case differs explains its outcome equally well, up to floating-point noise), and the debrief
 * asks about only the first few. Ties are broken by alternating the proposed action, so the first proposals cover every
 * decision that needs a rule instead of spending the budget on one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { byProposalWeight } from "../../lib/server/debrief/state";
import { getState, world, type World } from "../support/debrief-harness";

/** The number of proposals the debrief conversation asks about (`MAX_PROPOSALS` in conversation.ts). */
const ASKED = 4;

describe("debrief proposals", () => {
  let w: World;
  beforeAll(async () => {
    w = await world({ confirmedRules: false });
  }, 60_000);
  afterAll(async () => {
    w.opened.close();
    await rm(w.dataDir, { recursive: true, force: true });
  });

  it("the first proposals cover each decision that is not an approval, alternating between equally likely rules", async () => {
    const s = await getState(w);
    expect(s.rules).toHaveLength(0);
    const asked = [...s.proposals].sort(byProposalWeight).slice(0, ASKED);
    expect(asked.map((p) => p.action)).toEqual(["enhancedReview", "requestDocuments", "enhancedReview", "requestDocuments"]);
    const texts = asked.map((p) => `${p.text} → ${p.action}`);
    expect(texts).toContain("politically exposed person is yes → enhancedReview");
    expect(texts).toContain("country risk is medium → requestDocuments");
  }, 60_000);

  it("orders by weight, and treats weights equal to 12 significant digits as a tie", () => {
    expect([{ weight: 0.2 }, { weight: 0.5 }].sort(byProposalWeight).map((p) => p.weight)).toEqual([0.5, 0.2]);
    expect(byProposalWeight({ weight: 0.040677126792979253 }, { weight: 0.04067712679297926 })).toBe(0);
  });
});
