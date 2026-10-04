/**
 * Deterministic synthetic KYC case generator. Browser-safe and oracle-free: it knows the public
 * domain only. Every person, company, registry number, address and country is fictional.
 *
 * Determinism: all randomness comes from the caller's `Rng`, a seeded PRNG built on 32-bit integer
 * arithmetic (no Math.exp/log, which may differ between engines), so the same seed and specs yield
 * identical cases in the browser, on the server and in the bench.
 */
import {
  KycCaseSchema,
  NORTHSTAR_COUNTRIES,
  NORTHSTAR_COUNTRY_RISK,
  NORTHSTAR_SECTORS,
  NORTHSTAR_SECTOR_RISK,
  volumeConsistency,
  type CaseSet,
  type KycCase,
  type NorthstarCountry,
  type NorthstarSector,
} from "./case";

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
  /**
   * Judgment features. Left unspecified they are neutral (a low or medium sector chosen with the company name, direct
   * ownership, consistent volume, no name match, severity minor when media is found) and draw no randomness, so cases
   * generated before they existed are unchanged.
   */
  sectorRisk?: CountryRisk;
  ownershipTransparency?: "direct" | "layered" | "nominee";
  volumeConsistency?: "consistent" | "elevated" | "inconsistent";
  mediaSeverity?: "none" | "minor" | "serious";
  nameMatch?: "none" | "weak" | "strong";
};
/** The targets after defaults: the judgment features are all set, except a sector tier, which an untargeted company takes from its name. */
type Resolved = Omit<KycFeatureTargets, "ownershipTransparency" | "volumeConsistency" | "mediaSeverity" | "nameMatch"> &
  Required<Pick<KycFeatureTargets, "ownershipTransparency" | "volumeConsistency" | "mediaSeverity" | "nameMatch">>;

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
/** The sector a company name's word stands for, none of them high risk: unspecified, a generated case never trips the sector rules. */
const DEFAULT_SECTOR_OF_WORD: Record<(typeof SECTORS)[number], NorthstarSector> = {
  "Marine Logistics": "Marine logistics",
  Agritrade: "Agricultural trade",
  "Textile Imports": "Textile imports",
  "Software Studio": "Software and IT services",
  Renewables: "Energy and utilities",
  "Freight Partners": "Marine logistics",
  "Medical Supplies": "Healthcare supplies",
  "Hospitality Group": "Hospitality",
  "Precious Metals": "Commodities trading",
  Construction: "Construction",
  "Fine Foods": "Agricultural trade",
  "Aviation Services": "Professional services",
};
/** The name a company in a sector carries, when the sector is a target. */
const WORD_OF_SECTOR: Record<NorthstarSector, string> = {
  "Salaried or private individual": "",
  "Private wealth (trust)": "",
  "Professional services": "Advisory",
  "Software and IT services": "Software Studio",
  "Healthcare supplies": "Medical Supplies",
  Hospitality: "Hospitality Group",
  "Marine logistics": "Marine Logistics",
  "Agricultural trade": "Agritrade",
  "Textile imports": "Textile Imports",
  "Commodities trading": "Commodities",
  Construction: "Construction",
  "Real estate brokerage": "Property Brokers",
  "Energy and utilities": "Renewables",
  "Cash-intensive retail": "Laundrettes",
  "Currency exchange and remittance": "Exchange & Remittance",
  "Precious metals and jewellery": "Jewellers",
  "Online gaming": "Gaming",
};
const COMPANY_ONLY_SECTORS = NORTHSTAR_SECTORS.filter((x) => x !== "Salaried or private individual" && x !== "Private wealth (trust)");
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
const SERIOUS_MEDIA_TOPICS = [
  "a bribery prosecution of a public official",
  "a fraud conviction",
  "a corruption investigation involving public contracts",
] as const;

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
  const { name: nameTemplate, word } = companyName(rng, f.entityType, names, f.sectorRisk);
  const sector = sectorFor(rng, f.entityType, word, f.sectorRisk);
  const customerName = nameTemplate.replace("{sector}", WORD_OF_SECTOR[sector]);
  const owners = buildOwners(rng, f, customerName, names);
  const ubo = owners[0];
  const subject = pick(rng, [customerName, ...owners.map((o) => o.name)]);

  const sofDoc = f.sourceOfFunds === "not_provided" ? "missing" : "received";
  const idDoc = f.uboVerified ? "received" : pick(rng, ["missing", "expired"] as const);
  const structureDocs: KycCase["documents"] =
    f.ownershipTransparency === "nominee"
      ? [{ name: "Nominator declaration", status: "missing" }]
      : f.ownershipTransparency === "layered"
        ? [{ name: `Registry extract — ${ubo.name}`, status: idDoc }]
        : [{ name: `Passport — ${ubo.name}`, status: idDoc }];
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
          ...structureDocs,
          { name: "Source-of-funds statement", status: sofDoc },
        ];

  const registryKind = { individual: "P", company: "C", trust: "T" }[f.entityType];
  const draft = {
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
            status: "match" as const,
            detail: `Potential match: ${subject} — ${intBetween(rng, 88, 99)}% name similarity to entry NSL-${intBetween(rng, 1000, 9999)} on the Northstar Synthetic Sanctions List.`,
          }
        : { status: "clear" as const, detail: "No match on the Northstar Synthetic Sanctions List." },
      adverseMedia: f.adverseMedia
        ? {
            status: "found" as const,
            severity: f.mediaSeverity === "serious" ? ("serious" as const) : ("minor" as const),
            detail:
              f.mediaSeverity === "serious"
                ? `${subject} named in a ${pick(rng, MEDIA_SOURCES)} report on ${pick(rng, SERIOUS_MEDIA_TOPICS)} (${intBetween(rng, 2024, 2026)}).`
                : `${subject} named in a ${pick(rng, MEDIA_SOURCES)} report on ${pick(rng, MEDIA_TOPICS)} (${intBetween(rng, 2023, 2025)}).`,
          }
        : { status: "none" as const, severity: "minor" as const, detail: "No relevant adverse media found." },
      nameMatch: nameMatchFor(rng, f.nameMatch, subject),
    },
    funds: {
      sourceOfFunds: f.sourceOfFunds,
      description: pick(rng, FUNDS_DESCRIPTIONS[f.sourceOfFunds][f.entityType]),
      expectedMonthlyVolumeEur: f.expectedMonthlyVolume,
    },
    documents,
    review: { riskRating: "unrated" as const },
  };
  const declaredAnnualEur = declaredTurnover(rng, draft, f);
  return KycCaseSchema.parse({
    ...draft,
    business: { sector, description: businessDescription(sector, f.entityType), declaredAnnualEur },
  });
}

