/**
 * Deterministic stand-in for the Haiku extractor, used ONLY to prove the evaluation harness end to
 * end without an API key. It reads the fixture's DOM ground truth (never pixels) and answers each
 * prepared read in the model's structured-output shape — the screen state at the frame's capture
 * time — with seeded noise: unreadable values (null), misread editable values, and simulated latency
 * on the injected clock. Its scores say nothing about vision accuracy.
 */
import type { DomainConfig, ScreenEvent, Value } from "@vashistha/core";
import { mulberry32 } from "@vashistha/core/domains/kyc";
import type { FrameReading, ScreenProfile } from "../src/extraction";
import type { Clock, FrameExtractor } from "../src/replay";

export type FakeNoise = {
  /** Probability each editable value or committed action reads as null (not legible). */
  missRate: number;
  /** Probability per read (with a case open) that one editable enum value is misread. */
  spuriousRate: number;
  latency: { baseMs: number; jitterMs: number; slowRate: number; slowMs: number };
};

export const DEFAULT_FAKE_NOISE: FakeNoise = {
  missRate: 0.05,
  spuriousRate: 0.03,
  latency: { baseMs: 700, jitterMs: 800, slowRate: 0.05, slowMs: 1500 },
};

type ScreenState = { caseId: string | null; fields: Map<string, Map<string, Value>>; committed: Map<string, string> };

/** The screen as the DOM events describe it at time `t`. */
function stateAt(dom: readonly ScreenEvent[], t: number): ScreenState {
  const state: ScreenState = { caseId: null, fields: new Map(), committed: new Map() };
  for (const e of dom) {
    if (e.captureTime > t) break;
    if (e.kind === "navigate") {
      // CaseDesk emits navigate when a session's workspace loads: a fresh session, so nothing is rated or committed yet.
      state.caseId = null;
      state.fields.clear();
      state.committed.clear();
    }
    if (e.kind === "open_case") state.caseId = e.caseId ?? null;
    if (e.kind === "field_change" && e.caseId !== undefined && e.field !== undefined && e.to !== undefined) {
      const values = state.fields.get(e.caseId) ?? new Map<string, Value>();
      values.set(e.field, e.to);
      state.fields.set(e.caseId, values);
    }
    if (e.kind === "action" && e.caseId !== undefined && e.action !== undefined) state.committed.set(e.caseId, e.action);
  }
  return state;
}

export function createFakeExtractor(options: {
  domain: DomainConfig;
  profile: ScreenProfile;
  domEvents: readonly ScreenEvent[];
  clock: Clock;
  seed: number;
  noise?: FakeNoise;
}): FrameExtractor {
  const { domain, profile, clock } = options;
  const noise = options.noise ?? DEFAULT_FAKE_NOISE;
  const rng = mulberry32(options.seed);
  const dom = [...options.domEvents].sort((a, b) => a.captureTime - b.captureTime);
  const editable = profile.editableFields.map((id) => domain.features.find((f) => f.id === id));

  return async (read): Promise<FrameReading> => {
    const { latency } = noise;
    const delay = latency.baseMs + rng() * latency.jitterMs + (rng() < latency.slowRate ? latency.slowMs : 0);
    await clock.sleepUntil(clock.now() + delay);

    const state = stateAt(dom, read.context.captureTime);
    const caseId = read.mode === "local" ? (read.context.previous?.caseId ?? null) : state.caseId;
    const shown = caseId === null ? undefined : state.fields.get(caseId);
    const fields: Record<string, Value | null> = {};
    for (const f of editable) {
      if (f === undefined) continue;
      // An untouched field shows its first enum value (e.g. "unrated"), as a fresh case does.
      const value = shown?.get(f.id) ?? (f.type === "enum" ? (f.values[0] ?? null) : null);
      fields[f.id] = caseId === null || rng() < noise.missRate ? null : value;
      if (caseId !== null && f.type === "enum" && rng() < noise.spuriousRate) fields[f.id] = f.values[Math.floor(rng() * f.values.length)] ?? null;
    }
    const committed = caseId === null || rng() < noise.missRate ? null : (state.committed.get(caseId) ?? null);
    if (read.mode === "local") return { mode: "local", output: { fields, committed } };
    const caseTitle = caseId === null ? null : `Customer of ${caseId}`;
    return read.mode === "full"
      ? { mode: "full", output: { caseId, caseTitle, fields, committed, concepts: [] } }
      : { mode: "refresh", output: { caseId, caseTitle, fields, committed } };
  };
}
