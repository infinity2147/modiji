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
