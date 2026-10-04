/**
 * CaseDesk case sets for the synthetic KYC domain. Browser-safe and oracle-free; all data synthetic.
 *
 * - `training`: eight hand-designed cases the expert works (plan §10). The first three show a threshold (largest
 *   owner above 25 % and unverified), an exception (long-standing customer in a high-risk country) and an
 *   escalation (PEP); cases 1 and 2 are matched on everything but ownership share and jurisdiction, so they
 *   provoke the "ownership share or jurisdiction?" question. The next five carry judgment the screen does not state:
 *   a young cash business versus an established one (the exception), a nominee shareholder, a strong sanctions
 *   name match, and serious adverse media in a low-risk country.
 * - `heldout`: unseen cases for the tutor and agent demo; never shown in training. Each is a case where a plausible
 *   shortcut (an established customer, all owners verified, a low-risk country, a weak name match) gives the wrong
 *   answer unless the expert's reasoning has been learned.
 * - `practice`: varied generated cases (fixed seed), the last four targeting the judgment features.
 * - `bench`: stratified generated cases for Apprentice-Bench (`generateBenchCases`).
 * Case ids (`NS-2026-####`) are unique across sets: training 01xx, heldout 02xx, practice 03xx, bench 4000–9999.
 */
import type { z } from "zod";
import { CASE_SETS, KycCaseSchema, type CaseSet, type KycCase } from "./case";
import { chance, generateKycCase, intBetween, mulberry32, pick, type KycFeatureTargets, type Rng } from "./generator";

const SYNTHETIC_SANCTIONS_CLEAR = { status: "clear", detail: "No match on the Northstar Synthetic Sanctions List." } as const;
const NO_ADVERSE_MEDIA = { status: "none", detail: "No relevant adverse media found." } as const;

/** A case as written by hand: the judgment fields default (person owners, minor media, no name match). */
type KycCaseInput = z.input<typeof KycCaseSchema>;

