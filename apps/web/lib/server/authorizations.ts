/**
 * Speech authorizations (plan §7.2). The deterministic gate issues a single-use nonce for one
 * precomputed question; the custom-LLM wrapper speaks only when it consumes a valid one.
 *
 * Lifecycle: issued → in_flight → used. ElevenLabs retries the same custom LLM on errors, timeouts
 * and empty responses (llm-cascading docs), so a nonce stays re-speakable for a short window after
 * its speech: a stream that aborts hands the nonce back at once (in_flight → issued) for the retry,
 * and a stream that completes but whose turn produced no audio (ElevenLabs then retries the SAME
 * nonce) is re-spoken with the SAME precomputed text for `RESPEAK_WINDOW_MS` after the first speak
 * (live bug #2). A duplicate arriving while a stream is in flight is refused. Expired nonces, nonces
 * past the re-speak window, nonces whose audio has been confirmed, and nonces burned in the wrong
 * context never succeed. The wrapper invariant holds: only the one authorised text for that nonce is
 * ever spoken, however many times it is re-spoken.
 *
 * At most one authorization is pending per session (`pending`): the gate holds the floor while one is
 * outstanding, and the server refuses a second rather than let two control messages race (live bug
 * #2). "Speak" is provisional until the agent's audio is confirmed (`confirmVoiced`, from the
 * browser's `agent.utterance`). An authorization that expires or passes its re-speak window without
 * a confirmed utterance — the control message was lost, withheld, or merged into an open user turn
 * (live bug #1), or the agent turn came out empty (live bug #2) — is reported once by `sweep`, so the
 * caller can re-queue its question and refund its live-budget slot.
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
/**
 * How long after its first speak a nonce may be re-spoken on an ElevenLabs retry (live bug #2). It is
 * longer than the gate's ~4 s TTL on purpose: a retry carrying the same nonce in the same session,
 * agent and context arrives seconds after the control message, often after the TTL. Past this window
 * (measured from the first speak) a spoken-but-unvoiced nonce lapses, so its question is re-queued.
 */
export const RESPEAK_WINDOW_MS = 10_000;
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
 * has been fully streamed (in_flight → used, re-speakable on retry within the window), `release()`
 * when the stream failed first (in_flight → issued, re-speakable at once), `burn()` to spend it for
 * good without a confirmed utterance (in_flight → used, voiced — a decision that could not be
 * recorded must never be re-spoken, nor re-queued). All are idempotent, and whichever runs first wins.
 */
export type AuthorizationLease = { complete: () => void; release: () => void; burn: () => void };

