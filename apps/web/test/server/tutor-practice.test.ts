/** P6 unseen cases: solver boundary practice cases and judge-entered cases, valid and workable in their session only. */
import { describe, expect, it } from "vitest";
import { AssignmentSchema, evaluatePredicate, parseLedgerPayload, recordLookup } from "@vashistha/core";
import { KYC_DOMAIN, KycCaseSchema, caseFeatures, kycCases, largestOwner } from "@vashistha/core/domains/kyc";
import { ListCasesResponseSchema } from "../../lib/contracts/casedesk";
import { PracticeResponseSchema } from "../../lib/contracts/tutor";
import { caseFromAssignment, pinnedFeatures } from "../../lib/server/tutor/practice";
import { createTutorHarness, demoRules } from "../support/tutor-harness";

const JUDGE = {
  entityType: "trust",
  customerStatus: "existing",
  accountAgeMonths: 30,
  jurisdictionRisk: "medium",
  uboOwnershipPct: 55.5,
  uboVerified: false,
  pep: false,
  sanctionsHit: false,
  adverseMedia: true,
  sourceOfFunds: "unverified",
  expectedMonthlyVolume: 120_000,
} as const;

function satisfiesDomain(c: unknown): boolean {
  const kycCase = KycCaseSchema.parse(c);
  const lookup = recordLookup(caseFeatures(kycCase));
  return KYC_DOMAIN.domainConstraints.every((p) => evaluatePredicate(p, lookup).truth === true);
}

describe("practice cases", () => {
  it("are boundary cases of the weakest rules: schema-valid, constraint-satisfying, pinned to the witness, recorded with provenance", async () => {
    const h = createTutorHarness();
    const ruleEntries = await h.seedRules(demoRules());
    const sessionId = await h.session();
    const r = await h.practice(sessionId);
    expect(r.status).toBe(201);
    const { cases, note } = PracticeResponseSchema.parse(r.body);
    expect(note).toBeNull();
    expect(cases.map((c) => c.id)).toEqual(["NS-2026-1000", "NS-2026-1001", "NS-2026-1002"]);
    for (const c of cases) expect(satisfiesDomain(c)).toBe(true);

    const generated = h.entries(sessionId, ["case.generated"]);
    expect(generated).toHaveLength(3);
    for (const entry of generated) {
      const payload = parseLedgerPayload(entry, "case.generated");
      expect(entry.source).toBe("engine");
      expect(payload.origin).toMatchObject({ kind: "boundary_practice", ruleId: "rule-documents", feature: "uboOwnershipPct", threshold: 25 });
      expect(entry.parentIds).toContain(ruleEntries.get("rule-documents"));
      const kycCase = KycCaseSchema.parse(payload.case);
      // The case sits exactly at the witness's side of the threshold.
      const share = largestOwner(kycCase).sharePct;
      expect({ below: 24.9, at: 25, above: 25.1 }[payload.origin.kind === "boundary_practice" ? payload.origin.side : "at"]).toBe(share);
    }

    // A second request adds no duplicate: the solver has no further distinct boundary cases here.
    const again = PracticeResponseSchema.parse((await h.practice(sessionId)).body);
    expect(again.cases).toEqual([]);
    expect(again.note).toMatch(/no further distinct boundary cases/);
  });

  it("are available to their session (queue listing, DOM events, interlock, commit) and to no other", async () => {
    const h = createTutorHarness();
    await h.seedRules(demoRules());
    const sessionId = await h.session();
    const { cases } = PracticeResponseSchema.parse((await h.practice(sessionId)).body);
    const listed = ListCasesResponseSchema.parse((await h.listCases(`?set=heldout&session=${sessionId}`)).body).cases;
    expect(listed.map((c) => c.id)).toEqual([...kycCases("heldout").map((c) => c.id), ...cases.map((c) => c.id)]);
    expect((await h.listCases(`?set=practice&session=${sessionId}`)).status).toBe(400);

    const practiceCase = cases[0]!;
    expect((await h.events(sessionId, [{ kind: "open_case", caseId: practiceCase.id }])).status).toBe(200);
    const { commit } = await h.save(sessionId, practiceCase.id, "requestDocuments");
    expect(commit.status).toBe(200);

    const other = await h.session();
    expect((await h.events(other, [{ kind: "open_case", caseId: practiceCase.id }])).status).toBe(400);
    expect((await h.save(other, practiceCase.id, "approve")).check.body).toMatchObject({ error: "unknown_case" });
  });

  it("say so when there is nothing to practise", async () => {
    const h = createTutorHarness();
    const sessionId = await h.session();
    expect(PracticeResponseSchema.parse((await h.practice(sessionId)).body)).toMatchObject({ cases: [], note: "The expert has not confirmed any rules yet." });
    await h.seedRules([demoRules()[0]!]); // no numeric threshold
    expect(PracticeResponseSchema.parse((await h.practice(sessionId)).body).note).toMatch(/no numeric thresholds/);
  });

  it("witness → case pins every feature the rulebook reads (closed under coupling constraints) and checks the result", () => {
    const rules = demoRules();
    const pinned = pinnedFeatures(rules);
    // Ownership share is coupled to entity type; customer status to relationship age.
    expect([...pinned].sort()).toEqual(["accountAgeMonths", "customerStatus", "entityType", "jurisdictionRisk", "sanctionsHit", "uboOwnershipPct", "uboVerified"]);
    const assignment = AssignmentSchema.parse({ ...caseFeatures(kycCases("heldout")[0]!), uboOwnershipPct: 25.1, uboVerified: false });
    const built = caseFromAssignment({ id: "NS-2026-1500", seed: 7, assignment, pinned });
    for (const f of pinned) expect(caseFeatures(built)[f]).toBe(assignment[f]);
    // A witness the generator cannot honour is refused, never patched.
    expect(() => caseFromAssignment({ id: "NS-2026-1501", seed: 7, assignment: AssignmentSchema.parse({ ...assignment, uboOwnershipPct: 0 }), pinned })).toThrow();
  });
});

