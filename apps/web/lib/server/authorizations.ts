/**
 * Speech authorizations (plan §7.2). The deterministic gate issues a single-use nonce for one
 * precomputed question; the custom-LLM wrapper speaks only when it consumes a valid one.
 *
 * Lifecycle: issued → in_flight → used. ElevenLabs retries the same custom LLM on errors, timeouts
 * and empty responses (llm-cascading docs), so a nonce is spent only once its speech has been fully
 * streamed; a stream that aborts first hands the nonce back (in_flight → issued) for the retry.
 * A duplicate arriving while a stream is in flight is refused. Expired nonces never succeed.
 *
 * At most one authorization is pending per session (`pending`): the gate holds the floor while one is
 * outstanding, and the server refuses a second rather than let two control messages race (live bug
 * #2). An authorization that expires without its speech ever starting — no `speak` decision for its
 * nonce: the control message was lost, withheld, or merged into an open user turn (live bug #1) —
 * is reported once by `sweep`, so the caller can re-queue its question.
 *
 * In memory on purpose: there is one persistent process (D5) and an authorization lives seconds.
 * Stateless at module level: the one store instance lives on the runtime (see runtime.ts), because
 * this module is evaluated both by the custom server and inside Next's route bundles.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AGENT_ROLES, GateAuthorizationSchema, IdSchema, type AgentRole, type GateAuthorization } from "@vashistha/core";

/** Longest lifetime any caller may request (the preflight check uses all of it; the gate uses ~4 s). */
export const MAX_AUTHORIZATION_TTL_MS = 60_000;
/** A spoken question is ≤25 words (plan §7.2); this is a generous cap, not the phrasing limit. */
const MAX_QUESTION_CHARS = 600;
const NONCE_BYTES = 32;

const IssueInputSchema = z.strictObject({
    sessionId: IdSchema,
    agent: z.enum(AGENT_ROLES),
    questionId: IdSchema,
    text: z
      .string()
      .min(1)
      .max(MAX_QUESTION_CHARS)
      .refine((text) => text === text.trim(), "question text must be trimmed"),
    contextVersion: z.int().nonnegative(),
    ttlMs: z.int().positive().max(MAX_AUTHORIZATION_TTL_MS),
  });

export type IssueInput = z.input<typeof IssueInputSchema>;

export type ConsumeFailureReason =
  | "unknown_nonce"
  | "expired"
  | "already_used"
  | "in_flight"
  | "wrong_session"
  | "wrong_agent"
  | "context_changed";

/**
 * The caller holds the nonce in flight and must settle it exactly once: `complete()` when the speech
 * has been fully streamed (in_flight → used), `release()` when the stream failed first
 * (in_flight → issued). Both are idempotent, and whichever runs first wins.
 */
export type AuthorizationLease = { complete: () => void; release: () => void };

export type ConsumeResult =
  | { ok: true; authorization: GateAuthorization; text: string; lease: AuthorizationLease }
  | { ok: false; reason: ConsumeFailureReason };

export type ConsumeContext = {
  /** Session the request claims (from `elevenlabs_extra_body`); must be the authorization's session. */
  sessionId: string;
  agent: AgentRole;
  /** The session's context version now; an authorization issued under an older one is stale. */
  currentContextVersion: number;
  now: number;
};

type Entry = {
  authorization: GateAuthorization;
  agent: AgentRole;
  text: string;
  state: "issued" | "in_flight" | "used";
  /** Identifies the current in-flight holder, so a late release cannot undo a newer consume. */
  lease: number;
  /** A consume succeeded at least once: the custom LLM decided to speak it. */
  spoke: boolean;
  issuedAt: number;
};

/** An authorization that expired unspoken (see `sweep`). */
export type LapsedAuthorization = {
  sessionId: string;
  questionId: string;
  agent: AgentRole;
  nonceDigest: string;
  issuedAt: number;
  expiresAt: number;
};

/** Short, non-reversible correlation id for a nonce, for logs and the ledger (never store the nonce). */
export function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("base64url").slice(0, 12);
}

