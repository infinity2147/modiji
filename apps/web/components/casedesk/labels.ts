import type { CaseSet, KycCase } from "@vashistha/core/domains/kyc";
import type { SessionMode } from "@/lib/contracts/casedesk";

export const MODE_LABELS: Record<SessionMode, string> = { expert: "Expert capture", novice: "Novice practice" };

export const SET_LABELS: Record<CaseSet, string> = {
  training: "Training",
  heldout: "Held-out",
  practice: "Practice",
  bench: "Benchmark",
};

export const ENTITY_LABELS: Record<KycCase["customer"]["entityType"], string> = {
  individual: "Individual",
  company: "Company",
  trust: "Trust",
};

export const SOURCE_OF_FUNDS_LABELS: Record<KycCase["funds"]["sourceOfFunds"], string> = {
  verified: "Verified",
  unverified: "Unverified",
  not_provided: "Not provided",
};

export const DOCUMENT_STATUS_LABELS: Record<KycCase["documents"][number]["status"], string> = {
  received: "Received",
  missing: "Missing",
  expired: "Expired",
};

/** How a shareholding is held, shown under a non-person owner's name. */
export const OWNER_KIND_LABELS: Record<KycCase["owners"][number]["kind"], string> = {
  person: "Person",
  holding_company: "Holding company",
  nominee: "Nominee",
};

/** Name-only similarity to a sanctions-list entry (`nameMatch`). */
export const NAME_MATCH_LABELS: Record<KycCase["screening"]["nameMatch"]["strength"], string> = {
  none: "None",
  weak: "Weak (name only)",
  strong: "Strong (date of birth and nationality align)",
};

/** Adverse-media severity, shown only when media was found (`mediaSeverity`). */
export const MEDIA_SEVERITY_LABELS: Record<KycCase["screening"]["adverseMedia"]["severity"], string> = {
  minor: "Minor",
  serious: "Serious",
};

/** Expected activity against declared turnover (`volumeConsistency`, bands from the public domain description). */
export const VOLUME_CONSISTENCY_LABELS: Record<"consistent" | "elevated" | "inconsistent", string> = {
  consistent: "Consistent",
  elevated: "Elevated",
  inconsistent: "Inconsistent",
};