function nameMatchFor(rng: Rng, strength: Resolved["nameMatch"], subject: string): KycCase["screening"]["nameMatch"] {
  if (strength === "none") return { strength, detail: "No similar names on the Northstar Synthetic Sanctions List." };
  const entry = `NSL-${intBetween(rng, 1000, 9999)}`;
  return strength === "strong"
    ? {
        strength,
        detail: `${subject} — ${intBetween(rng, 95, 99)}% name similarity to entry ${entry}; date of birth and nationality also match. Not yet cleared.`,
      }
    : {
        strength,
        detail: `${subject} — ${intBetween(rng, 74, 84)}% name similarity to entry ${entry}; date of birth and nationality differ.`,
      };
}

/** A company's sector: the one its name word stands for, or one of the targeted risk tier. Individuals and trusts have fixed low-risk profiles. */
function sectorFor(rng: Rng, entityType: EntityType, word: (typeof SECTORS)[number] | undefined, target: CountryRisk | undefined): NorthstarSector {
  if (entityType !== "company") {
    if (target !== undefined && target !== "low") throw new RangeError(`only a company can be in a ${target}-risk sector`);
    return entityType === "individual" ? "Salaried or private individual" : "Private wealth (trust)";
  }
  if (target === undefined) return word === undefined ? "Professional services" : DEFAULT_SECTOR_OF_WORD[word];
  const options = COMPANY_ONLY_SECTORS.filter((x) => NORTHSTAR_SECTOR_RISK[x] === target);
  const [first, ...rest] = options;
  if (first === undefined) throw new RangeError(`no sector has risk "${target}"`);
  return pick(rng, [first, ...rest]);
}

