import { z } from "zod";
import { EpochMsSchema, IdSchema } from "./primitives";

/** Issued by the deterministic gate; the custom-LLM wrapper speaks only with a valid, unused, unexpired one. */
export const GateAuthorizationSchema = z.strictObject({
  sessionId: IdSchema,
  questionId: IdSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, "base64url nonce, ≥128 bits"),
  expiresAt: EpochMsSchema,
  contextVersion: z.int().nonnegative(),
});
export type GateAuthorization = z.infer<typeof GateAuthorizationSchema>;

const CONTROL_RE = /^⟦ctl:([A-Za-z0-9_-]{22,64})⟧$/;

/** Control message sent as a user turn to trigger an authorised agent turn. Recorded as `system_control`. */
export function formatControlMessage(nonce: string): string {
  return `⟦ctl:${nonce}⟧`;
}

/** Returns the nonce if `text` is exactly a control message, otherwise null. */
export function parseControlMessage(text: string): string | null {
  return CONTROL_RE.exec(text.trim())?.[1] ?? null;
}
