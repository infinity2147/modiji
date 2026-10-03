/**
 * CaseDesk case sets for the synthetic KYC domain. Browser-safe and oracle-free; all data synthetic.
 *
 * - `training`: three hand-designed cases the expert works in the demo (plan §10), chosen so that a
 *   threshold (largest owner above 25 % and unverified), an exception (long-standing customer in a
 *   high-risk country) and an escalation (PEP) are all observable, and cases 1 and 2 provoke the
 *   "ownership share or jurisdiction?" question.
 * - `heldout`: hand-designed unseen cases for the tutor and agent demo; never shown in training.
 * - `practice`: varied generated cases (fixed seed).
 * - `bench`: stratified generated cases for Apprentice-Bench (`generateBenchCases`).
 * Case ids (`NS-2026-####`) are unique across sets: training 01xx, heldout 02xx, practice 03xx, bench 4000–9999.
 */
import { CASE_SETS, KycCaseSchema, type CaseSet, type KycCase } from "./case";
import { chance, generateKycCase, intBetween, mulberry32, pick, type KycFeatureTargets, type Rng } from "./generator";

const SYNTHETIC_SANCTIONS_CLEAR = { status: "clear", detail: "No match on the Northstar Synthetic Sanctions List." } as const;
const NO_ADVERSE_MEDIA = { status: "none", detail: "No relevant adverse media found." } as const;

