/**
 * The judge-view event ticker: one human line per ledger entry, parsed through the ledger kind
 * registry (`parseLedgerPayload`), with domain labels for screen events. `system_control` entries are
 * control lines, never styled as evidence. An entry that fails its registry schema is shown as
 * unreadable rather than guessed at.
 */
import { z } from "zod";
import {
  IdSchema,
  MACHINE_TRANSLATION_LABEL,
  isLedgerKind,
  parseLedgerPayload,
  type LedgerEntry,
  type LedgerSource,
  type ScreenEvent,
  type Value,
} from "@vashistha/core";
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { actionLabel, featureLabel } from "../domain";

export type TickerTone = "evidence" | "system" | "control" | "privacy" | "warning";

export type TickerLine = {
  id: string;
  sequence: number;
  occurredAt: number;
  source: LedgerSource;
  kind: string;
  text: string;
  tone: TickerTone;
};

/** What a line may need from earlier entries: the text of each queued question. */
export type TickerContext = { questionText: ReadonlyMap<string, string> };

const FEATURES = new Map(KYC_DOMAIN.features.map((f) => [f.id as string, f]));

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");
const quote = (text: string, max = 90): string => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;

/** A feature value as a reviewer reads it: `35%`, `Yes`, `Medium`. */
export function formatFeatureValue(field: string, value: Value): string {
  const feature = FEATURES.get(field);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    const unit = feature?.type === "number" ? (feature.unit ?? "") : "";
    return `${Number.isInteger(value) ? value : value.toFixed(2)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
  }
  return sentence(value);
}

function screenLine(e: ScreenEvent): string {
  const where = e.caseId === undefined ? "" : ` · ${e.caseId}`;
  switch (e.kind) {
    case "navigate":
      return "Navigated in CaseDesk";
    case "open_case":
      return `Opened case${where}`;
    case "action":
      return `Action: ${actionLabel(e.action ?? "")}${where}`;
    case "field_change": {
      const field = e.field ?? "";
      const label = featureLabel(field);
      const to = e.to === undefined ? "?" : formatFeatureValue(field, e.to);
      // Vision reads a value off the screen; a change with a known prior value reads as a change.
      return e.from === undefined
        ? `${label} read: ${to}${where}`
        : `${label} changed: ${formatFeatureValue(field, e.from)}→${to}${where}`;
    }
  }
}

const QuestionRefSchema = z.looseObject({ questionId: IdSchema.optional(), reason: z.string().optional() });
const RulePayloadSchema = z.looseObject({
  ruleId: z.string().optional(),
  kind: z.string().optional(),
  title: z.string().optional(),
  revision: z.number().optional(),
});

function questionLabel(ctx: TickerContext, questionId: string | undefined): string {
  if (questionId === undefined) return "";
  const text = ctx.questionText.get(questionId);
  return text === undefined ? ` · ${questionId.slice(0, 8)}` : ` · ${quote(text, 70)}`;
}

function ruleLine(verb: string, payload: unknown): string {
  const rule = RulePayloadSchema.parse(payload);
  const name = rule.title ?? rule.ruleId;
  return `${rule.kind === "guardrail" ? "Guardrail" : "Rule"} ${verb}${name === undefined ? "" : `: ${name}`}`;
}

/** The text and tone of one entry; throws when the entry does not match its registry schema. */
function describe(entry: LedgerEntry, ctx: TickerContext): { text: string; tone: TickerTone } {
  const evidence = (text: string) => ({ text, tone: "evidence" as const });
  const system = (text: string) => ({ text, tone: "system" as const });
  if (!isLedgerKind(entry.kind)) return system(sentence(entry.kind.replaceAll(".", " ")));
  switch (entry.kind) {
    case "session.started": {
      const p = parseLedgerPayload(entry, "session.started");
      return system(`Session started · ${p.mode === "expert" ? "expert capture" : "novice practice"} · ${p.caseSet} set`);
    }
    case "session.archived": {
      const p = parseLedgerPayload(entry, "session.archived");
      return system(`Session archived (read-only) · by ${p.by === "operator" ? "the operator" : "the replay export"}`);
    }
    case "screen.event":
      return evidence(screenLine(parseLedgerPayload(entry, "screen.event")));
    case "interlock.check": {
      const p = parseLedgerPayload(entry, "interlock.check");
      return system(`Interlock check · ${actionLabel(p.action)} · ${p.caseId} → ${sentence(p.result.decision)}`);
    }
    case "interlock.blocked": {
      const p = parseLedgerPayload(entry, "interlock.blocked");
      return { text: `Interlock blocked ${actionLabel(p.action)} · ${p.caseId}`, tone: "warning" };
    }
    case "case.decision": {
      const p = parseLedgerPayload(entry, "case.decision");
      const override = p.override === undefined ? "" : ` · ${p.override.kind}`;
      return evidence(`Decision saved: ${actionLabel(p.action)} · ${p.caseId}${override}`);
    }
    case "privacy.off_record":
      parseLedgerPayload(entry, "privacy.off_record");
      return { text: "Off the record — capture stopped", tone: "privacy" };
    case "privacy.on_record":
      parseLedgerPayload(entry, "privacy.on_record");
      return { text: "Back on the record — new privacy epoch", tone: "privacy" };
    case "privacy.phrase_detected":
      parseLedgerPayload(entry, "privacy.phrase_detected");
      return { text: "Off-record phrase heard — agent silenced, mic muting", tone: "privacy" };
    case "frame.received": {
      const p = parseLedgerPayload(entry, "frame.received");
      return evidence(`Frame #${p.frameSeq} received · ${p.redactedRegions} region(s) redacted`);
    }
    case "question.queued": {
      const p = parseLedgerPayload(entry, "question.queued");
      const value = p.kind === "intervention" ? `priority ${p.value.toFixed(2)}` : `EIG ${p.value.toFixed(2)} bits`;
      const english = p.textEnglish === undefined ? "" : ` (English: ${quote(p.textEnglish, 70)})`;
      return system(`Question queued · ${p.reason} · ${value} · ${quote(p.text, 70)}${english}`);
    }
    case "question.dropped": {
      const p = parseLedgerPayload(entry, "question.dropped");
      return system(`Question dropped (${sentence(p.reason)})${questionLabel(ctx, p.questionId)}`);
    }
    case "question.requeued": {
      const p = parseLedgerPayload(entry, "question.requeued");
      return system(`Question re-queued: its authorization expired unspoken${questionLabel(ctx, p.questionId)}`);
    }
    case "gate.authorized": {
      const p = parseLedgerPayload(entry, "gate.authorized");
      return system(`Gate authorized${questionLabel(ctx, p.questionId)} · ${p.decidedAt - p.becameValidAt} ms after valid`);
    }
    case "gate.authorization_issued":
      parseLedgerPayload(entry, "gate.authorization_issued");
      return { text: "Authorization issued", tone: "control" };
    case "gate.control_message": {
      const p = QuestionRefSchema.parse(parseLedgerPayload(entry, "gate.control_message"));
      return { text: `Control message${p.questionId === undefined ? ` (refused: ${p.reason ?? "invalid"})` : ""}`, tone: "control" };
    }
    case "llm.turn_decision": {
      const p = parseLedgerPayload(entry, "llm.turn_decision");
      const ref = QuestionRefSchema.parse(p);
      return p.decision === "speak"
        ? system(`Agent asks${questionLabel(ctx, ref.questionId)}`)
        : system(`Agent turn skipped (${ref.reason === undefined ? "no authorization" : sentence(ref.reason)})`);
    }
    case "llm.stream_aborted":
      parseLedgerPayload(entry, "llm.stream_aborted");
      return { text: "Agent speech stream aborted — the authorization stays usable once", tone: "warning" };
    case "utterance.transcript": {
      const p = parseLedgerPayload(entry, "utterance.transcript");
      return evidence(`Expert${p.language === undefined ? "" : ` (${p.language})`}: ${quote(p.text)}`);
    }
    case "utterance.translated":
      return system(`${MACHINE_TRANSLATION_LABEL}: ${quote(parseLedgerPayload(entry, "utterance.translated").translation)}`);
    case "agent.utterance":
      return system(`Agent: ${quote(parseLedgerPayload(entry, "agent.utterance").text)}`);
    case "answer.parsed": {
      const p = parseLedgerPayload(entry, "answer.parsed");
      return system(
        `Answer parsed · ${p.eliminatedCandidateIds.length} hypothesis(es) eliminated · ${p.statedRules.length} rule(s) stated · ${p.newConcepts.length} new concept(s)`,
      );
    }
    case "hypotheses.updated": {
      const p = parseLedgerPayload(entry, "hypotheses.updated");
      const top = p.top[0];
      const surprise = p.surpriseBits === undefined ? "" : ` · surprise ${p.surpriseBits.toFixed(2)} bits`;
      const lead = top === undefined ? "" : ` · top: ${top.description} (${top.weight.toFixed(2)})`;
      return system(`${p.contradiction ? "Contradiction detected" : "Hypotheses updated"} · ${p.decisionFamily}${lead}${surprise}`);
    }
    case "concept.proposed":
      return system(`New concept proposed: ${parseLedgerPayload(entry, "concept.proposed").label}`);
    case "concept.confirmed": {
      const p = parseLedgerPayload(entry, "concept.confirmed");
      return evidence(`Concept confirmed by the expert: ${p.definition.label} · ${quote(p.statement.text)}`);
    }
    case "concept.dismissed": {
      const p = parseLedgerPayload(entry, "concept.dismissed");
      return evidence(`Concept dismissed: ${p.name} · ${p.coveredBy === undefined ? "not a real concept" : `already covered by ${featureLabel(p.coveredBy)}`}`);
    }
    case "schema.version_bumped": {
      const p = parseLedgerPayload(entry, "schema.version_bumped");
      return system(`Model updated: new concept ${p.label} · schema v${p.from} → v${p.to} · coverage recomputing`);
    }
    case "feature.backfilled": {
      const p = parseLedgerPayload(entry, "feature.backfilled");
      const value = typeof p.value === "object" ? `unknown (${sentence(p.failure ?? "backfill_failed").toLowerCase()})` : String(p.value);
      return system(`Backfill ${p.feature} for ${p.caseId}: ${value} · ${p.frameIds.length} frame(s) re-read`);
    }
    case "rule.confirmed":
      return evidence(ruleLine("confirmed", parseLedgerPayload(entry, "rule.confirmed")));
    case "rule.revised":
      return evidence(ruleLine("revised", parseLedgerPayload(entry, "rule.revised")));
    case "rule.retired":
      return evidence(ruleLine("retired", parseLedgerPayload(entry, "rule.retired")));
    case "witness.found": {
      const p = parseLedgerPayload(entry, "witness.found");
      return system(`Solver found a ${p.kind} counterexample · ${p.decisionFamily}`);
    }
    case "witness.resolved":
      return evidence(`Debrief gap closed (${sentence(parseLedgerPayload(entry, "witness.resolved").resolution)})`);
    case "expert.statement": {
      const p = parseLedgerPayload(entry, "expert.statement");
      return evidence(`Expert (typed, ${sentence(p.intent)}): ${quote(p.text)}`);
    }
    case "teachback.generated":
      return system(`Teach-back written from ${parseLedgerPayload(entry, "teachback.generated").ruleIds.length} confirmed rule(s)`);
    case "teachback.confirmed":
      return evidence(`Teach-back confirmed · rulebook revision ${parseLedgerPayload(entry, "teachback.confirmed").rulebookRevision}`);
    case "workmap.generated":
      return system(`Work Map generated · revision ${parseLedgerPayload(entry, "workmap.generated").rulebookRevision}`);
    case "tutor.prediction": {
      const p = parseLedgerPayload(entry, "tutor.prediction");
      return evidence(`Prediction ${p.correct ? "correct" : "wrong"}: ${actionLabel(p.predicted)} (expected ${actionLabel(p.expected)}) · ${p.caseId}`);
    }
    case "tutor.intervention": {
      const p = parseLedgerPayload(entry, "tutor.intervention");
      return {
        text: `Tutor intervened · ${p.caseId} · ${sentence(p.trigger)} on ${actionLabel(p.proposedAction)}`,
        tone: "warning",
      };
    }
    case "mastery.updated": {
      const p = parseLedgerPayload(entry, "mastery.updated");
      return evidence(`Mastery · ${p.ruleId.slice(0, 8)}: ${sentence(p.from)}→${sentence(p.to)}`);
    }
    case "tutor.intent": {
      const p = parseLedgerPayload(entry, "tutor.intent");
      return evidence(`Outcome selected (not saved): ${actionLabel(p.proposedAction)} · ${p.caseId}`);
    }
    case "case.generated": {
      const p = parseLedgerPayload(entry, "case.generated");
      return system(`${p.origin.kind === "judge" ? "Judge-entered case" : "Practice case at a rule boundary"} · ${p.case.id}`);
    }
  }
}

export function tickerLine(entry: LedgerEntry, ctx: TickerContext): TickerLine {
  let described: { text: string; tone: TickerTone };
  try {
    described = describe(entry, ctx);
  } catch {
    described = { text: `Unreadable ${entry.kind} entry (does not match its registered schema)`, tone: "warning" };
  }
  // Control traffic is never styled as evidence, whatever its kind.
  const tone = entry.source === "system_control" && described.tone !== "privacy" ? "control" : described.tone;
  return {
    id: entry.id,
    sequence: entry.sequence,
    occurredAt: entry.occurredAt,
    source: entry.source,
    kind: entry.kind,
    text: described.text,
    tone,
  };
}

const QuestionTextSchema = z.looseObject({ id: IdSchema, text: z.string() });

/** The newest `limit` ticker lines (oldest first), with question texts resolved from the whole ledger. */
export function tickerLines(entries: readonly LedgerEntry[], limit: number): TickerLine[] {
  const questionText = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "question.queued") continue;
    const parsed = QuestionTextSchema.safeParse(entry.payload);
    if (parsed.success) questionText.set(parsed.data.id, parsed.data.text);
  }
  return entries.slice(-limit).map((entry) => tickerLine(entry, { questionText }));
}
