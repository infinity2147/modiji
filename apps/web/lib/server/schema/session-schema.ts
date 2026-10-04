/**
 * The session's schema state (feature model, undefined concepts, backfilled values), folded from its
 * ledger by core's `foldSessionSchema` over the base KYC domain. Read-only; the ledger is the source of
 * truth, so a restarted process derives exactly the same feature model.
 */
import "server-only";
import { SCHEMA_LEDGER_KINDS, foldSessionSchema, type SessionSchema } from "@vashistha/core";
import type { Ledger } from "@vashistha/core/server";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { CASEDESK_SCHEMA_VERSION } from "../casedesk/session";

export function sessionSchema(ledger: Pick<Ledger, "list">, sessionId: string): SessionSchema {
  return foldSessionSchema(KYC_DOMAIN, ledger.list(sessionId, { kinds: [...SCHEMA_LEDGER_KINDS] }), CASEDESK_SCHEMA_VERSION);
}