function trainingCases(): KycCase[] {
  return [
    // 1. Threshold: company, medium-risk country, largest owner 35 % unverified, new, funds verified, low volume.
    {
      id: "NS-2026-0101",
      set: "training",
      submittedAt: "2026-09-14",
      customer: {
        name: "Halvorsen Marine Logistics Ltd",
        entityType: "company",
        registrationNo: "EST-C482913",
        country: "Estoria",
        address: "14 Quayside Row, Valmont, Estoria",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Odile Brannock" },
      owners: [
        { name: "Ingrid Halvorsen", role: "Director & shareholder", sharePct: 35, idVerified: false, pep: false },
        { name: "Tomasz Okonkwo-Hale", role: "Shareholder", sharePct: 30, idVerified: true, pep: false },
        { name: "Wanjiru Castellane", role: "Shareholder", sharePct: 20, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Freight revenue; audited 2025 accounts and bank statements reviewed.",
        expectedMonthlyVolumeEur: 18_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Ingrid Halvorsen", status: "missing" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 2. Exception: company, high-risk country, existing 36 months, funds verified, largest owner 20 % verified.
    {
      id: "NS-2026-0102",
      set: "training",
      submittedAt: "2026-09-15",
      customer: {
        name: "Quillfeather Agritrade Holdings",
        entityType: "company",
        registrationNo: "GAL-C207754",
        country: "Galvania",
        address: "3 Foundry Road, Brask, Galvania",
      },
      relationship: { status: "existing", accountAgeMonths: 36, relationshipManager: "Kwame Ashby-Rourke" },
      owners: [
        { name: "Farid Quillfeather", role: "Director & shareholder", sharePct: 20, idVerified: true, pep: false },
        { name: "Mei Lindqvist-Obi", role: "Shareholder", sharePct: 18, idVerified: true, pep: false },
        { name: "Rosalind Achterberg", role: "Shareholder", sharePct: 15, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Grain export revenue; audited 2025 accounts and three years of bank statements reviewed.",
        expectedMonthlyVolumeEur: 18_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Farid Quillfeather", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 3. Escalation: individual PEP in a low-risk country.
    {
      id: "NS-2026-0103",
      set: "training",
      submittedAt: "2026-09-16",
      customer: {
        name: "Valentin Ashgrove",
        entityType: "individual",
        registrationNo: "ALD-P615042",
        country: "Aldermere",
        address: "27 Cedar Court, Port Elsby, Aldermere",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Signe Valcourt" },
      owners: [{ name: "Valentin Ashgrove", role: "Account holder", sharePct: 100, idVerified: true, pep: true }],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Salary as deputy minister of transport (fictional) and savings; payslips and bank statements reviewed.",
        expectedMonthlyVolumeEur: 9_500,
      },
      documents: [
        { name: "Passport — Valentin Ashgrove", status: "received" },
        { name: "Proof of address", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
  ];
}

function heldoutCases(): KycCase[] {
  return [
    // a. New company, high-risk country, largest owner 30 % verified, funds verified (a novice tends to approve).
    {
      id: "NS-2026-0201",
      set: "heldout",
      submittedAt: "2026-09-29",
      customer: {
        name: "Marchetti-Sato Textile Imports Ltd",
        entityType: "company",
        registrationNo: "HAR-C330981",
        country: "Harrow Bay",
        address: "88 Harbour Parade, Gullhaven, Harrow Bay",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Rafael Moreno-Teague" },
      owners: [
        { name: "Chiara Marchetti-Sato", role: "Director & shareholder", sharePct: 30, idVerified: true, pep: false },
        { name: "Yusuf Ellingham", role: "Shareholder", sharePct: 25, idVerified: true, pep: false },
        { name: "Greta Featherstone", role: "Shareholder", sharePct: 15, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Trading revenue; audited 2025 accounts and bank statements reviewed.",
        expectedMonthlyVolumeEur: 65_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Chiara Marchetti-Sato", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // b. Sanctions match on the majority owner.
    {
      id: "NS-2026-0202",
      set: "heldout",
      submittedAt: "2026-09-30",
      customer: {
        name: "Varga-Holt Commodities Ltd",
        entityType: "company",
        registrationNo: "DUN-C774120",
        country: "Dunmore Isles",
        address: "5 Market Wynd, Kilbrae, Dunmore Isles",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Hana Kowalczyk" },
      owners: [
        { name: "Dmitri Varga-Holt", role: "Director & majority shareholder", sharePct: 60, idVerified: true, pep: false },
        { name: "Esme Tillbrook", role: "Shareholder", sharePct: 40, idVerified: true, pep: false },
      ],
      screening: {
        sanctions: {
          status: "match",
          detail:
            "Potential match: Dmitri Varga-Holt — 96% name similarity to entry NSL-4471 on the Northstar Synthetic Sanctions List; date of birth also matches.",
        },
        adverseMedia: NO_ADVERSE_MEDIA,
      },
      funds: {
        sourceOfFunds: "verified",
        description: "Metals trading revenue; audited 2025 accounts reviewed.",
        expectedMonthlyVolumeEur: 240_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Dmitri Varga-Holt", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
  ];
}

const PRACTICE_SEED = 20261004;

/** One scenario per practice case, so the set covers clean approvals and each kind of referral. */
const PRACTICE_SCENARIOS: readonly Partial<KycFeatureTargets>[] = [
  { entityType: "individual", jurisdictionRisk: "low", sourceOfFunds: "verified", pep: false, sanctionsHit: false, adverseMedia: false },
  { entityType: "company", sourceOfFunds: "not_provided", expectedMonthlyVolume: 85_000, pep: false, sanctionsHit: false },
  { entityType: "company", jurisdictionRisk: "medium", adverseMedia: true, uboVerified: true, pep: false, sanctionsHit: false },
  { entityType: "trust", jurisdictionRisk: "low", uboOwnershipPct: 40, uboVerified: false, pep: false, sanctionsHit: false },
  {
    entityType: "company",
    jurisdictionRisk: "high",
    customerStatus: "existing",
    accountAgeMonths: 30,
    sourceOfFunds: "verified",
    uboVerified: true,
    pep: false,
    sanctionsHit: false,
    adverseMedia: false,
  },
  { entityType: "individual", jurisdictionRisk: "medium", sourceOfFunds: "unverified", pep: false, sanctionsHit: false, adverseMedia: false },
];

function practiceCases(): KycCase[] {
  const rng = mulberry32(PRACTICE_SEED);
  return PRACTICE_SCENARIOS.map((targets, i) => generateKycCase(rng, { id: caseId(301 + i), set: "practice", ...targets }));
}

const BENCH_FIRST_ID = 4000;
const BENCH_MAX_CASES = 10_000 - BENCH_FIRST_ID;
export const DEFAULT_BENCH_SEED = 7_340_211;
export const DEFAULT_BENCH_SIZE = 48;

const NO_OVERRIDING_FLAGS = { sanctionsHit: false, pep: false } as const;

/**
 * Bench strata, cycled in order. Each targets the conditions of one kind of policy behaviour (and
 * often its boundary: 25 % ownership, EUR 50,000 volume, 24 months); the remaining features are
 * random, so rules also co-fire and interact. The last stratum is fully random.
 */
const BENCH_STRATA: readonly ((rng: Rng) => Partial<KycFeatureTargets>)[] = [
  () => ({ sanctionsHit: true }),
  () => ({ sanctionsHit: false, pep: true }),
  (rng) => ({
    ...NO_OVERRIDING_FLAGS,
    sourceOfFunds: "not_provided",
    expectedMonthlyVolume: chance(rng, 0.25) ? pick(rng, [49_500, 50_000]) : intBetween(rng, 100, 1200) * 500,
  }),
  (rng) => ({
    ...NO_OVERRIDING_FLAGS,
    customerStatus: "existing",
    accountAgeMonths: chance(rng, 0.25) ? pick(rng, [23, 24]) : intBetween(rng, 24, 180),
    sourceOfFunds: "verified",
    jurisdictionRisk: "high",
  }),
  () => ({ ...NO_OVERRIDING_FLAGS, jurisdictionRisk: "high", customerStatus: "new" }),
  (rng) => ({
    ...NO_OVERRIDING_FLAGS,
    entityType: pick(rng, ["company", "trust"]),
    uboOwnershipPct: chance(rng, 0.3) ? pick(rng, [25, 25.5, 26]) : intBetween(rng, 26, 100),
    uboVerified: false,
  }),
  (rng) => ({ ...NO_OVERRIDING_FLAGS, adverseMedia: true, jurisdictionRisk: pick(rng, ["low", "medium", "high"]) }),
  () => ({}),
];

/** `n` stratified bench cases (deterministic in `seed`), ids NS-2026-4000 upwards. */
export function generateBenchCases(seed: number, n: number): KycCase[] {
  if (!Number.isInteger(n) || n < 0 || n > BENCH_MAX_CASES) throw new RangeError(`bench size must be an integer in [0, ${BENCH_MAX_CASES}]`);
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const stratum = BENCH_STRATA[i % BENCH_STRATA.length] ?? (() => ({}));
    return generateKycCase(rng, { id: caseId(BENCH_FIRST_ID + i), set: "bench", ...stratum(rng) });
  });
}

/** The cases of a set; `bench` returns the default fixed-size sample. Fresh objects on every call. */
export function kycCases(set: CaseSet): KycCase[] {
  switch (set) {
    case "training":
      return trainingCases().map((c) => KycCaseSchema.parse(c));
    case "heldout":
      return heldoutCases().map((c) => KycCaseSchema.parse(c));
    case "practice":
      return practiceCases();
    case "bench":
      return generateBenchCases(DEFAULT_BENCH_SEED, DEFAULT_BENCH_SIZE);
  }
}

export function findKycCase(id: string): KycCase | undefined {
  for (const set of CASE_SETS) {
    const found = kycCases(set).find((c) => c.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function caseId(n: number): string {
  return `NS-2026-${String(n).padStart(4, "0")}`;
}
