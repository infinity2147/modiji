"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import type { CaseSet } from "@vashistha/core/domains/kyc";
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

const SETS: readonly Option<Exclude<CaseSet, "bench">>[] = [
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
}: {
  name: string;
  legend: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: (value: T) => string;
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
          return (
            <Label
              key={option.value}
              htmlFor={id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 font-normal transition-colors hover:bg-muted/60 has-data-checked:border-primary/60 has-data-checked:bg-accent"
            >
              <RadioGroupItem id={id} value={option.value} className="mt-0.5" />
              <span className="grid gap-1">
                <span className="text-sm font-medium">{label(option.value)}</span>
                <span className="text-xs leading-snug text-muted-foreground">{option.description}</span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

/** Starts a CaseDesk session (`POST /api/sessions`) and moves to its URL. */
export function Launcher({ notice }: { notice?: string | undefined }) {
  const router = useRouter();
  const [mode, setMode] = useState<SessionMode>("expert");
  const [caseSet, setCaseSet] = useState<Exclude<CaseSet, "bench">>("training");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const start = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    createSession((input, init) => fetch(input, init), { mode, caseSet }).then(
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
            <ChoiceGroup name="mode" legend="Mode" options={MODES} value={mode} onChange={setMode} label={(v) => MODE_LABELS[v]} />
            <ChoiceGroup
              name="set"
              legend="Case set"
              options={SETS}
              value={caseSet}
              onChange={setCaseSet}
              label={(v) => SET_LABELS[v]}
            />
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
