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
      lease: { complete: expect.any(Function), release: expect.any(Function) },
    });
  });

  it("refuses a duplicate while in flight, and every presentation after completion", () => {
    const { issue, consume } = setup();
    const auth = issue();
    const first = consume(auth.nonce);
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "in_flight" });
    if (!first.ok) throw new Error("expected success");
    first.lease.complete();
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "already_used" });
    first.lease.release(); // settling twice changes nothing
    expect(consume(auth.nonce)).toEqual({ ok: false, reason: "already_used" });
  });

  it("hands a released nonce back for exactly one more successful consume", () => {
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
    retry.lease.complete();
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
  it("drops expired entries, whatever their state, on the next operation", () => {
    const { issue, consume, setClock } = setup();
    const issued = issue({ ttlMs: 1_000 });
    const inFlight = issue({ ttlMs: 1_000 });
    const spent = issue({ ttlMs: 1_000 });
    expect(consume(inFlight.nonce).ok).toBe(true);
    const done = consume(spent.nonce);
    if (done.ok) done.lease.complete();
    // Before pruning, a spent nonce is reported as used.
    expect(consume(spent.nonce, { now: T0 + 999 })).toEqual({ ok: false, reason: "already_used" });
    setClock(T0 + 1_000);
    issue(); // any operation prunes everything with expiresAt <= now
    for (const auth of [issued, inFlight, spent]) {
      expect(consume(auth.nonce)).toEqual({ ok: false, reason: "unknown_nonce" });
    }
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
