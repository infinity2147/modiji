/**
 * The cases of a CaseDesk session: its case set, plus the synthetic cases generated for it
 * (`case.generated`: tutor practice cases at a rule boundary or contrast, judge-entered cases). Generated cases
 * exist only in the session that recorded them; the ledger is their only store.
 */
import "server-only";
import { parseLedgerPayload, type LedgerEntry } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { KycCaseSchema, findKycCase, kycCases, type KycCase } from "@vashistha/core/domains/kyc";
import type { CaseDeskSessionInfo } from "./session";

export type GeneratedCase = { kycCase: KycCase; entry: LedgerEntry };

/** The session's generated cases, in the order they were recorded. */
export function generatedCases(ledger: Pick<Ledger, "list">, sessionId: string): GeneratedCase[] {
  return ledger
    .list(sessionId, { kinds: ["case.generated"] })
    .map((entry) => ({ kycCase: KycCaseSchema.parse(parseLedgerPayload(entry, "case.generated").case), entry }));
}

/** Every case the session may work: its set first, then its generated cases. */
export function sessionCases(ledger: Pick<Ledger, "list">, sessionId: string, info: CaseDeskSessionInfo): KycCase[] {
  return [...kycCases(info.caseSet), ...generatedCases(ledger, sessionId).map((g) => g.kycCase)];
}

/** The case with this id in the session (its set or generated for it), or undefined. */
export function findSessionCase(ledger: Pick<Ledger, "list">, sessionId: string, info: CaseDeskSessionInfo, caseId: string): KycCase | undefined {
  const fromSet = findKycCase(caseId);
  if (fromSet?.set === info.caseSet) return fromSet;
  return generatedCases(ledger, sessionId).find((g) => g.kycCase.id === caseId)?.kycCase;
}
