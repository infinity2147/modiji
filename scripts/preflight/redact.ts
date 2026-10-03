/**
 * Preflight handles API keys, the custom-LLM bearer secret, conversation tokens, signed WebSocket URLs and
 * authorization nonces. None of them may reach the terminal or the evidence report. Two layers:
 *   1. a registry of exact values seen during the run (keys from env, tokens and nonces as they are received);
 *   2. pattern rules for shapes that are sensitive whatever their value (control messages, signed URLs, bearer
 *      headers, Anthropic keys) and for object keys that name a secret.
 */

export const REDACTED = "[redacted]";

/** Values shorter than this are not registered: redacting them would mangle ordinary text and they are not secrets. */
const MIN_SECRET_LENGTH = 8;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Control messages carry a live nonce.
  [/⟦ctl:[^⟧\s]*⟧?/g, `⟦ctl:${REDACTED}⟧`],
  // Signed conversation URLs (and any URL carrying a token or signature in its query).
  [/\bwss?:\/\/[^\s"'<>]+/gi, `[redacted signed url]`],
  [/\bhttps?:\/\/[^\s"'<>]*[?&](?:token|conversation_signature|signature|api_key|key)=[^\s"'<>]*/gi, `[redacted url]`],
  [/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bxi-api-key["']?\s*[:=]\s*["']?[^\s"',;]+/gi, `xi-api-key: ${REDACTED}`],
];

/** Object keys whose string values are always secret, whatever they contain. */
const SECRET_KEY_RE = /^(?:token|conversationToken|nonce|controlMessage|signedUrl|signed_url|secret|apiKey|api_key|authorization|password)$/i;

export type SecretRegistry = {
  /** Registers a sensitive value (ignored when shorter than 8 characters). */
  add(value: string | undefined | null): void;
  /** Redacts registered values and sensitive patterns from free text. */
  text(value: string): string;
  /** Deep copy with every string redacted and secret-named keys replaced. */
  value<T>(value: T): T;
};

export function createSecretRegistry(initial: Iterable<string | undefined | null> = []): SecretRegistry {
  const secrets = new Set<string>();

  const add = (value: string | undefined | null): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length >= MIN_SECRET_LENGTH) secrets.add(trimmed);
  };
  for (const value of initial) add(value);

  const text = (input: string): string => {
    let out = input;
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      out = out.replaceAll(secret, REDACTED);
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.replaceAll(escaped, REDACTED);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.replaceAll(encoded, REDACTED);
    }
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };

  const deep = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(deep);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [
          key,
          SECRET_KEY_RE.test(key) && typeof item === "string" ? REDACTED : deep(item),
        ]),
      );
    }
    return input;
  };

  return {
    add,
    text,
    // The deep copy has the same shape; only string contents change.
    value: <T>(input: T): T => deep(input) as T,
  };
}