export function createAuthorizationStore(opts: { now?: () => number } = {}) {
  const clock = opts.now ?? Date.now;
  /** Live and spent (tombstoned) nonces; dropped once expired, after which they read as unknown. */
  const entries = new Map<string, Entry>();
  const contextVersions = new Map<string, number>();
  /** Expired, never spoken, not yet collected by `sweep`. */
  const lapsed: LapsedAuthorization[] = [];
  let leases = 0;

  function prune(now: number): void {
    for (const [nonce, entry] of entries) {
      if (entry.authorization.expiresAt > now) continue;
      entries.delete(nonce);
      const { sessionId, questionId, expiresAt } = entry.authorization;
      if (!entry.spoke) lapsed.push({ sessionId, questionId, agent: entry.agent, nonceDigest: nonceDigest(nonce), issuedAt: entry.issuedAt, expiresAt });
    }
  }

  return {
    issue(input: IssueInput): GateAuthorization {
      const { sessionId, agent, questionId, text, contextVersion, ttlMs } = IssueInputSchema.parse(input);
      const now = clock();
      prune(now);
      const authorization = GateAuthorizationSchema.parse({
        sessionId,
        questionId,
        nonce: randomBytes(NONCE_BYTES).toString("base64url"),
        expiresAt: now + ttlMs,
        contextVersion,
      });
      entries.set(authorization.nonce, { authorization, agent, text, state: "issued", lease: 0, spoke: false, issuedAt: now });
      return authorization;
    },

    /**
     * The session's outstanding authorization, if any: unexpired, not spent (issued, or its speech in
     * flight), and still consumable at the session's current context version.
     */
    pending(sessionId: string, now: number): GateAuthorization | undefined {
      prune(now);
      const version = contextVersions.get(sessionId) ?? 0;
      for (const { authorization, state } of entries.values())
        if (authorization.sessionId === sessionId && state !== "used" && authorization.contextVersion === version) return authorization;
      return undefined;
    },

    /** Collects the authorizations that expired unspoken since the last sweep (each is reported once). */
    sweep(now: number): LapsedAuthorization[] {
      prune(now);
      return lapsed.splice(0, lapsed.length);
    },

    /**
     * Takes `nonce` in flight. A presentation in the wrong context (session, agent or context version)
     * burns it: a nonce seen out of context is treated as compromised, and the gate simply issues a
     * new one. Expiry is exclusive: at `now === expiresAt` the nonce is expired. Synchronous, so two
     * concurrent requests can never both take it.
     */
    consume(nonce: string, ctx: ConsumeContext): ConsumeResult {
      const entry = entries.get(nonce);
      prune(ctx.now);
      if (!entry) return { ok: false, reason: "unknown_nonce" };
      if (entry.state === "used") return { ok: false, reason: "already_used" };
      if (entry.state === "in_flight") return { ok: false, reason: "in_flight" };
      const { authorization } = entry;
      if (ctx.now >= authorization.expiresAt) return { ok: false, reason: "expired" };
      const mismatch: ConsumeFailureReason | null =
        authorization.sessionId !== ctx.sessionId
          ? "wrong_session"
          : entry.agent !== ctx.agent
            ? "wrong_agent"
            : authorization.contextVersion !== ctx.currentContextVersion
              ? "context_changed"
              : null;
      if (mismatch) {
        entry.state = "used";
        return { ok: false, reason: mismatch };
      }
      leases += 1;
      const lease = leases;
      entry.state = "in_flight";
      entry.lease = lease;
      entry.spoke = true;
      const settle = (to: "used" | "issued") => {
        if (entry.state === "in_flight" && entry.lease === lease) entry.state = to;
      };
      return {
        ok: true,
        authorization,
        text: entry.text,
        lease: { complete: () => settle("used"), release: () => settle("issued") },
      };
    },

    /** Starts at 0 for a session never bumped. */
    getContextVersion(sessionId: string): number {
      return contextVersions.get(sessionId) ?? 0;
    },

    /** Invalidates every outstanding authorization of the session; returns the new version. */
    bumpContextVersion(sessionId: string): number {
      const next = (contextVersions.get(sessionId) ?? 0) + 1;
      contextVersions.set(sessionId, next);
      return next;
    },
  };
}

export type AuthorizationStore = ReturnType<typeof createAuthorizationStore>;
