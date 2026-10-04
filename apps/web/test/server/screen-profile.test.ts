/**
 * The CaseDesk screen profile's chrome lexicon (lib/server/perception/screen-profile.ts): vision concept
 * proposals grounded in the app's own labels are dropped deterministically. The junk examples are the
 * live run's (docs/evidence/live/p4/attempt-1-conversation-failed: concept.proposed entries 48–49).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unknown, type FeatureId, type FeatureValue } from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { createRgba, thumbnail } from "@vashistha/perception";
import { interpretReading, type CaseSnapshot, type FullRead } from "@vashistha/perception/extraction";
import { CASEDESK_CHROME, CASEDESK_SCREEN } from "../../lib/server/perception/screen-profile";

const COMPONENTS = join(import.meta.dirname, "../../components");
const CASE = "NS-2026-0102";
const TITLE = "Quillfeather Agritrade Holdings";
const BLANK = thumbnail(createRgba(64, 36));

function componentSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? componentSources(join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [readFileSync(join(dir, d.name), "utf8")] : [],
  );
}

/** A full read of the case's second whole-screen frame: the one read for undefined concepts. */
function propose(concepts: FullRead["concepts"]) {
  const previous: CaseSnapshot = {
    caseId: CASE,
    fields: { riskRating: "unrated" } as Record<FeatureId, FeatureValue>,
    committed: unknown("not_extracted"),
    thumbnail: BLANK,
    fullReadAt: 0,
    conceptsRead: false,
    caseVotes: { [CASE]: 1 },
    caseTitle: TITLE,
  };
  return interpretReading(
    { mode: "full", output: { caseId: CASE, caseTitle: TITLE, fields: { riskRating: "unrated" }, committed: null, concepts } },
    { domain: KYC_DOMAIN, profile: CASEDESK_SCREEN, previous, frameSeq: 3, captureTime: 1, sessionEpoch: 0, mode: "full", thumbnail: BLANK, switchPossible: false },
  );
}

describe("CaseDesk chrome lexicon", () => {
  it("drops the live run's chrome concepts and keeps case content", () => {
    const result = propose([
      // As vision proposed them in production (P4 attempt 1, session f4f88cde): section headings and tabs.
      { name: "screeningSourceOfFundsDocuments", description: "Review sections: Screening, Source of funds, Documents", observedValue: "visible" },
      { name: "caseStructure", description: "Tabs showing Customer, Relationship, Beneficial owners workflow", observedValue: "displayed" },
    ]);
    expect(result.concepts).toEqual([]);
    expect(result.dropped).toEqual([
      { where: "concept", key: "screeningSourceOfFundsDocuments", reason: "screen_chrome" },
      { where: "concept", key: "caseStructure", reason: "screen_chrome" },
    ]);
    // The same headings without the giveaway description or value: the name alone is all chrome.
    expect(propose([{ name: "screeningSourceOfFundsDocuments", description: "Screening, source of funds and documents", observedValue: null }]).dropped).toEqual([
      { where: "concept", key: "screeningSourceOfFundsDocuments", reason: "screen_chrome" },
    ]);
    // Genuine case content (the registry extract's age, the concept the expert named in P4 attempt 2) passes.
    const kept = propose([{ name: "registryExtractAgeMonths", description: "Age of the company registry extract in months", observedValue: "14" }]);
    expect(kept.concepts.map((c) => c.name)).toEqual(["registryExtractAgeMonths"]);
  });

  it("is declared from the app's own components: every label is rendered by one, every case-file section title is listed", () => {
    const sources = componentSources(COMPONENTS).join("\n");
    for (const label of CASEDESK_CHROME) expect(sources, `"${label}" is no longer rendered by any component`).toContain(label);
    const caseDetail = readFileSync(join(COMPONENTS, "casedesk/case-detail.tsx"), "utf8");
    const sections = [...caseDetail.matchAll(/<Section [^>]*title="([^"]+)"/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(0);
    expect(CASEDESK_CHROME).toEqual(expect.arrayContaining(sections));
  });
});
