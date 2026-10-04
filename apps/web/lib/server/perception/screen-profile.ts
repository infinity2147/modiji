/**
 * What the CaseDesk UI shows and lets a reviewer edit — declared properties of this app's screen, used
 * by vision extraction (never inferred by the model):
 *
 * - Editable fields, to tell an edit from a case switch. The CaseDesk review panel
 *   (`components/casedesk/review-panel.tsx`) has exactly one input over a case field: the risk-rating
 *   select. Every other case field (customer, relationship, business, owners, screening, source of funds)
 *   is rendered read-only; the outcome radio group is an action, read as the committed decision.
 * - The chrome lexicon (`CASEDESK_CHROME`): the app's own labels, on screen whatever the case. A concept
 *   vision proposes from them ("screeningSourceOfFundsDocuments" from the section headings, "caseStructure"
 *   from the tabs — live run P4 attempt 1) describes the screen, not the case, and is dropped.
 *
 * Change these together with the components (a test checks every label is still rendered by one).
 * Dependency-free beyond the domain and the perception package, so the P2 evaluation script can use
 * the same declaration.
 */
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { screenProfile, type ScreenProfile } from "@vashistha/perception/extraction";

export const CASEDESK_CHROME: readonly string[] = [
  // Top bar and launcher (components/casedesk/top-bar.tsx, launcher.tsx, labels.ts).
  "CaseDesk",
  "Northstar Bank",
  "Expert capture",
  "Novice practice",
  // Case queue (case-queue.tsx).
  "Case queue",
  "Cases decided",
  // Case file: header and section headings (case-detail.tsx).
  "Submitted",
  "Customer",
  "Relationship",
  "Business",
  "Beneficial owners",
  "Screening",
  "Source of funds",
  "Documents",
  // Beneficial-owner table column headers (case-detail.tsx).
  "Name",
  "Role",
  "Share",
  "ID verified",
  "PEP",
  // Review panel and the interlock dialog (review-panel.tsx, interlock-dialog.tsx).
  "Review",
  "Risk rating",
  "Outcome",
  "Save decision",
  "Interlock",
  "Ledger entry",
  "Escalate",
  // Judge overlays: compliance strip, event ticker, HUD (components/judge/*).
  "Compliance",
  "computed from the ledger",
  "Ledger events",
  "Question value",
  "Speech gate",
  "Gate conditions",
  // Concepts panel (components/concepts/concepts-panel.tsx).
  "Confirmed concepts",
];

export const CASEDESK_SCREEN: ScreenProfile = screenProfile(KYC_DOMAIN, ["riskRating"], CASEDESK_CHROME);
