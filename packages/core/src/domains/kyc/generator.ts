/**
 * Deterministic synthetic KYC case generator. Browser-safe and oracle-free: it knows the public
 * domain only. Every person, company, registry number, address and country is fictional.
 *
 * Determinism: all randomness comes from the caller's `Rng`, a seeded PRNG built on 32-bit integer
 * arithmetic (no Math.exp/log, which may differ between engines), so the same seed and specs yield
 * identical cases in the browser, on the server and in the bench.
 */
import { KycCaseSchema, NORTHSTAR_COUNTRIES, NORTHSTAR_COUNTRY_RISK, type CaseSet, type KycCase, type NorthstarCountry } from "./case";

/** Uniform in [0, 1). */
export type Rng = () => number;

/** mulberry32: a small, fast 32-bit seeded PRNG. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi]. */
export function intBetween(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, xs: readonly [T, ...T[]]): T {
  return xs[Math.floor(rng() * xs.length)] ?? xs[0];
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/** Draws a value with probability proportional to its weight (zero-weight values are never drawn). */
function weighted<T>(rng: Rng, options: readonly (readonly [T, number])[]): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  const r = rng() * total;
  let cumulative = 0;
  for (const [value, w] of options) {
    cumulative += w;
    if (r < cumulative) return value;
  }
  throw new RangeError("weighted: no option has a positive weight");
}

type EntityType = KycCase["customer"]["entityType"];
export type CountryRisk = (typeof NORTHSTAR_COUNTRY_RISK)[NorthstarCountry];

/** Decision-feature values a generated case must have (see `caseFeatures`); unspecified ones are drawn at random. */
export type KycFeatureTargets = {
  entityType: EntityType;
  customerStatus: KycCase["relationship"]["status"];
  accountAgeMonths: number;
  jurisdictionRisk: CountryRisk;
  uboOwnershipPct: number;
  uboVerified: boolean;
  pep: boolean;
  sanctionsHit: boolean;
  adverseMedia: boolean;
  sourceOfFunds: KycCase["funds"]["sourceOfFunds"];
  expectedMonthlyVolume: number;
};

export type KycCaseSpec = { id: string; set: CaseSet } & Partial<KycFeatureTargets>;

const FIRST_NAMES = [
  "Amara", "Bastian", "Chiara", "Dmitri", "Esme", "Farid", "Greta", "Hiroshi", "Ines", "Jonah", "Keziah", "Lior",
  "Mei", "Nikolai", "Oluwaseun", "Priya", "Quentin", "Rosalind", "Sefa", "Tomasz", "Ulla", "Valentin", "Wanjiru",
  "Xiomara", "Yusuf", "Zofia", "Anouk", "Bilal", "Catalina", "Desmond", "Elif", "Kenji", "Lucia", "Mateus",
] as const;
/** Disjoint from the surnames in the hand-designed demo cases (cases.ts), so generated cases never echo them. */
const LAST_NAMES = [
  "Brannock", "Drummore", "Eskildsen", "Fairweather", "Galloway-Shin", "Holloway", "Ironwood", "Jurado-Pike",
  "Kestrel", "Nakamura-Reid", "Pellegrin", "Rasmussen-Adeyemi", "Thorncastle", "Underhill", "Valcourt", "Whitlock",
  "Yarrowby", "Zelenko-Marsh", "Bellwether", "Corrigan-Diaz", "Brightmoor", "Calloway-Nkemelu", "Dunleavy", "Everhart",
  "Fenwick-Oduya", "Grimsdottir", "Hartigan", "Isakova-Penn", "Kovalenko-Byrne", "Mbatha-Sorensen",
] as const;
const SECTORS = [
  "Marine Logistics", "Agritrade", "Textile Imports", "Software Studio", "Renewables", "Freight Partners",
  "Medical Supplies", "Hospitality Group", "Precious Metals", "Construction", "Fine Foods", "Aviation Services",
] as const;
const COMPANY_SUFFIXES = ["Ltd", "Holdings Ltd", "& Co.", "LLC"] as const;
const TRUST_KINDS = ["Family Trust", "Heritage Trust", "Legacy Trust"] as const;
const STREETS = [
  "Quayside Row", "Lantern Street", "Old Mill Lane", "Harbour Parade", "Cedar Court", "Market Wynd", "Foundry Road",
  "Juniper Avenue", "Beacon Hill", "Tannery Close",
] as const;
const RELATIONSHIP_MANAGERS = [
  "Odile Brannock", "Kwame Ashby-Rourke", "Signe Valcourt", "Rafael Moreno-Teague", "Hana Kowalczyk", "Ade Fairweather",
] as const;

