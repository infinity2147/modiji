"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Clock, Loader2, Lock } from "lucide-react";
import { EXPERT_LANGUAGES, EXPERT_LANGUAGE_LABELS, ExpertLanguageSchema, type ExpertLanguage } from "@vashistha/core";
import { SESSION_STARTS, startRefusal, type ServedCaseSet } from "@/lib/auth/policy";
import type { Viewer } from "@/lib/contracts/auth";
import { createSession, describeError } from "@/lib/client/api";
import { sessionHref } from "@/lib/client/session-url";
import type { SessionMode } from "@/lib/contracts/casedesk";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { MODE_LABELS, SET_LABELS } from "./labels";

type Option<T extends string> = { value: T; description: string };

const MODES: readonly Option<SessionMode>[] = [
  { value: "expert", description: "Work cases as usual. Your review actions are recorded as evidence." },
  { value: "novice", description: "Practise reviews. Every Save passes the deterministic interlock." },
];

const SETS: readonly Option<ServedCaseSet>[] = [
  { value: "training", description: "The cases an expert works during capture." },
  { value: "heldout", description: "Unseen cases, kept back for evaluation." },
  { value: "practice", description: "Cases for novice practice." },
];

function ChoiceGroup<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  label,
  refusal,
}: {
  name: string;
  legend: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: (value: T) => string;
  /** Why the signed-in account may not pick this option (shown in place of nothing; the server enforces it). */
  refusal: (value: T) => string | undefined;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{legend}</legend>
      <RadioGroup
        aria-label={legend}
        value={value}
        onValueChange={(next) => {
          const match = options.find((o) => o.value === next);
          if (match) onChange(match.value);
        }}
        className="gap-2"
      >
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          const refused = refusal(option.value);
          return (
            <Label
              key={option.value}
              htmlFor={id}
              data-refused={refused !== undefined || undefined}
              className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 font-normal transition-colors hover:bg-muted/60 has-data-checked:border-primary/60 has-data-checked:bg-accent data-refused:cursor-not-allowed data-refused:bg-muted/40 data-refused:hover:bg-muted/40"
            >
              <RadioGroupItem id={id} value={option.value} disabled={refused !== undefined} className="mt-0.5" />
              <span className="grid gap-1">
                <span className={refused === undefined ? "text-sm font-medium" : "text-sm font-medium text-muted-foreground"}>{label(option.value)}</span>
                <span className="text-xs leading-snug text-muted-foreground">{option.description}</span>
                {refused !== undefined && (
                  <span className="flex items-start gap-1 text-xs leading-snug text-muted-foreground">
                    <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
                    {refused}
                  </span>
                )}
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

/**
 * Starts a CaseDesk session (`POST /api/sessions`) owned by the signed-in account and moves to its
 * URL. Every option is shown; those the account's role may not start are disabled with the reason
 * (lib/auth/policy.ts, which the server enforces). An expert's identity is the account, not a name.
 */
export function Launcher({ viewer, notice }: { viewer: Viewer; notice?: string | undefined }) {
  const router = useRouter();
  const allowed = SESSION_STARTS[viewer.role];
  const [mode, setMode] = useState<SessionMode>(allowed.mode);
  const [caseSet, setCaseSet] = useState<ServedCaseSet>(allowed.caseSets[0] ?? "practice");
  const [expertLanguage, setExpertLanguage] = useState<ExpertLanguage>("en");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const start = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    createSession((input, init) => fetch(input, init), { mode, caseSet, ...(mode === "expert" && { language: expertLanguage }) }).then(
      (session) => router.push(sessionHref({ sessionId: session.sessionId, caseSet: session.caseSet, mode: session.mode })),
      (failure: unknown) => {
        setPending(false);
        setError(describeError(failure));
      },
    );
  };

  return (
    <main className="grid flex-1 place-items-center p-6">
      <Card className="w-full max-w-2xl gap-0 py-0 shadow-sm">
        <form onSubmit={start} aria-labelledby="launcher-title">
          <CardHeader className="border-b py-4">
            <h2 id="launcher-title" className="font-heading leading-snug text-base font-semibold">Start a review session</h2>
            <CardDescription>
              KYC onboarding reviews under the Northstar Bank Synthetic Review Policy. Every customer, company and
              country is fictional.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 py-5 sm:grid-cols-2">
            <ChoiceGroup
              name="mode"
              legend="Mode"
              options={MODES}
              value={mode}
              onChange={setMode}
              label={(v) => MODE_LABELS[v]}
              refusal={(v) => startRefusal(viewer.role, v, allowed.caseSets[0] ?? "practice")}
            />
            <ChoiceGroup
              name="set"
              legend="Case set"
              options={SETS}
              value={caseSet}
              onChange={setCaseSet}
              label={(v) => SET_LABELS[v]}
              refusal={(v) => startRefusal(viewer.role, mode, v)}
            />
            {mode === "expert" && (
              <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
                <legend className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Expert</legend>
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">Capturing as</span>
                  <p aria-label="Capturing as" className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm">
                    <span className="font-medium">{viewer.displayName}</span>
                    <span className="font-mono text-xs text-muted-foreground">{viewer.username}</span>
                  </p>
                  <span className="text-xs leading-snug text-muted-foreground">
                    Your signed-in account. Every session you capture shares your rulebook, and only you can confirm its rules.
                  </span>
                </div>
                <Label htmlFor="expert-language" className="grid gap-1.5 font-normal">
                  <span className="text-sm font-medium">You will speak</span>
                  <select
                    id="expert-language"
                    name="expertLanguage"
                    value={expertLanguage}
                    onChange={(e) => {
                      const next = ExpertLanguageSchema.safeParse(e.target.value);
                      if (next.success) setExpertLanguage(next.data);
                    }}
                    className="h-10 rounded-full border bg-background px-4 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {EXPERT_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {EXPERT_LANGUAGE_LABELS[l]}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs leading-snug text-muted-foreground">
                    Questions are asked in this language; your words are kept as spoken, with an English translation.
                  </span>
                </Label>
              </fieldset>
            )}
            {viewer.expertRequested && (
              <Alert className="sm:col-span-2">
                <Clock />
                <AlertTitle>Your request for expert access is waiting for an admin</AlertTitle>
                <AlertDescription>Until it is granted, you practise as a trainee. Once granted, sign in again to capture.</AlertDescription>
              </Alert>
            )}
          </CardContent>
          {(notice ?? error) && (
            <div className="grid gap-2 px-4 pb-4">
              {notice && (
                <Alert>
                  <AlertCircle />
                  <AlertTitle>{notice}</AlertTitle>
                </Alert>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Could not start the session</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <CardFooter className="justify-between gap-4 py-3">
            <p className="text-xs text-muted-foreground">
              This page sends DOM events (case opened, risk rating changed, decision committed) to the session ledger.
            </p>
            <Button type="submit" disabled={pending} className="min-w-32">
              {pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              Start session
              {pending ? null : <ArrowRight data-icon="inline-end" />}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
