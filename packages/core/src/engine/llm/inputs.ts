/**
 * Browser-safe prompt inputs. Prompt builders accept ONLY these types (plus plain transcript and
 * question text), built by copying named public fields; nothing shaped like a hidden policy
 * (`HiddenPolicy`, `OracleRule`, `OracleResult`) is assignable to them, so oracle data cannot
 * reach a prompt through the engine's builders.
 */
import type { DomainConfig } from "../../schemas/domain";
import type { HypothesisSet } from "../../schemas/rules";
import { describePredicate } from "../describe";

export type PromptFeature = {
  id: string;
  label: string;
  type: "number" | "boolean" | "enum" | "string";
  values?: string[];
  range?: { min: number; max: number; unit?: string };
};

export type PromptDomain = {
  id: string;
  title: string;
  features: PromptFeature[];
  actions: { id: string; label: string }[];
  decisionFamilies: { id: string; label: string; actions: string[] }[];
};

/** A candidate as the model sees it: id, the action it predicts and a plain-language condition. */
export type CandidateSummary = { id: string; predictedAction: string; weight: number; condition: string };

/** One expert (or apprentice) turn, already free of `system_control` traffic. */
export type TranscriptLine = { speaker: "expert" | "apprentice"; text: string };

export function promptDomain(domain: DomainConfig): PromptDomain {
  return {
    id: domain.id,
    title: domain.title,
    features: domain.features.map((f): PromptFeature => {
      const base = { id: f.id, label: f.label, type: f.type };
      if (f.type === "enum") return { ...base, values: [...f.values] };
      if (f.type === "number") return { ...base, range: { min: f.min, max: f.max, ...(f.unit !== undefined && { unit: f.unit }) } };
      return base;
    }),
    actions: domain.actions.map((a) => ({ id: a.id, label: a.label })),
    decisionFamilies: domain.decisionFamilies.map((f) => ({ id: f.id, label: f.label, actions: [...f.actions] })),
  };
}

/** The `limit` heaviest candidates, described in plain language. */
export function summarizeCandidates(set: HypothesisSet, domain: DomainConfig, limit: number): CandidateSummary[] {
  return [...set.candidates]
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((c) => ({ id: c.id, predictedAction: c.predictedAction, weight: c.weight, condition: describePredicate(c.predicate, domain) }));
}

export function renderDomain(d: PromptDomain): string {
  const features = d.features.map((f) => {
    const detail =
      f.type === "enum"
        ? `one of ${(f.values ?? []).join(" | ")}`
        : f.range !== undefined
          ? `number ${f.range.min}–${f.range.max}${f.range.unit !== undefined ? ` ${f.range.unit}` : ""}`
          : f.type;
    return `- ${f.id} (${f.label}): ${detail}`;
  });
  const actions = d.actions.map((a) => `- ${a.id}: ${a.label}`);
  const families = d.decisionFamilies.map((f) => `- ${f.id} (${f.label}): ${f.actions.join(", ")}`);
  return [
    `<domain id="${d.id}">${d.title}`,
    "Features:",
    ...features,
    "Actions:",
    ...actions,
    "Decision families:",
    ...families,
    "</domain>",
  ].join("\n");
}

export function renderTranscript(lines: readonly TranscriptLine[]): string {
  return lines.map((l) => `${l.speaker === "expert" ? "EXPERT" : "APPRENTICE"}: ${l.text}`).join("\n");
}

export function renderCandidates(cs: readonly CandidateSummary[]): string {
  return cs.map((c) => `- ${c.id}: if ${c.condition} then ${c.predictedAction} (weight ${c.weight.toFixed(3)})`).join("\n");
}

/** A built prompt: `system` is stable per domain (prompt-cache prefix), `user` changes per call. */
export type BuiltPrompt = { system: string; user: string };