describe("judge-entered cases", () => {
  it("valid values become a schema-valid case in the judge range, recorded from the client", async () => {
    const h = createTutorHarness();
    const sessionId = await h.session();
    const r = await h.judge(sessionId, JUDGE);
    expect(r.status).toBe(201);
    const kycCase = KycCaseSchema.parse((r.body as { case: unknown }).case);
    expect(kycCase.id).toBe("NS-2026-2000");
    expect(satisfiesDomain(kycCase)).toBe(true);
    expect(caseFeatures(kycCase)).toMatchObject({ ...JUDGE, riskRating: "unrated" });
    const [entry] = h.entries(sessionId, ["case.generated"]);
    expect(entry?.source).toBe("client");
    expect(parseLedgerPayload(entry!, "case.generated").origin).toEqual({ kind: "judge" });
    expect(((await h.judge(sessionId, JUDGE)).body as { case: { id: string } }).case.id).toBe("NS-2026-2001");
  });

  it("values outside the domain, or violating its constraints, are refused", async () => {
    const h = createTutorHarness();
    const sessionId = await h.session();
    const individualAt40 = await h.judge(sessionId, { ...JUDGE, entityType: "individual", uboOwnershipPct: 40 });
    expect(individualAt40).toMatchObject({ status: 400, body: { error: "invalid_case" } });
    const newWithHistory = await h.judge(sessionId, { ...JUDGE, customerStatus: "new", accountAgeMonths: 12 });
    expect(newWithHistory).toMatchObject({ status: 400, body: { error: "invalid_case" } });
    expect((await h.judge(sessionId, { ...JUDGE, accountAgeMonths: 601 })).status).toBe(400);
    expect((await h.judge(sessionId, { ...JUDGE, jurisdictionRisk: "extreme" })).status).toBe(400);
    expect((await h.judge(sessionId, { ...JUDGE, extra: 1 })).status).toBe(400);
    expect(h.entries(sessionId, ["case.generated"])).toEqual([]);
  });

  it("off the record, nothing is entered", async () => {
    const h = createTutorHarness();
    const sessionId = await h.session();
    await h.offRecord(sessionId, true);
    expect((await h.judge(sessionId, JUDGE)).status).toBe(409);
    expect((await h.practice(sessionId)).status).toBe(409);
    expect(h.entries(sessionId, ["case.generated"])).toEqual([]);
  });
});