function trainingCases(): KycCaseInput[] {
  return [
    // 1. Threshold: company, medium-risk country, largest owner 35 % unverified. Matched with case 2 on everything
    //    except ownership share and jurisdiction (existing 36 months, funds verified, owner unverified, same volume).
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
      relationship: { status: "existing", accountAgeMonths: 36, relationshipManager: "Odile Brannock" },
      business: { sector: "Marine logistics", description: "Short-sea freight and warehousing for regional shippers.", declaredAnnualEur: 240_000 },
      owners: [
        { name: "Ingrid Halvorsen", role: "Director & shareholder", sharePct: 35, idVerified: false, pep: false },
        { name: "Tomasz Okonkwo-Hale", role: "Shareholder", sharePct: 30, idVerified: true, pep: false },
        { name: "Wanjiru Castellane", role: "Shareholder", sharePct: 20, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Freight revenue; audited 2025 accounts and three years of bank statements reviewed.",
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
    // 2. Exception: the same profile as case 1 but in a high-risk country with the largest owner at 20 %: the
    //    long-standing-customer exception applies, so no enhanced review (the outcome differs from case 1).
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
      business: { sector: "Agricultural trade", description: "Grain and oilseed export to three trading partners.", declaredAnnualEur: 250_000 },
      owners: [
        { name: "Farid Quillfeather", role: "Director & shareholder", sharePct: 20, idVerified: false, pep: false },
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
        { name: "Passport — Farid Quillfeather", status: "missing" },
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
      business: { sector: "Salaried or private individual", description: "Public-sector salary and personal savings.", declaredAnnualEur: 95_000 },
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
    // 4. Judgment: a cash-heavy business that is still new to the bank. The sector rule applies, and the established-customer
    //    exception does not (eight months is under twelve), so it goes to enhanced review.
    {
      id: "NS-2026-0104",
      set: "training",
      submittedAt: "2026-09-17",
      customer: {
        name: "Wash & Go Laundrettes Ltd",
        entityType: "company",
        registrationNo: "BRW-C558204",
        country: "Brightwater",
        address: "41 Lantern Street, Saltmarsh, Brightwater",
      },
      relationship: { status: "existing", accountAgeMonths: 8, relationshipManager: "Hana Kowalczyk" },
      business: {
        sector: "Cash-intensive retail",
        description: "Eleven self-service laundrettes; most takings are coins and notes, banked weekly.",
        declaredAnnualEur: 450_000,
      },
      owners: [
        { name: "Anouk Maranello", role: "Director & majority shareholder", sharePct: 55, idVerified: true, pep: false },
        { name: "Kenji Tavares-Holt", role: "Shareholder", sharePct: 25, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Till takings and card settlements; eight months of bank statements and the cash-collection log reviewed.",
        expectedMonthlyVolumeEur: 38_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Anouk Maranello", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 5. Judgment: the same kind of business, established. Three and a half years, verified funds and activity that matches its
    //    declared turnover: the exception applies, so approve. The expert's reason is what separates this from case 4.
    {
      id: "NS-2026-0105",
      set: "training",
      submittedAt: "2026-09-18",
      customer: {
        name: "Ravenscroft Cash & Carry Wholesale Ltd",
        entityType: "company",
        registrationNo: "CAL-C390177",
        country: "Calderon",
        address: "9 Foundry Road, Orrin, Calderon",
      },
      relationship: { status: "existing", accountAgeMonths: 41, relationshipManager: "Kwame Ashby-Rourke" },
      business: {
        sector: "Cash-intensive retail",
        description: "Cash-and-carry wholesale to street traders; about half of sales are paid in cash.",
        declaredAnnualEur: 600_000,
      },
      owners: [
        { name: "Bilal Ravenscroft", role: "Director & majority shareholder", sharePct: 60, idVerified: true, pep: false },
        { name: "Catalina Moorcroft-Adu", role: "Shareholder", sharePct: 25, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Wholesale sales; audited 2025 accounts and three years of cash-deposit records reviewed.",
        expectedMonthlyVolumeEur: 52_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Bilal Ravenscroft", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 6. Judgment: a nominee holds 60 % for an undisclosed party. The owner threshold would send it to enhanced review, but the
    //    first step is the nominator declaration, so request documents.
    {
      id: "NS-2026-0106",
      set: "training",
      submittedAt: "2026-09-21",
      customer: {
        name: "Saltmarsh Marine Supplies Ltd",
        entityType: "company",
        registrationNo: "FAR-C641239",
        country: "Faraway",
        address: "17 Beacon Hill, Tallis, Faraway",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Signe Valcourt" },
      business: { sector: "Marine logistics", description: "Chandlery and supplies to shipping agents.", declaredAnnualEur: 300_000 },
      owners: [
        {
          name: "Cresthaven Nominees Ltd",
          role: "Nominee shareholder",
          sharePct: 60,
          idVerified: false,
          pep: false,
          kind: "nominee",
          controller: "Not disclosed. Nominator declaration outstanding.",
        },
        { name: "Desmond Penhallow-Nkosi", role: "Director & shareholder", sharePct: 25, idVerified: true, pep: false },
        { name: "Elif Saragossa", role: "Shareholder", sharePct: 15, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Trading revenue; audited 2025 accounts reviewed.",
        expectedMonthlyVolumeEur: 22_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Nominator declaration", status: "missing" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 7. Judgment: not a confirmed sanctions match, but the date of birth and nationality align with a list entry. A strong name
    //    match is never cleared at the desk: escalate (and approval is forbidden).
    {
      id: "NS-2026-0107",
      set: "training",
      submittedAt: "2026-09-22",
      customer: {
        name: "Nikolai Stavros-Lund",
        entityType: "individual",
        registrationNo: "ALD-P772318",
        country: "Aldermere",
        address: "6 Juniper Avenue, Wrenfield, Aldermere",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Odile Brannock" },
      business: { sector: "Salaried or private individual", description: "Senior engineer at a shipping-software firm.", declaredAnnualEur: 150_000 },
      owners: [{ name: "Nikolai Stavros-Lund", role: "Account holder", sharePct: 100, idVerified: true, pep: false }],
      screening: {
        sanctions: SYNTHETIC_SANCTIONS_CLEAR,
        adverseMedia: NO_ADVERSE_MEDIA,
        nameMatch: {
          strength: "strong",
          detail: "Nikolai Stavros-Lund — 97% name similarity to entry NSL-5120 (Nikolai Stavros-Lunde); date of birth and nationality also match. Not yet cleared.",
        },
      },
      funds: {
        sourceOfFunds: "verified",
        description: "Salary and savings; payslips and bank statements reviewed.",
        expectedMonthlyVolumeEur: 12_000,
      },
      documents: [
        { name: "Passport — Nikolai Stavros-Lund", status: "received" },
        { name: "Proof of address", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // 8. Judgment: a low-risk country and an otherwise clean file, but the managing owner faces a bribery prosecution. Serious
    //    media escalates anywhere; the "outside low-risk countries" rule is for minor media.
    {
      id: "NS-2026-0108",
      set: "training",
      submittedAt: "2026-09-23",
      customer: {
        name: "Penrose-Dale Renewables Holdings Ltd",
        entityType: "company",
        registrationNo: "ALD-C220871",
        country: "Aldermere",
        address: "2 Cedar Court, Port Elsby, Aldermere",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Ade Fairweather" },
      business: {
        sector: "Energy and utilities",
        description: "Develops small solar and wind sites under public-sector grid contracts.",
        declaredAnnualEur: 520_000,
      },
      owners: [
        { name: "Everard Penrose-Dale", role: "Director & majority shareholder", sharePct: 70, idVerified: true, pep: false },
        { name: "Lior Vasquez-Okoro", role: "Shareholder", sharePct: 30, idVerified: true, pep: false },
      ],
      screening: {
        sanctions: SYNTHETIC_SANCTIONS_CLEAR,
        adverseMedia: {
          status: "found",
          severity: "serious",
          detail:
            "Everard Penrose-Dale named in national-press and court-bulletin reports on the bribery prosecution of a public official (2025); trial pending.",
        },
      },
      funds: {
        sourceOfFunds: "verified",
        description: "Contract revenue and shareholder loans; audited 2025 accounts reviewed.",
        expectedMonthlyVolumeEur: 41_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Everard Penrose-Dale", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
  ];
}

function heldoutCases(): KycCaseInput[] {
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
      business: { sector: "Textile imports", description: "Imports fabric for garment makers.", declaredAnnualEur: 900_000 },
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
      business: { sector: "Commodities trading", description: "Metals trading for industrial buyers.", declaredAnnualEur: 3_200_000 },
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
    // c. An established cash business in a low-risk country (a novice reaches for the exception), but it expects three times
    //    the turnover it declared: the activity does not fit, so request documents.
    {
      id: "NS-2026-0203",
      set: "heldout",
      submittedAt: "2026-10-01",
      customer: {
        name: "Harlow & Pike Coin Laundry Services",
        entityType: "company",
        registrationNo: "ALD-C118046",
        country: "Aldermere",
        address: "88 Old Mill Lane, Wrenfield, Aldermere",
      },
      relationship: { status: "existing", accountAgeMonths: 30, relationshipManager: "Rafael Moreno-Teague" },
      business: {
        sector: "Cash-intensive retail",
        description: "Coin-operated laundries; takings banked in cash.",
        declaredAnnualEur: 240_000,
      },
      owners: [
        { name: "Desmond Harlow", role: "Director & majority shareholder", sharePct: 60, idVerified: true, pep: false },
        { name: "Ulla Pike", role: "Shareholder", sharePct: 40, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Takings and card settlements; two years of bank statements reviewed. Recent deposits are well above earlier months.",
        expectedMonthlyVolumeEur: 61_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Desmond Harlow", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // d. Every owner verified and a medium-risk country (a novice approves), but a holding company sits above the customer:
    //    outside a low-risk country that goes to enhanced review.
    {
      id: "NS-2026-0204",
      set: "heldout",
      submittedAt: "2026-10-01",
      customer: {
        name: "Thornquist Property Brokers Ltd",
        entityType: "company",
        registrationNo: "DUN-C660492",
        country: "Dunmore Isles",
        address: "12 Market Wynd, Kilbrae, Dunmore Isles",
      },
      relationship: { status: "existing", accountAgeMonths: 14, relationshipManager: "Hana Kowalczyk" },
      business: { sector: "Real estate brokerage", description: "Residential and commercial property brokerage.", declaredAnnualEur: 420_000 },
      owners: [
        {
          name: "Corvane Holdings Ltd",
          role: "Corporate shareholder",
          sharePct: 70,
          idVerified: true,
          pep: false,
          kind: "holding_company",
          controller: "Wholly held by Imogen Corvane (identity verified).",
        },
        { name: "Priya Thornquist", role: "Director & shareholder", sharePct: 30, idVerified: true, pep: false },
      ],
      screening: { sanctions: SYNTHETIC_SANCTIONS_CLEAR, adverseMedia: NO_ADVERSE_MEDIA },
      funds: {
        sourceOfFunds: "verified",
        description: "Commission income; audited 2025 accounts reviewed.",
        expectedMonthlyVolumeEur: 33_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Registry extract — Corvane Holdings Ltd", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // e. Only the name is similar: date of birth and nationality differ, and the country is low risk. A routine false positive
    //    (a novice escalates), so approve.
    {
      id: "NS-2026-0205",
      set: "heldout",
      submittedAt: "2026-10-02",
      customer: {
        name: "Zofia Lindgren-Okoye",
        entityType: "individual",
        registrationNo: "CAL-P440912",
        country: "Calderon",
        address: "3 Tannery Close, Vey Harbour, Calderon",
      },
      relationship: { status: "new", accountAgeMonths: 0, relationshipManager: "Ade Fairweather" },
      business: { sector: "Salaried or private individual", description: "Hospital pharmacist.", declaredAnnualEur: 110_000 },
      owners: [{ name: "Zofia Lindgren-Okoye", role: "Account holder", sharePct: 100, idVerified: true, pep: false }],
      screening: {
        sanctions: SYNTHETIC_SANCTIONS_CLEAR,
        adverseMedia: NO_ADVERSE_MEDIA,
        nameMatch: {
          strength: "weak",
          detail: "Zofia Lindgren-Okoye — 78% name similarity to entry NSL-2288 (Sofia Lindgren-Reyes); date of birth and nationality differ.",
        },
      },
      funds: { sourceOfFunds: "verified", description: "Salary and savings; payslips and bank statements reviewed.", expectedMonthlyVolumeEur: 8_500 },
      documents: [
        { name: "Passport — Zofia Lindgren-Okoye", status: "received" },
        { name: "Proof of address", status: "received" },
        { name: "Source-of-funds statement", status: "received" },
      ],
      review: { riskRating: "unrated" },
    },
    // f. Six years with the bank, low-risk country, verified funds (a novice approves), but the owner faces a fraud prosecution:
    //    serious media escalates regardless of the relationship.
    {
      id: "NS-2026-0206",
      set: "heldout",
      submittedAt: "2026-10-02",
      customer: {
        name: "Aberdeen-Moyo Hospitality Group Ltd",
        entityType: "company",
        registrationNo: "BRW-C205533",
        country: "Brightwater",
        address: "21 Harbour Parade, Lumen Quay, Brightwater",
      },
      relationship: { status: "existing", accountAgeMonths: 72, relationshipManager: "Odile Brannock" },
      business: { sector: "Hospitality", description: "Four hotels and two restaurants.", declaredAnnualEur: 360_000 },
      owners: [
        { name: "Lucia Aberdeen-Moyo", role: "Director & majority shareholder", sharePct: 65, idVerified: true, pep: false },
        { name: "Mateus Aberdeen-Moyo", role: "Shareholder", sharePct: 35, idVerified: true, pep: false },
      ],
      screening: {
        sanctions: SYNTHETIC_SANCTIONS_CLEAR,
        adverseMedia: {
          status: "found",
          severity: "serious",
          detail: "Lucia Aberdeen-Moyo named in a court-bulletin report on a fraud prosecution (2026); trial pending.",
        },
      },
      funds: {
        sourceOfFunds: "verified",
        description: "Hotel and restaurant revenue; audited 2025 accounts reviewed.",
        expectedMonthlyVolumeEur: 27_000,
      },
      documents: [
        { name: "Company registry extract", status: "received" },
        { name: "Register of beneficial owners", status: "received" },
        { name: "Passport — Lucia Aberdeen-Moyo", status: "received" },
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
  // Judgment scenarios (appended, so the six above keep their ids and content).
  {
    entityType: "company",
    sectorRisk: "high",
    customerStatus: "existing",
    accountAgeMonths: 18,
    jurisdictionRisk: "low",
    sourceOfFunds: "verified",
    expectedMonthlyVolume: 45_000,
    uboVerified: true,
    pep: false,
    sanctionsHit: false,
    adverseMedia: false,
    ownershipTransparency: "direct",
    volumeConsistency: "consistent",
    nameMatch: "none",
  },
  {
    entityType: "company",
    ownershipTransparency: "nominee",
    jurisdictionRisk: "medium",
    sourceOfFunds: "verified",
    uboVerified: false,
    pep: false,
    sanctionsHit: false,
    adverseMedia: false,
    nameMatch: "none",
  },
  { entityType: "individual", nameMatch: "weak", jurisdictionRisk: "medium", sourceOfFunds: "verified", pep: false, sanctionsHit: false, adverseMedia: false },
  { entityType: "company", mediaSeverity: "serious", jurisdictionRisk: "low", sourceOfFunds: "verified", pep: false, sanctionsHit: false, nameMatch: "none" },
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
