/**
 * What the CaseDesk UI lets a reviewer edit — a declared property of this app's screen, used by
 * vision extraction to tell an edit from a case switch (never inferred by the model).
 *
 * The CaseDesk review panel (`components/casedesk/review-panel.tsx`) has exactly one input over a
 * case field: the risk-rating select. Every other case field (customer, relationship, owners,
 * screening, source of funds) is rendered read-only; the outcome radio group is an action, read as
 * the committed decision. Change this list together with the review panel.
 *
 * Dependency-free beyond the domain and the perception package, so the P2 evaluation script can use
 * the same declaration.
 */
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { screenProfile, type ScreenProfile } from "@vashistha/perception/extraction";

export const CASEDESK_SCREEN: ScreenProfile = screenProfile(KYC_DOMAIN, ["riskRating"]);