function businessDescription(sector: NorthstarSector, entityType: EntityType): string {
  if (entityType === "individual") return "Salaried employment and personal savings.";
  if (entityType === "trust") return "Holds family investments for its beneficiaries.";
  return `${sector}: trades with business customers and suppliers.`;
}

/**
 * The declared annual turnover that puts the case's expected volume in the targeted consistency band. Unspecified bands draw
 * no randomness (about 0.9x); a band that rounding would miss falls back to the exact figure.
 */
function declaredTurnover(rng: Rng, draft: Parameters<typeof KycCaseSchema.parse>[0], f: Resolved): number {
  const annual = f.expectedMonthlyVolume * 12;
  if (annual === 0) {
    if (f.volumeConsistency !== "consistent") throw new RangeError("no volume is expected, so it cannot exceed the declared turnover");
    return 0;
  }
  const ratio =
    f.volumeConsistency === "consistent"
      ? 0.9
      : f.volumeConsistency === "elevated"
        ? 1.5 + Math.floor(rng() * 7) / 10
        : 3 + Math.floor(rng() * 21) / 10;
  const fits = (declared: number): boolean => {
    try {
      const parsed = KycCaseSchema.parse({ ...(draft as object), business: { sector: "Professional services", description: "", declaredAnnualEur: declared } });
      return volumeConsistency(parsed) === f.volumeConsistency;
    } catch {
      return false;
    }
  };
  const rounded = Math.max(1000, Math.round(annual / ratio / 1000) * 1000);
  if (fits(rounded)) return rounded;
  const exact = Math.max(1, Math.round(annual / ratio));
  if (fits(exact)) return exact;
  throw new RangeError(`cannot declare a turnover that makes EUR ${f.expectedMonthlyVolume} a month ${f.volumeConsistency}`);
}

