/**
 * `pnpm preflight`'s end-to-end speech check (plan §12): a fixed question is authorised, so the
 * script can prove the custom-LLM path speaks with a valid nonce and stays silent on a replay.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { formatControlMessage } from "@vashistha/core";
import type { AgentRole, Ledger } from "@vashistha/core/server";
import { MAX_AUTHORIZATION_TTL_MS, nonceDigest, type AuthorizationStore } from "./authorizations";

/** The only text this route can ever authorise. */
export const PREFLIGHT_QUESTION = "Preflight check. Can you hear me clearly?";
export const PREFLIGHT_QUESTION_ID = "preflight";
const PREFLIGHT_AGENT: AgentRole = "interviewer";
/** Room for the script to start an ElevenLabs conversation before sending the control message. */
const PREFLIGHT_TTL_MS = MAX_AUTHORIZATION_TTL_MS;

export type PreflightAuthorization = {
  sessionId: string;
  nonce: string;
  controlMessage: string;
  text: string;
  expiresAt: number;
};

export type PreflightDeps = {
  ledger: Pick<Ledger, "createSession" | "append">;
  authorizations: Pick<AuthorizationStore, "issue" | "getContextVersion">;
  now: () => number;
};

/** Creates a fresh `preflight-<uuid>` ledger session and authorises the preflight question in it. */
export function issuePreflightAuthorization(deps: PreflightDeps): PreflightAuthorization {
  const session = deps.ledger.createSession({ id: `preflight-${randomUUID()}` });
  const authorization = deps.authorizations.issue({
    sessionId: session.id,
    agent: PREFLIGHT_AGENT,
    questionId: PREFLIGHT_QUESTION_ID,
    text: PREFLIGHT_QUESTION,
    contextVersion: deps.authorizations.getContextVersion(session.id),
    ttlMs: PREFLIGHT_TTL_MS,
  });
  deps.ledger.append({
    sessionId: session.id,
    source: "engine",
    kind: "gate.authorization_issued",
    occurredAt: deps.now(),
    traceId: session.id,
    parentIds: [],
    schemaVersion: 1,
    privacyEpoch: session.privacyEpoch,
    payload: {
      agent: PREFLIGHT_AGENT,
      questionId: authorization.questionId,
      contextVersion: authorization.contextVersion,
      expiresAt: authorization.expiresAt,
      nonceDigest: nonceDigest(authorization.nonce),
    },
  });
  return {
    sessionId: session.id,
    nonce: authorization.nonce,
    controlMessage: formatControlMessage(authorization.nonce),
    text: PREFLIGHT_QUESTION,
    expiresAt: authorization.expiresAt,
  };
}
