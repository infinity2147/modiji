"use client";

/**
 * Undefined concepts (plan §6.6, §7.5): what the interview proposer, the answer parser or vision noticed
 * that the feature model lacks, with the expert's quote. The EXPERT confirms one as a feature (their
 * label, type, values or bounds, and their own words) or dismisses it; the server then versions the
 * model, re-reads past cases from their stored redacted frames and recomputes. Everything shown comes
 * from `GET /api/sessions/:id/concepts`.
 */
import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { FeatureIdSchema } from "@vashistha/core";
import { describeError, postJson, requestJson } from "@/lib/client/api";
import {
  ConceptActionResponseSchema,
  ConceptsStateSchema,
  type ConceptActionRequest,
  type ConceptsState,
} from "@/lib/contracts/concepts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuoteForm } from "@/components/debrief/quote-form";

const POLL_MS = { idle: 5_000, recomputing: 1_000 } as const;
const ORIGIN: Record<ConceptsState["undefinedConcepts"][number]["origin"], string> = { interview: "interview", answer: "answer parser", vision: "screen (vision)" };
const FAILURE: Record<string, string> = {
  no_model: "no vision model",
  no_frames: "no frame of the case",
  frames_missing: "frames not stored",
  not_visible: "not visible on screen",
  invalid_value: "unreadable value",
  model_error: "re-read failed",
};

const url = (sessionId: string): string => `/api/sessions/${encodeURIComponent(sessionId)}/concepts`;
const field = "w-full rounded-md border bg-background px-2 py-1 text-sm";

/** "Model updated: new concept … — coverage recomputing" (plan §6.6), while and after the backfill runs. */
function ModelUpdatedBanner({ state }: { state: ConceptsState }) {
  if (state.latest === null) return null;
  return (
    <p role="status" data-testid="model-updated" className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 text-sm">
      <Sparkles className="size-4" />
      <span>
        Model updated: new concept <em className="font-semibold">{state.latest.label}</em> —{" "}
        {state.recomputing ? "coverage recomputing" : `coverage recomputed under schema v${state.schemaVersion}`}
      </span>
    </p>
  );
}

type Concepts = { state: ConceptsState | null; error: string | null; act: (body: ConceptActionRequest) => Promise<void> };

/** Polls the session's concepts (fast while a backfill runs) and records the expert's confirm/dismiss. */
function useConcepts(sessionId: string, onChange?: () => void): Concepts {
  const [state, setState] = useState<ConceptsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await requestJson(fetch, url(sessionId), ConceptsStateSchema));
    } catch {
      // Not an expert session, or the server is away: nothing is shown or the last state stays.
    }
  }, [sessionId]);

  const recomputing = state?.recomputing ?? false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), recomputing ? POLL_MS.recomputing : POLL_MS.idle);
    return () => clearInterval(timer);
  }, [load, recomputing]);

  /** Rejects when refused, so the form keeps the expert's words. */
  const act = useCallback(
    async (body: ConceptActionRequest): Promise<void> => {
      try {
        await requestJson(fetch, url(sessionId), ConceptActionResponseSchema, postJson(body));
        setError(null);
      } catch (e) {
        setError(describeError(e));
        throw e;
      }
      await load();
      onChange?.();
    },
    [load, onChange, sessionId],
  );
  return { state, error, act };
}

/** The debrief's concepts card. `onChange` runs after a confirm/dismiss (the debrief refreshes its coverage). */
export function ConceptsPanel({ sessionId, onChange }: { sessionId: string; onChange?: () => void }) {
  const concepts = useConcepts(sessionId, onChange);
  return concepts.state === null ? null : <ConceptsCard state={concepts.state} error={concepts.error} act={concepts.act} />;
}

/** CaseDesk judge view: the banner and a "Concepts" toggle opening the same card in a side drawer. */
export function JudgeConcepts({ sessionId }: { sessionId: string }) {
  const { state, error, act } = useConcepts(sessionId);
  const [open, setOpen] = useState(false);
  if (state === null) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      {state.latest !== null && (
        <span className="text-slate-200" data-testid="judge-model-updated">
          Model updated: new concept <em>{state.latest.label}</em> — {state.recomputing ? "coverage recomputing" : `schema v${state.schemaVersion}`}
        </span>
      )}
      <button type="button" aria-expanded={open} className="rounded px-2 py-0.5 text-slate-200 hover:bg-slate-800" onClick={() => setOpen((o) => !o)}>
        Concepts {state.undefinedConcepts.length}
      </button>
      {open && (
        <div role="dialog" aria-label="Undefined concepts" className="fixed right-4 bottom-4 z-50 max-h-[70vh] w-[30rem] overflow-y-auto rounded-lg shadow-xl">
          <ConceptsCard state={state} error={error} act={act} />
        </div>
      )}
    </div>
  );
}