/** Fictional cities and registry prefixes per fictional country. */
const COUNTRY_INFO: Record<NorthstarCountry, { code: string; cities: readonly [string, ...string[]] }> = {
  Aldermere: { code: "ALD", cities: ["Port Elsby", "Wrenfield"] },
  Brightwater: { code: "BRW", cities: ["Lumen Quay", "Saltmarsh"] },
  Calderon: { code: "CAL", cities: ["Vey Harbour", "Orrin"] },
  "Dunmore Isles": { code: "DUN", cities: ["Kilbrae", "St. Aske"] },
  Estoria: { code: "EST", cities: ["Valmont", "Corsa"] },
  Faraway: { code: "FAR", cities: ["Endmoor", "Tallis"] },
  Galvania: { code: "GAL", cities: ["Brask", "Novo Tera"] },
  "Harrow Bay": { code: "HAR", cities: ["Gullhaven", "Crane Point"] },
  Isterra: { code: "IST", cities: ["Mirel", "Sabrak"] },
};

const MEDIA_SOURCES = ["regional newspaper", "trade journal", "court bulletin"] as const;
const MEDIA_TOPICS = ["a customs investigation", "an unpaid-supplier lawsuit", "a tax dispute", "a licensing breach"] as const;

const FUNDS_DESCRIPTIONS: Record<KycCase["funds"]["sourceOfFunds"], Record<EntityType, readonly [string, ...string[]]>> = {
  verified: {
    individual: [
      "Salary and savings; payslips and six months of bank statements reviewed.",
      "Inheritance; probate letter and bank transfer record reviewed.",
    ],
    company: [
      "Trading revenue; audited 2025 accounts and bank statements reviewed.",
      "Shareholder capital injection; bank confirmation reviewed.",
    ],
    trust: ["Settlor's sale of a family business; sale agreement and bank records reviewed."],
  },
  unverified: {
    individual: ["Customer states savings from employment; no documents reviewed yet."],
    company: ["Customer states trading revenue; accounts not yet received."],
    trust: ["Customer states the settlor's investment income; evidence not yet reviewed."],
  },
  not_provided: {
    individual: ["No source-of-funds information provided."],
    company: ["No source-of-funds information provided."],
    trust: ["No source-of-funds information provided."],
  },
};

/** Expected monthly volume buckets (EUR, multiples of 500), with each bucket's weight per entity type. */
const VOLUME_BUCKETS: readonly (readonly [number, number, Record<EntityType, number>])[] = [
  [1_000, 9_500, { individual: 0.5, company: 0.15, trust: 0.2 }],
  [10_000, 49_500, { individual: 0.4, company: 0.35, trust: 0.35 }],
  [50_000, 150_000, { individual: 0.1, company: 0.3, trust: 0.3 }],
  [150_500, 600_000, { individual: 0, company: 0.2, trust: 0.15 }],
];

/** Shares at and around the 25 % ownership mark, drawn often so the bench probes the boundary. */
const UBO_BOUNDARY_SHARES = [24.5, 25, 25.5, 26] as const;

/**
 * A synthetic case whose `caseFeatures` equal the given targets (others drawn at random). Throws on
 * contradictory targets: an individual must own 100 %, and `accountAgeMonths` is 0 exactly for new
 * customers. The result is validated with `KycCaseSchema`. `review.riskRating` starts "unrated".
 */