function resolveFeatures(rng: Rng, spec: KycCaseSpec): Resolved {
  const entityType = spec.entityType ?? weighted(rng, [["individual", 0.4], ["company", 0.45], ["trust", 0.15]]);
  const customerStatus =
    spec.customerStatus ??
    (spec.accountAgeMonths !== undefined ? (spec.accountAgeMonths === 0 ? "new" : "existing") : chance(rng, 0.55) ? "new" : "existing");
  const accountAgeMonths = spec.accountAgeMonths ?? (customerStatus === "new" ? 0 : intBetween(rng, 1, 120));
  const uboOwnershipPct =
    spec.uboOwnershipPct ??
    (entityType === "individual" ? 100 : chance(rng, 0.2) ? pick(rng, UBO_BOUNDARY_SHARES) : intBetween(rng, 10, 100));
  const f: Resolved = {
    entityType,
    customerStatus,
    accountAgeMonths,
    jurisdictionRisk: spec.jurisdictionRisk ?? weighted(rng, [["low", 0.45], ["medium", 0.35], ["high", 0.2]]),
    uboOwnershipPct,
    uboVerified: spec.uboVerified ?? chance(rng, 0.75),
    pep: spec.pep ?? chance(rng, 0.08),
    sanctionsHit: spec.sanctionsHit ?? chance(rng, 0.03),
    // A targeted severity decides whether there is media at all, so it replaces the random draw.
    adverseMedia: spec.adverseMedia ?? (spec.mediaSeverity !== undefined ? spec.mediaSeverity !== "none" : chance(rng, 0.12)),
    sourceOfFunds: spec.sourceOfFunds ?? weighted(rng, [["verified", 0.6], ["unverified", 0.25], ["not_provided", 0.15]]),
    expectedMonthlyVolume: spec.expectedMonthlyVolume ?? drawVolume(rng, entityType),
    ...(spec.sectorRisk !== undefined && { sectorRisk: spec.sectorRisk }),
    ownershipTransparency: spec.ownershipTransparency ?? "direct",
    volumeConsistency: spec.volumeConsistency ?? "consistent",
    mediaSeverity: "none",
    nameMatch: spec.nameMatch ?? "none",
  };
  f.mediaSeverity = !f.adverseMedia ? "none" : (spec.mediaSeverity ?? "minor");
  if (spec.mediaSeverity !== undefined && (spec.mediaSeverity !== "none") !== f.adverseMedia)
    throw new RangeError(`case ${spec.id}: adverse media ${f.adverseMedia ? "is" : "is not"} found, so its severity cannot be ${spec.mediaSeverity}`);
  if (f.entityType === "individual" && f.ownershipTransparency !== "direct")
    throw new RangeError(`case ${spec.id}: an individual has no holding company or nominee above them`);
  if (f.sanctionsHit && f.nameMatch !== "none")
    throw new RangeError(`case ${spec.id}: a confirmed sanctions match supersedes a name match`);
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

function companyName(rng: Rng, entityType: EntityType, nextName: () => string, targetSector: CountryRisk | undefined): { name: string; word?: (typeof SECTORS)[number] } {
  if (entityType === "individual") return { name: nextName() };
  const surname = pick(rng, LAST_NAMES);
  if (entityType === "trust") return { name: `${surname} ${pick(rng, TRUST_KINDS)}` };
  // The word and suffix are drawn either way so the random stream is the same whether or not a sector is targeted.
  const word = pick(rng, SECTORS);
  const suffix = pick(rng, COMPANY_SUFFIXES);
  return { name: `${surname} ${targetSector === undefined ? word : "{sector}"} ${suffix}`, word };
}

type Owner = KycCase["owners"][number];

/** Largest owner first (so `largestOwner` picks it); every other share is strictly smaller and the total stays ≤ 100. */
function buildOwners(rng: Rng, f: Resolved, customerName: string, nextName: () => string): [Owner, ...Owner[]] {
  if (f.entityType === "individual")
    return [{ name: customerName, role: "Account holder", sharePct: 100, idVerified: f.uboVerified, pep: f.pep, kind: "person" }];

  const trust = f.entityType === "trust";
  const largestName = nextName();
  const surname = largestName.split(" ").slice(1).join(" ") || largestName;
  const structure = f.ownershipTransparency;
  const largest: Owner =
    structure === "nominee"
      ? {
          name: `${surname} Nominees Ltd`,
          role: "Nominee shareholder",
          sharePct: f.uboOwnershipPct,
          idVerified: f.uboVerified,
          pep: false,
          kind: "nominee",
          controller: "Not disclosed. Nominator declaration outstanding.",
        }
      : structure === "layered"
        ? {
            name: `${surname} Holdings Ltd`,
            role: "Corporate shareholder",
            sharePct: f.uboOwnershipPct,
            idVerified: f.uboVerified,
            pep: false,
            kind: "holding_company",
            controller: `Wholly held by ${nextName()} (identity ${f.uboVerified ? "verified" : "not verified"}).`,
          }
        : {
            name: largestName,
            role: trust ? "Settlor & beneficiary" : f.uboOwnershipPct > 50 ? "Director & majority shareholder" : "Director & shareholder",
            sharePct: f.uboOwnershipPct,
            idVerified: f.uboVerified,
            pep: false,
            kind: "person",
          };
  const owners: [Owner, ...Owner[]] = [largest];
  let remaining = 100 - f.uboOwnershipPct;
  // A holding company or nominee always sits beside at least one named person, who can carry a PEP flag.
  for (let k = Math.max(intBetween(rng, 1, 3), structure === "direct" ? 0 : 1); k > 0; k--) {
    const cap = Math.min(Math.ceil(f.uboOwnershipPct) - 1, Math.floor(remaining));
    if (cap < 1) break;
    const sharePct = intBetween(rng, Math.max(1, Math.floor(cap / 3)), cap);
    remaining -= sharePct;
    owners.push({ name: nextName(), role: trust ? "Beneficiary" : "Shareholder", sharePct, idVerified: chance(rng, 0.85), pep: false, kind: "person" });
  }
  if (f.pep && !owners.some((o) => o.kind === "person"))
    owners.push({ name: nextName(), role: "Controlling person", sharePct: 0, idVerified: true, pep: false, kind: "person" });
  if (f.pep) {
    const people = owners.filter((o) => o.kind === "person");
    const politicallyExposed = people[intBetween(rng, 0, people.length - 1)];
    if (politicallyExposed === undefined) throw new RangeError("a PEP needs a named person among the owners");
    politicallyExposed.pep = true;
  }
  return owners;
}