function ConceptsCard({ state, error, act }: { state: ConceptsState; error: string | null; act: (body: ConceptActionRequest) => Promise<void> }) {
  return (
    <Card aria-label="Undefined concepts" data-testid="concepts">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Undefined concepts <Badge variant={state.undefinedConcepts.length === 0 ? "secondary" : "destructive"}>{state.undefinedConcepts.length}</Badge>
          <span className="ml-auto font-mono text-xs text-muted-foreground">schema v{state.schemaVersion}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Proposed by the models, never applied on their own. Confirming one adds it to the feature model; past cases are re-read from their stored redacted frames
          {state.rereadAvailable ? "" : " (no vision model configured: their values stay unknown)"}.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ModelUpdatedBanner state={state} />
        {error !== null && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {state.undefinedConcepts.length === 0 && <p className="text-sm text-muted-foreground">No undefined concept under the current model.</p>}
        <ul className="space-y-3">
          {state.undefinedConcepts.map((c) => (
            <ConceptItem key={c.name} concept={c} features={state.features} act={act} />
          ))}
        </ul>
        {state.confirmed.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Confirmed concepts</h3>
            <ul className="space-y-2">
              {state.confirmed.map((c) => (
                <li key={c.name} className="rounded-md border p-2 text-sm" data-testid={`confirmed-${c.name}`}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{c.name}</span>
                    <Badge variant="outline">v{c.schemaVersion}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">“{c.statement}”</p>
                  <ul className="mt-1 grid gap-0.5 font-mono text-xs">
                    {c.backfill.map((b) => (
                      <li key={b.decisionEntryId}>
                        {b.caseId}: {b.entryId === null ? "re-reading…" : b.value !== null ? String(b.value) : `unknown (${FAILURE[b.failure ?? ""] ?? "backfill failed"})`}
                        {b.frameIds.length > 0 && <span className="text-muted-foreground"> · {b.frameIds.length} frame(s)</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.dismissed.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Dismissed: {state.dismissed.map((d) => (d.coveredBy === null ? d.name : `${d.name} (covered by ${d.coveredBy})`)).join(", ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

type Concept = ConceptsState["undefinedConcepts"][number];

function ConceptItem({ concept, features, act }: { concept: Concept; features: ConceptsState["features"]; act: (b: ConceptActionRequest) => Promise<void> }) {
  const [mode, setMode] = useState<"confirm" | "dismiss" | null>(null);
  return (
    <li className="space-y-2 rounded-md border p-3" data-testid={`concept-${concept.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{concept.label}</span>
        <span className="font-mono text-xs text-muted-foreground">{concept.name}</span>
        <Badge variant="outline">{concept.type}</Badge>
        <Badge variant="secondary">from {ORIGIN[concept.origin]}</Badge>
      </div>
      <p className="text-sm">{concept.definition}</p>
      {concept.quote !== null && <p className="text-sm italic text-muted-foreground">Expert: “{concept.quote}”</p>}
      <div className="flex gap-2">
        <button type="button" className="text-sm underline" onClick={() => setMode(mode === "confirm" ? null : "confirm")}>
          Confirm as a feature
        </button>
        <button type="button" className="text-sm underline" onClick={() => setMode(mode === "dismiss" ? null : "dismiss")}>
          Dismiss
        </button>
      </div>
      {mode === "confirm" && <ConfirmForm concept={concept} act={act} />}
      {mode === "dismiss" && <DismissForm concept={concept} features={features} act={act} />}
    </li>
  );
}

function ConfirmForm({ concept, act }: { concept: Concept; act: (b: ConceptActionRequest) => Promise<void> }) {
  const [label, setLabel] = useState(concept.label.charAt(0).toUpperCase() + concept.label.slice(1));
  const [type, setType] = useState<Concept["type"]>(concept.type);
  const [values, setValues] = useState(concept.values.join(", "));
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("100");
  const [integer, setInteger] = useState(true);
  const [unit, setUnit] = useState("");
  const definition = (): Extract<ConceptActionRequest, { action: "confirm" }>["definition"] => {
    const base = { label: label.trim() };
    if (type === "enum") return { ...base, type, values: values.split(",").map((v) => v.trim()).filter((v) => v !== "") };
    if (type === "number") return { ...base, type, min: Number(min), max: Number(max), integer, ...(unit.trim() !== "" && { unit: unit.trim() }) };
    return { ...base, type };
  };
  return (
    <QuoteForm
      submitLabel="Confirm concept"
      placeholder="e.g. Yes — documents complete means nothing on the checklist is missing or expired."
      onSubmit={(text) => act({ action: "confirm", name: concept.name, definition: definition(), statement: { text } })}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Label
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Concept label" />
        </label>
        <label className="text-xs">
          Type
          <select className={field} value={type} onChange={(e) => setType(e.target.value as Concept["type"])} aria-label="Concept type">
            <option value="boolean">yes / no</option>
            <option value="enum">one of a list</option>
            <option value="number">number</option>
          </select>
        </label>
        {type === "enum" && (
          <label className="text-xs sm:col-span-2">
            Values (comma-separated)
            <input className={field} value={values} onChange={(e) => setValues(e.target.value)} aria-label="Concept values" />
          </label>
        )}
        {type === "number" && (
          <>
            <label className="text-xs">
              Min
              <input className={field} type="number" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Minimum" />
            </label>
            <label className="text-xs">
              Max
              <input className={field} type="number" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Maximum" />
            </label>
            <label className="text-xs">
              Unit
              <input className={field} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={integer} onChange={(e) => setInteger(e.target.checked)} /> whole numbers
            </label>
          </>
        )}
      </div>
    </QuoteForm>
  );
}

function DismissForm({ concept, features, act }: { concept: Concept; features: ConceptsState["features"]; act: (b: ConceptActionRequest) => Promise<void> }) {
  const [coveredBy, setCoveredBy] = useState("");
  return (
    <QuoteForm
      submitLabel="Dismiss concept"
      placeholder="e.g. That's just the source-of-funds check."
      onSubmit={(text) =>
        act(
          coveredBy === ""
            ? { action: "dismiss", name: concept.name, reason: "not_a_concept", statement: { text } }
            : { action: "dismiss", name: concept.name, reason: "already_covered", coveredBy: FeatureIdSchema.parse(coveredBy), statement: { text } },
        )
      }
    >
      <label className="text-xs">
        Why
        <select className={field} value={coveredBy} onChange={(e) => setCoveredBy(e.target.value)} aria-label="Dismiss reason">
          <option value="">not a real concept</option>
          {features.map((f) => (
            <option key={f.id} value={f.id}>
              already covered by {f.label}
            </option>
          ))}
        </select>
      </label>
    </QuoteForm>
  );
}