export type ConsumeResult =
  | { ok: true; authorization: GateAuthorization; text: string; lease: AuthorizationLease; respeak: boolean }
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
  /** When the first `speak` decision was made; the re-speak window is measured from here. */
  firstSpokeAt?: number;
  /** The agent's audio for this question was confirmed (`agent.utterance`): no re-speak, and no re-queue. */
  voiced: boolean;
  /** Spent for good (out-of-context presentation, or a ledger failure): never re-spoken; still re-queued unless voiced. */
  burned: boolean;
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

  /**
   * A spoken nonce stays alive for the re-speak window (so an ElevenLabs retry can speak it again);
   * every other nonce only until its TTL. On removal, a nonce whose audio was never confirmed lapsed:
   * it was authorised (its question counted as asked) but never voiced, so `sweep` reports it.
   */
  function deadlineOf(entry: Entry): number {
    const { expiresAt } = entry.authorization;
    return entry.firstSpokeAt === undefined ? expiresAt : Math.max(expiresAt, entry.firstSpokeAt + RESPEAK_WINDOW_MS);
  }

  function prune(now: number): void {
    for (const [nonce, entry] of entries) {
      if (deadlineOf(entry) > now) continue;
      entries.delete(nonce);
      const { sessionId, questionId, expiresAt } = entry.authorization;
      if (!entry.voiced) lapsed.push({ sessionId, questionId, agent: entry.agent, nonceDigest: nonceDigest(nonce), issuedAt: entry.issuedAt, expiresAt });
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
      entries.set(authorization.nonce, { authorization, agent, text, state: "issued", lease: 0, spoke: false, voiced: false, burned: false, issuedAt: now });
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

    /** Collects the authorizations that lapsed unvoiced since the last sweep (each is reported once). */
    sweep(now: number): LapsedAuthorization[] {
      prune(now);
      return lapsed.splice(0, lapsed.length);
    },

    /**
     * Takes `nonce` in flight. A duplicate while a stream is in flight is refused. A presentation in
     * the wrong context (session, agent or context version) burns it: a nonce seen out of context is
     * treated as compromised, and the gate simply issues a new one. A nonce whose speech has already
     * completed is re-spoken with the same text while it is within the re-speak window and its audio
     * is not yet confirmed (an ElevenLabs retry, live bug #2); afterwards it reads as `already_used`.
     * A nonce never spoken is taken if unexpired (expiry is exclusive: at `now === expiresAt` it is
     * expired). Synchronous, so two concurrent requests can never both take it.
     */
    consume(nonce: string, ctx: ConsumeContext): ConsumeResult {
      const entry = entries.get(nonce);
      prune(ctx.now);
      if (!entry) return { ok: false, reason: "unknown_nonce" };
      // A stream is in flight: refuse without disturbing its holder (a concurrent duplicate).
      if (entry.state === "in_flight") return { ok: false, reason: "in_flight" };
      const { authorization } = entry;
      // A spent nonce that can never be re-spoken — burned, audio confirmed, never truly spoken, or past
      // its re-speak window — is terminal whatever the context. (A still-respeakable spoken nonce falls
      // through to the context check below, so it is never re-spoken out of context.)
      const respeakable = entry.spoke && !entry.voiced && !entry.burned && entry.firstSpokeAt !== undefined && ctx.now < entry.firstSpokeAt + RESPEAK_WINDOW_MS;
      if (entry.state === "used" && !respeakable) return { ok: false, reason: "already_used" };
      const mismatch: ConsumeFailureReason | null =
        authorization.sessionId !== ctx.sessionId
          ? "wrong_session"
          : entry.agent !== ctx.agent
            ? "wrong_agent"
            : authorization.contextVersion !== ctx.currentContextVersion
              ? "context_changed"
              : null;
      if (mismatch) {
        // A nonce seen out of context is compromised: burn it (never re-spoken). It was not voiced, so
        // its question is still re-queued when it lapses, as before.
        entry.state = "used";
        entry.burned = true;
        return { ok: false, reason: mismatch };
      }
      if (entry.state === "issued" && ctx.now >= authorization.expiresAt) return { ok: false, reason: "expired" };
      const respeak = entry.state === "used";
      leases += 1;
      const lease = leases;
      entry.state = "in_flight";
      entry.lease = lease;
      entry.spoke = true;
      entry.firstSpokeAt ??= ctx.now;
      const held = () => entry.state === "in_flight" && entry.lease === lease;
      const settle = (to: "used" | "issued") => {
        if (held()) entry.state = to;
      };
      return {
        ok: true,
        authorization,
        text: entry.text,
        respeak,
        lease: {
          complete: () => settle("used"),
          release: () => settle("issued"),
          burn: () => {
            if (held()) {
              entry.state = "used";
              entry.voiced = true;
            }
          },
        },
      };
    },

    /**
     * Confirms the agent's audio for a question was heard (`agent.utterance`): its authorization's
     * speak is no longer provisional, so it will not be re-spoken or re-queued. Marks every live
     * authorization of this session and question that has spoken (an older re-queued one stays as it
     * is). A no-op if none is live.
     */
    confirmVoiced(sessionId: string, questionId: string): void {
      for (const entry of entries.values())
        if (entry.authorization.sessionId === sessionId && entry.authorization.questionId === questionId && entry.spoke) entry.voiced = true;
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
