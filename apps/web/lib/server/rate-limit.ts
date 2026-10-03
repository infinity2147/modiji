/** Sliding-window, in-memory request limiter (one persistent process; state lives on the runtime). */
export type RateLimitResult = { ok: true } | { ok: false; retryAfterS: number };

export function createRateLimiter(opts: { limit: number; windowMs: number }) {
  const { limit, windowMs } = opts;
  /** Timestamps of accepted requests per key, oldest first; at most `limit` each. */
  const hits = new Map<string, number[]>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  return {
    take(key: string, now: number): RateLimitResult {
      if (now - lastSweep >= windowMs) {
        for (const [k, times] of hits) if (times.every((t) => now - t >= windowMs)) hits.delete(k);
        lastSweep = now;
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? now;
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
      }
      recent.push(now);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