export function generateKycCase(rng: Rng, spec: KycCaseSpec): KycCase {
  const f = resolveFeatures(rng, spec);
  const country = pick(rng, countriesWithRisk(f.jurisdictionRisk));
  const { code, cities } = COUNTRY_INFO[country];
  const names = uniqueNames(rng);
  const customerName = companyName(rng, f.entityType, names);
  const owners = buildOwners(rng, f, customerName, names);
  const ubo = owners[0];
  const subject = pick(rng, [customerName, ...owners.map((o) => o.name)]);

  const sofDoc = f.sourceOfFunds === "not_provided" ? "missing" : "received";
  const idDoc = f.uboVerified ? "received" : pick(rng, ["missing", "expired"] as const);
  const documents: KycCase["documents"] =
    f.entityType === "individual"
      ? [
          { name: `Passport — ${ubo.name}`, status: idDoc },
          { name: "Proof of address", status: "received" },
          { name: "Source-of-funds statement", status: sofDoc },
        ]
      : [
          { name: f.entityType === "company" ? "Company registry extract" : "Trust deed", status: "received" },
          { name: "Register of beneficial owners", status: "received" },
          { name: `Passport — ${ubo.name}`, status: idDoc },
          { name: "Source-of-funds statement", status: sofDoc },
        ];

  const registryKind = { individual: "P", company: "C", trust: "T" }[f.entityType];
  return KycCaseSchema.parse({
    id: spec.id,
    set: spec.set,
    submittedAt: new Date(Date.UTC(2026, 8, 1 + intBetween(rng, 0, 32))).toISOString().slice(0, 10),
    customer: {
      name: customerName,
      entityType: f.entityType,
      registrationNo: `${code}-${registryKind}${intBetween(rng, 100_000, 999_999)}`,
      country,
      address: `${intBetween(rng, 1, 220)} ${pick(rng, STREETS)}, ${pick(rng, cities)}, ${country}`,
    },
    relationship: {
      status: f.customerStatus,
      accountAgeMonths: f.accountAgeMonths,
      relationshipManager: pick(rng, RELATIONSHIP_MANAGERS),
    },
    owners,
    screening: {
      sanctions: f.sanctionsHit
        ? {
            status: "match",
            detail: `Potential match: ${subject} — ${intBetween(rng, 88, 99)}% name similarity to entry NSL-${intBetween(rng, 1000, 9999)} on the Northstar Synthetic Sanctions List.`,
          }
        : { status: "clear", detail: "No match on the Northstar Synthetic Sanctions List." },
      adverseMedia: f.adverseMedia
        ? {
            status: "found",
            detail: `${subject} named in a ${pick(rng, MEDIA_SOURCES)} report on ${pick(rng, MEDIA_TOPICS)} (${intBetween(rng, 2023, 2025)}).`,
          }
        : { status: "none", detail: "No relevant adverse media found." },
    },
    funds: {
      sourceOfFunds: f.sourceOfFunds,
      description: pick(rng, FUNDS_DESCRIPTIONS[f.sourceOfFunds][f.entityType]),
      expectedMonthlyVolumeEur: f.expectedMonthlyVolume,
    },
    documents,
    review: { riskRating: "unrated" },
  });
}

