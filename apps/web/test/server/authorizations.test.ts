import { describe, expect, it } from "vitest";
import { GateAuthorizationSchema } from "@vashistha/core";
import type { AgentRole } from "@vashistha/core";
import { createAuthorizationStore, nonceDigest } from "../../lib/server/authorizations";

const T0 = 1_760_000_000_000;

function setup() {
  let clock = T0;
  const store = createAuthorizationStore({ now: () => clock });
  const issue = (over: { sessionId?: string; agent?: AgentRole; ttlMs?: number; contextVersion?: number } = {}) =>
    store.issue({
      sessionId: over.sessionId ?? "s1",
      agent: over.agent ?? "interviewer",
      questionId: "q1",
      text: "Why that threshold?",
      contextVersion: over.contextVersion ?? store.getContextVersion(over.sessionId ?? "s1"),
      ttlMs: over.ttlMs ?? 4_000,
    });
  const consume = (nonce: string, over: { sessionId?: string; agent?: AgentRole; now?: number } = {}) =>
    store.consume(nonce, {
      sessionId: over.sessionId ?? "s1",
      agent: over.agent ?? "interviewer",
      currentContextVersion: store.getContextVersion(over.sessionId ?? "s1"),
      now: over.now ?? clock,
    });
  return {
    store,
    issue,
    consume,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

describe("issue", () => {
  it("returns a schema-valid authorization with a 256-bit base64url nonce", () => {
    const { issue } = setup();
    const auth = issue();
    expect(GateAuthorizationSchema.parse(auth)).toEqual(auth);
    expect(auth).toMatchObject({ sessionId: "s1", questionId: "q1", expiresAt: T0 + 4_000, contextVersion: 0 });
    expect(auth.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(auth.nonce, "base64url")).toHaveLength(32);
  });

  it("never repeats a nonce", () => {
    const { issue } = setup();
    const nonces = new Set(Array.from({ length: 500 }, () => issue().nonce));
    expect(nonces.size).toBe(500);
  });

  it.each([
    ["empty text", { text: "" }],
    ["untrimmed text", { text: " Why? " }],
    ["zero ttl", { ttlMs: 0 }],
    ["ttl above the maximum", { ttlMs: 60_001 }],
    ["negative context version", { contextVersion: -1 }],
    ["unknown agent", { agent: "assistant" }],
    ["empty session id", { sessionId: "" }],
  ])("rejects %s", (_name, over) => {
    const { store } = setup();
    const input = { sessionId: "s1", agent: "interviewer", questionId: "q1", text: "Why?", contextVersion: 0, ttlMs: 1_000, ...over };
    expect(() => store.issue(input as Parameters<typeof store.issue>[0])).toThrow();
  });
});

describe("consume", () => {
  it("takes a nonce in flight with its authorization, text and a lease", () => {
    const { issue, consume } = setup();
    const auth = issue();
    expect(consume(auth.nonce)).toEqual({
      ok: true,
      authorization: auth,
      text: "Why that threshold?",
      respeak: false,
      lease: { complete: expect.any(Function), release: expect.any(Function), burn: expect.any(Function) },
    });
  });

  it("refuses a duplicate while in flight; after completion a retry re-speaks the same text within the window (live bug #2)", () => {
    const { issue, consume } = setup();
    const auth = issue();
    const first = consume(auth.nonce);
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "in_flight" });
    if (!first.ok) throw new Error("expected success");
    first.lease.complete();
    // The agent turn produced no audio and ElevenLabs retries: the SAME text is spoken again.
    const retry = consume(auth.nonce);
    expect(retry).toMatchObject({ ok: true, respeak: true, text: "Why that threshold?" });
    if (!retry.ok) throw new Error("expected respeak");
    retry.lease.complete();
    first.lease.release(); // a stale lease from the first consume cannot undo the retry
    expect(consume(auth.nonce)).toMatchObject({ ok: true, respeak: true });
  });

  it("refuses the retry once its audio is confirmed (voiced) or the window closes", () => {
    const { store, issue, consume, setClock } = setup();
    const confirmed = issue();
    const taken = consume(confirmed.nonce);
    if (!taken.ok) throw new Error("expected success");
    taken.lease.complete();
    store.confirmVoiced("s1", "q1");
    expect(consume(confirmed.nonce)).toEqual({ ok: false, reason: "already_used" });

    const lapsing = issue();
    const spoke = consume(lapsing.nonce);
    if (!spoke.ok) throw new Error("expected success");
    spoke.lease.complete();
    setClock(T0 + 9_999);
    expect(consume(lapsing.nonce)).toMatchObject({ ok: true, respeak: true });
    setClock(T0 + 10_000); // 10 s after the first speak: the re-speak window has closed
    const closed = issue({ sessionId: "s2" }); // any op prunes; the spoken-unvoiced nonce now lapses
    void closed;
    expect(consume(lapsing.nonce)).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("refuses a retry after the context changed: a different question needs a fresh authorization", () => {
    const { store, issue, consume } = setup();
    const a = issue();
    const taken = consume(a.nonce);
    if (!taken.ok) throw new Error("expected success");
    taken.lease.complete();
    store.bumpContextVersion("s1"); // the case moved on; a different question is due
    expect(consume(a.nonce)).toEqual({ ok: false, reason: "context_changed" });
    expect(consume(a.nonce)).toEqual({ ok: false, reason: "already_used" }); // burned, never re-spoken
  });

  it("hands a released nonce back for another successful consume", () => {
    const { issue, consume } = setup();
    const auth = issue();
    const first = consume(auth.nonce);
    if (!first.ok) throw new Error("expected success");
    first.lease.release();
    const retry = consume(auth.nonce);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    first.lease.release(); // a stale lease cannot undo the newer consume
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "in_flight" });
    retry.lease.burn(); // spent for good (as on a ledger failure): no re-speak
    first.lease.release();
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "already_used" });
  });

  it("never lets a released nonce succeed after it expires", () => {
    const { issue, consume } = setup();
    const auth = issue();
    const first = consume(auth.nonce, { now: auth.expiresAt - 1 });
    if (!first.ok) throw new Error("expected success");
    first.lease.release();
    expect(consume(auth.nonce, { now: auth.expiresAt })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an unknown nonce", () => {
    const { consume } = setup();
    expect(consume("A".repeat(43))).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("treats expiresAt as exclusive: valid at expiresAt - 1, expired at expiresAt", () => {
    const { issue, consume } = setup();
    const a = issue();
    const b = issue();
    expect(consume(a.nonce, { now: a.expiresAt - 1 }).ok).toBe(true);
    expect(consume(b.nonce, { now: b.expiresAt })).toEqual({ ok: false, reason: "expired" });
  });

  it("burns a nonce presented in the wrong context, so it cannot succeed afterwards", () => {
    const { store, issue, consume } = setup();
    for (const [over, reason] of [
      [{ agent: "tutor" }, "wrong_agent"],
      [{ sessionId: "s2" }, "wrong_session"],
    ] as const) {
      const auth = issue();
      expect(consume(auth.nonce, over)).toEqual({ ok: false, reason });
      expect(consume(auth.nonce)).toEqual({ ok: false, reason: "already_used" });
    }
    const stale = issue();
    store.bumpContextVersion("s1");
    expect(consume(stale.nonce)).toEqual({ ok: false, reason: "context_changed" });
    expect(consume(stale.nonce)).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects the wrong agent", () => {
    const { issue, consume } = setup();
    expect(consume(issue({ agent: "tutor" }).nonce)).toEqual({ ok: false, reason: "wrong_agent" });
  });

  it("rejects an authorization issued under an older context version", () => {
    const { store, issue, consume } = setup();
    const before = issue();
    expect(store.bumpContextVersion("s1")).toBe(1);
    const after = issue();
    expect(after.contextVersion).toBe(1);
    expect(consume(before.nonce)).toEqual({ ok: false, reason: "context_changed" });
    expect(consume(after.nonce).ok).toBe(true);
  });

  it("keeps context versions per session", () => {
    const { store, issue, consume } = setup();
    const other = issue({ sessionId: "s2" });
    store.bumpContextVersion("s1");
    store.bumpContextVersion("s1");
    expect(store.getContextVersion("s1")).toBe(2);
    expect(store.getContextVersion("s2")).toBe(0);
    expect(consume(other.nonce, { sessionId: "s2" }).ok).toBe(true);
  });
});

describe("pruning", () => {
  it("drops an expired never-spoken entry at its TTL, but keeps a spoken one for the re-speak window", () => {
    const { issue, consume, setClock } = setup();
    const issued = issue({ ttlMs: 1_000 });
    const spent = issue({ ttlMs: 1_000 });
    const done = consume(spent.nonce);
    if (done.ok) done.lease.complete();
    setClock(T0 + 1_000);
    issue(); // any operation prunes everything past its deadline
    // A never-spoken entry drops at its TTL; the spoken one survives (re-speakable on a retry).
    expect(consume(issued.nonce)).toEqual({ ok: false, reason: "unknown_nonce" });
    expect(consume(spent.nonce)).toMatchObject({ ok: true, respeak: true });
    // Past the re-speak window (10 s from the first speak) the spoken entry drops too.
    setClock(T0 + 10_000);
    issue();
    expect(consume(spent.nonce)).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("keeps unexpired entries", () => {
    const { issue, consume, setClock } = setup();
    const short = issue({ ttlMs: 1_000 });
    const long = issue({ ttlMs: 5_000 });
    setClock(T0 + 2_000);
    issue();
    expect(consume(short.nonce)).toEqual({ ok: false, reason: "unknown_nonce" });
    expect(consume(long.nonce).ok).toBe(true);
  });
});

describe("nonceDigest", () => {
  it("is a short stable hash that does not contain the nonce", () => {
    const nonce = "A".repeat(43);
    expect(nonceDigest(nonce)).toBe(nonceDigest(nonce));
    expect(nonceDigest(nonce)).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(nonceDigest(nonce)).not.toBe(nonceDigest("B".repeat(43)));
    expect(nonce).not.toContain(nonceDigest(nonce));
  });
});

describe("pending and sweep (one outstanding authorization per session; lapses reported once)", () => {
  it("an issued, unexpired authorization at the current context version is pending until spent, burned, expired or stale", () => {
    const { store, issue, consume, setClock } = setup();
    const a = issue();
    expect(store.pending("s1", T0)?.nonce).toBe(a.nonce);
    expect(store.pending("s2", T0)).toBeUndefined();
    const taken = consume(a.nonce);
    if (!taken.ok) throw new Error("consume failed");
    expect(store.pending("s1", T0)?.nonce).toBe(a.nonce); // its speech is in flight
    taken.lease.complete();
    expect(store.pending("s1", T0)).toBeUndefined();

    issue();
    store.bumpContextVersion("s1");
    expect(store.pending("s1", T0)).toBeUndefined(); // it can never be consumed now
    issue();
    expect(store.pending("s1", T0)).toBeDefined();
    setClock(T0 + 4_000);
    expect(store.pending("s1", T0 + 4_000)).toBeUndefined();
  });

  it("reports each authorization that expired without a speak decision exactly once, with its session and question", () => {
    const { store, issue, consume, setClock } = setup();
    const spoken = issue();
    const taken = consume(spoken.nonce);
    if (!taken.ok) throw new Error("consume failed");
    taken.lease.complete();
    store.confirmVoiced("s1", "q1"); // its audio arrived: it never lapses
    const lost = issue({ sessionId: "s2" });
    const burned = issue({ sessionId: "s3" });
    expect(consume(burned.nonce, { sessionId: "s3", agent: "tutor" })).toEqual({ ok: false, reason: "wrong_agent" });
    expect(store.sweep(T0 + 3_999)).toEqual([]);
    setClock(T0 + 4_000);
    const lapsed = store.sweep(T0 + 4_000);
    expect(lapsed.map((l) => [l.sessionId, l.questionId])).toEqual([
      ["s2", "q1"],
      ["s3", "q1"],
    ]);
    expect(lapsed[0]).toEqual({ sessionId: "s2", questionId: "q1", agent: "interviewer", nonceDigest: nonceDigest(lost.nonce), issuedAt: T0, expiresAt: T0 + 4_000 });
    expect(store.sweep(T0 + 10_000)).toEqual([]);
  });

  it("re-queues a provisional speak whose audio never arrives, once the re-speak window closes (live bug #2)", () => {
    const { store, issue, consume, setClock } = setup();
    const a = issue();
    const taken = consume(a.nonce);
    if (!taken.ok) throw new Error("consume failed");
    taken.lease.complete(); // the stream completed, but the agent turn produced no audio — never voiced
    setClock(T0 + 9_999);
    expect(store.sweep(T0 + 9_999)).toEqual([]); // still re-speakable within the window
    setClock(T0 + 10_000);
    const lapsed = store.sweep(T0 + 10_000);
    expect(lapsed.map((l) => [l.sessionId, l.questionId])).toEqual([["s1", "q1"]]);
    expect(store.sweep(T0 + 20_000)).toEqual([]); // reported once
  });

  it("never re-queues a spoken question once its audio is confirmed", () => {
    const { store, issue, consume, setClock } = setup();
    const a = issue();
    const taken = consume(a.nonce);
    if (!taken.ok) throw new Error("consume failed");
    taken.lease.complete();
    store.confirmVoiced("s1", "q1");
    setClock(T0 + 20_000);
    expect(store.sweep(T0 + 20_000)).toEqual([]);
  });
});
