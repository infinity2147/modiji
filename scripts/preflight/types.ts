/**
 * Shared types for `pnpm preflight` (plan §12). Every check is a plain async function of an injected context, so the
 * whole suite runs against fakes in tests and against the deployment from `scripts/preflight.ts`.
 */
import type { Claude } from "../../packages/core/src/server/claude";
import type { ElevenLabsClient } from "../../packages/core/src/server/elevenlabs";
import type { AgentRole, AgentSpec } from "../../packages/core/src/server/elevenlabs-agents";
import type { SecretRegistry } from "./redact";
import type { Target } from "./target";
import type { WebSocketFactory } from "./voice-session";

export const CHECK_IDS = [
  "env",
  "anthropic",
  "agents",
  "token",
  "public-llm",
  "voice-skip-turn",
  "voice-off-record",
  "server-deep",
  "sandbox",
  "permissions",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export function isCheckId(value: string): value is CheckId {
  return CHECK_IDS.some((id) => id === value);
}

/** `info` is reserved for non-gating output (the permissions checklist); `skip` only for unmet dependencies. */
export type CheckStatus = "pass" | "fail" | "skip" | "info";

/** JSON-safe structured facts attached to a result (latencies, usage, observed events). Never secrets. */
export type Facts = { [key: string]: FactValue };
export type FactValue = string | number | boolean | null | FactValue[] | { [key: string]: FactValue };

/** What a check function returns; the runner adds id, title and timing. */
export type CheckOutcome = { status: "pass" | "fail" | "info"; detail: string; facts?: Facts };

export type CheckResult = {
  id: CheckId;
  title: string;
  status: CheckStatus;
  ms: number;
  detail: string;
  facts?: Facts;
};

/** The ElevenLabs calls preflight makes (read-only: it never creates or updates agents). */
export type PreflightElevenLabs = Pick<
  ElevenLabsClient,
  "getAgent" | "getConversationToken" | "getSignedUrl" | "listSecrets" | "getTool"
>;

export type PreflightOptions = {
  /** Phase A of the voice check: how long the agent must stay silent after an unauthorised user message. */
  quietWindowMs: number;
  /** Phase B of the voice check: how long to wait for the authorised speech (text and audio). */
  speechTimeoutMs: number;
  /** Connecting and receiving `conversation_initiation_metadata`. */
  connectTimeoutMs: number;
  /** Per HTTP request to the target (Z3's first self-test can take a while on a cold server). */
  httpTimeoutMs: number;
  /** Phase B needs at least this much authorization lifetime left, otherwise it re-authorises on a new conversation. */
  minAuthorizationRemainingMs: number;
};

export const DEFAULT_OPTIONS: PreflightOptions = {
  quietWindowMs: 8_000,
  speechTimeoutMs: 20_000,
  connectTimeoutMs: 15_000,
  httpTimeoutMs: 45_000,
  minAuthorizationRemainingMs: 15_000,
};

export type PreflightContext = {
  /** Process environment after `.env` was loaded (raw strings; checks validate what they use). */
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a `.env` file was loaded (reported by the env check). */
  envFileLoaded: boolean;
  /** The deployment under test (`--target`, defaulting to PUBLIC_BASE_URL). */
  target: Target;
  options: PreflightOptions;
  fetch: typeof globalThis.fetch;
  WebSocket: WebSocketFactory;
  createClaude: (apiKey: string) => Claude;
  createElevenLabs: (apiKey: string) => PreflightElevenLabs;
  loadAgentSpec: (role: AgentRole) => Promise<AgentSpec>;
  /** Every sensitive value seen during the run is registered here and redacted from all output. */
  secrets: SecretRegistry;
  /** Monotonic ms (latency measurements). */
  now: () => number;
  /** Epoch ms (authorization expiry, report timestamps). */
  wallClock: () => number;
  /** Waits `ms` (injectable so tests can advance a fake clock instead of waiting). */
  sleep: (ms: number) => Promise<void>;
};