function resolveFeatures(rng: Rng, spec: KycCaseSpec): KycFeatureTargets {
  const entityType = spec.entityType ?? weighted(rng, [["individual", 0.4], ["company", 0.45], ["trust", 0.15]]);
  const customerStatus =
    spec.customerStatus ??
    (spec.accountAgeMonths !== undefined ? (spec.accountAgeMonths === 0 ? "new" : "existing") : chance(rng, 0.55) ? "new" : "existing");
  const accountAgeMonths = spec.accountAgeMonths ?? (customerStatus === "new" ? 0 : intBetween(rng, 1, 120));
  const uboOwnershipPct =
    spec.uboOwnershipPct ??
    (entityType === "individual" ? 100 : chance(rng, 0.2) ? pick(rng, UBO_BOUNDARY_SHARES) : intBetween(rng, 10, 100));
  const f: KycFeatureTargets = {
    entityType,
    customerStatus,
    accountAgeMonths,
    jurisdictionRisk: spec.jurisdictionRisk ?? weighted(rng, [["low", 0.45], ["medium", 0.35], ["high", 0.2]]),
    uboOwnershipPct,
    uboVerified: spec.uboVerified ?? chance(rng, 0.75),
    pep: spec.pep ?? chance(rng, 0.08),
    sanctionsHit: spec.sanctionsHit ?? chance(rng, 0.03),
    adverseMedia: spec.adverseMedia ?? chance(rng, 0.12),
    sourceOfFunds: spec.sourceOfFunds ?? weighted(rng, [["verified", 0.6], ["unverified", 0.25], ["not_provided", 0.15]]),
    expectedMonthlyVolume: spec.expectedMonthlyVolume ?? drawVolume(rng, entityType),
  };
  if (f.entityType === "individual" && f.uboOwnershipPct !== 100)
    throw new RangeError(`case ${spec.id}: an individual owns 100%, not ${f.uboOwnershipPct}%`);
  if (f.uboOwnershipPct <= 0 || f.uboOwnershipPct > 100) throw new RangeError(`case ${spec.id}: uboOwnershipPct must be in (0, 100]`);
  if ((f.customerStatus === "new") !== (f.accountAgeMonths === 0))
    throw new RangeError(`case ${spec.id}: accountAgeMonths is 0 exactly for new customers`);
  return f;
}

function drawVolume(rng: Rng, entityType: EntityType): number {
  const [lo, hi] = weighted(rng, VOLUME_BUCKETS.map(([lo, hi, weights]) => [[lo, hi], weights[entityType]] as const));
  return intBetween(rng, lo / 500, hi / 500) * 500;
}

function countriesWithRisk(risk: CountryRisk): [NorthstarCountry, ...NorthstarCountry[]] {
  const matching = NORTHSTAR_COUNTRIES.filter((c) => NORTHSTAR_COUNTRY_RISK[c] === risk);
  const [first, ...rest] = matching;
  if (first === undefined) throw new Error(`no Northstar country has risk "${risk}"`);
  return [first, ...rest];
}

/** An endless supply of person names, unique within one case. */
function uniqueNames(rng: Rng): () => string {
  const used = new Set<string>();
  return () => {
    for (;;) {
      const name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
}

function companyName(rng: Rng, entityType: EntityType, nextName: () => string): string {
  if (entityType === "individual") return nextName();
  const surname = pick(rng, LAST_NAMES);
  return entityType === "company"
    ? `${surname} ${pick(rng, SECTORS)} ${pick(rng, COMPANY_SUFFIXES)}`
    : `${surname} ${pick(rng, TRUST_KINDS)}`;
}

type Owner = KycCase["owners"][number];

/** Largest owner first (so `largestOwner` picks it); every other share is strictly smaller and the total stays ≤ 100. */
function buildOwners(rng: Rng, f: KycFeatureTargets, customerName: string, nextName: () => string): [Owner, ...Owner[]] {
  if (f.entityType === "individual")
    return [{ name: customerName, role: "Account holder", sharePct: 100, idVerified: f.uboVerified, pep: f.pep }];

  const trust = f.entityType === "trust";
  const owners: [Owner, ...Owner[]] = [
    {
      name: nextName(),
      role: trust ? "Settlor & beneficiary" : f.uboOwnershipPct > 50 ? "Director & majority shareholder" : "Director & shareholder",
      sharePct: f.uboOwnershipPct,
      idVerified: f.uboVerified,
      pep: false,
    },
  ];
  let remaining = 100 - f.uboOwnershipPct;
  for (let k = intBetween(rng, 1, 3); k > 0; k--) {
    const cap = Math.min(Math.ceil(f.uboOwnershipPct) - 1, Math.floor(remaining));
    if (cap < 1) break;
    const sharePct = intBetween(rng, Math.max(1, Math.floor(cap / 3)), cap);
    remaining -= sharePct;
    owners.push({ name: nextName(), role: trust ? "Beneficiary" : "Shareholder", sharePct, idVerified: chance(rng, 0.85), pep: false });
  }
  if (f.pep) {
    const politicallyExposed = owners[intBetween(rng, 0, owners.length - 1)];
    if (politicallyExposed !== undefined) politicallyExposed.pep = true;
  }
  return owners;
}
