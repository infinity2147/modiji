/**
 * Who may start which kind of session, in one table the server enforces and the launcher renders
 * (browser-safe). The server re-checks every rule; the UI only shows it, with the reason.
 *
 * - An expert captures on the TRAINING set only: held-out cases must stay unseen by the rulebook, or
 *   the tutor stopping a mistake on one would no longer prove the judgment transferred.
 * - A trainee practises (novice mode, interlock and tutor on) on the practice set or takes the
 *   held-out assessment. A novice session never writes a rule.
 * - An admin may run novice sessions (to demo the tutor) but never captures: nobody confirms rules
 *   in an expert's name.
 */
import type { UserRole } from "@vashistha/core";
import type { CaseSet } from "@vashistha/core/domains/kyc";
import type { SessionMode } from "../contracts/casedesk";

export type ServedCaseSet = Exclude<CaseSet, "bench">;

export const SERVED_CASE_SET_LIST: readonly ServedCaseSet[] = ["training", "practice", "heldout"];

/** The one kind of session each role starts: its mode and the case sets it may work. */
export const SESSION_STARTS: Readonly<Record<UserRole, { mode: SessionMode; caseSets: readonly ServedCaseSet[] }>> = {
  expert: { mode: "expert", caseSets: ["training"] },
  trainee: { mode: "novice", caseSets: ["practice", "heldout"] },
  admin: { mode: "novice", caseSets: ["practice", "heldout"] },
};

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = { trainee: "Trainee", expert: "Expert", admin: "Admin" };

/** Why `role` may not start a `mode` session on `caseSet`; undefined when it may. */
export function startRefusal(role: UserRole, mode: SessionMode, caseSet: ServedCaseSet): string | undefined {
  const allowed = SESSION_STARTS[role];
  if (mode !== allowed.mode) {
    if (mode === "expert")
      return role === "admin"
        ? "Admins manage accounts; they never capture or confirm rules in an expert's name."
        : "Only experts capture: their words become rules. An admin grants the expert role.";
    return "Experts capture; novice practice is for trainees.";
  }
  if (allowed.caseSets.includes(caseSet)) return undefined;
  if (caseSet === "heldout") return "Held-out cases stay unseen by experts, so the tutor's transfer test stays honest.";
  if (caseSet === "training") return "Training cases are the experts' capture set.";
  return "Practice cases are for trainees.";
}

/** Case sets a role may list without a session: what it may start, and every set for an admin. */
export function listableCaseSets(role: UserRole): readonly ServedCaseSet[] {
  return role === "admin" ? SERVED_CASE_SET_LIST : SESSION_STARTS[role].caseSets;
}
