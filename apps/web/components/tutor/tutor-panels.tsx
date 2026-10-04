"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, FlaskConical, Loader2, PlusCircle } from "lucide-react";
import type { KycCase } from "@vashistha/core/domains/kyc";
import { describeError } from "@/lib/client/api";
import type { Tutor } from "@/lib/client/tutor/use-tutor";
import { LEVEL_LABELS, ladder } from "@/lib/client/tutor/view";
import { JudgeFeaturesSchema, type JudgeFeatures, type TutorRule } from "@/lib/contracts/tutor";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function MasteryRow({ rule }: { rule: TutorRule }) {
  const steps = ladder(rule.level);
  return (
    <li className="grid gap-1.5 py-2" data-testid="mastery-rule" data-level={rule.level}>
      <p className="text-[12px] leading-snug">
        <span className="text-muted-foreground">When</span> {rule.when}: <span className="font-medium">{rule.then}</span>
      </p>
      <div className="flex items-center gap-2">
        <ol aria-label={`Mastery: ${LEVEL_LABELS[rule.level]}`} className="flex gap-0.5">
          {steps.map((s) => (
            <li key={s.level} title={s.label} className={cn("h-1.5 w-6 rounded-full", s.reached ? "bg-emerald-500" : "bg-muted")} />
          ))}
        </ol>
        <span className="text-[11px] text-muted-foreground">{LEVEL_LABELS[rule.level]}</span>
      </div>
    </li>
  );
}

function MasteryPanel({ tutor }: { tutor: Tutor }) {
  const state = tutor.state;
  return (
    <Card className="gap-0 py-0 shadow-xs" role="region" aria-labelledby="mastery-title">
      <CardHeader className="border-b py-3!">
        <h2 id="mastery-title" className="text-sm font-semibold">
          Mastery ladder
        </h2>
        <CardDescription className="text-[11px]">
          One bar per expert rule, from untested up to mastered. {" "}
          <span className="font-medium">{state?.masteryLabel ?? "heuristic estimate"}</span>, not a calibrated model.
        </CardDescription>
      </CardHeader>
      <CardContent className="py-1">
        {state === undefined ? (
          <p className="py-2 text-xs text-muted-foreground">Loading…</p>
        ) : state.rules.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No expert has confirmed rules yet, so there is nothing to master. See the coach above.</p>
        ) : (
          <ul className="divide-y">
            {state.rules.map((rule) => (
              <MasteryRow key={rule.ruleId} rule={rule} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const DEFAULT_FEATURES: JudgeFeatures = {
  entityType: "company",
  customerStatus: "new",
  accountAgeMonths: 0,
  jurisdictionRisk: "high",
  uboOwnershipPct: 30,
  uboVerified: true,
  pep: false,
  sanctionsHit: false,
  adverseMedia: false,
  sourceOfFunds: "verified",
  expectedMonthlyVolume: 50_000,
};

const FIELD_CLASS = "h-7 w-full rounded-md border bg-background px-2 text-[12px]";

function SelectField<K extends keyof JudgeFeatures>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: K;
  label: string;
  options: readonly string[];
  value: string;
  onChange: (name: K, value: string) => void;
}) {
  return (
    <label className="grid gap-0.5 text-[11px] text-muted-foreground">
      {label}
      <select name={name} className={FIELD_CLASS} value={value} onChange={(e) => onChange(name, e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A judge's own unseen case: decision-feature values within the domain's types (the server re-validates). */
function JudgeCaseForm({ tutor, onAdded }: { tutor: Tutor; onAdded: (kycCase: KycCase) => void }) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(DEFAULT_FEATURES).map(([k, v]) => [k, String(v)])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = JudgeFeaturesSchema.safeParse({
      ...values,
      accountAgeMonths: Number(values.accountAgeMonths),
      uboOwnershipPct: Number(values.uboOwnershipPct),
      expectedMonthlyVolume: Number(values.expectedMonthlyVolume),
      uboVerified: values.uboVerified === "true",
      pep: values.pep === "true",
      sanctionsHit: values.sanctionsHit === "true",
      adverseMedia: values.adverseMedia === "true",
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setPending(true);
    setError(undefined);
    tutor.judgeCase(parsed.data).then(
      (kycCase) => {
        setPending(false);
        onAdded(kycCase);
      },
      (failure: unknown) => {
        setPending(false);
        setError(describeError(failure));
      },
    );
  };

  const yesNo = ["false", "true"] as const;
  return (
    <form onSubmit={submit} aria-label="Enter a judge case" className="grid gap-2">
      <div className="grid grid-cols-2 gap-2">
        <SelectField name="entityType" label="Entity type" options={["individual", "company", "trust"]} value={values.entityType ?? ""} onChange={set} />
        <SelectField name="customerStatus" label="Customer status" options={["new", "existing"]} value={values.customerStatus ?? ""} onChange={set} />
        <label className="grid gap-0.5 text-[11px] text-muted-foreground">
          Relationship age (months)
          <input name="accountAgeMonths" type="number" min={0} max={600} step={1} className={FIELD_CLASS} value={values.accountAgeMonths} onChange={(e) => set("accountAgeMonths", e.target.value)} />
        </label>
        <SelectField name="jurisdictionRisk" label="Country risk" options={["low", "medium", "high"]} value={values.jurisdictionRisk ?? ""} onChange={set} />
        <label className="grid gap-0.5 text-[11px] text-muted-foreground">
          Largest owner share (%)
          <input name="uboOwnershipPct" type="number" min={0.1} max={100} step={0.1} className={FIELD_CLASS} value={values.uboOwnershipPct} onChange={(e) => set("uboOwnershipPct", e.target.value)} />
        </label>
        <SelectField name="uboVerified" label="Owner verified" options={yesNo} value={values.uboVerified ?? ""} onChange={set} />
        <SelectField name="pep" label="PEP" options={yesNo} value={values.pep ?? ""} onChange={set} />
        <SelectField name="sanctionsHit" label="Sanctions match" options={yesNo} value={values.sanctionsHit ?? ""} onChange={set} />
        <SelectField name="adverseMedia" label="Adverse media" options={yesNo} value={values.adverseMedia ?? ""} onChange={set} />
        <SelectField name="sourceOfFunds" label="Source of funds" options={["verified", "unverified", "not_provided"]} value={values.sourceOfFunds ?? ""} onChange={set} />
        <label className="col-span-2 grid gap-0.5 text-[11px] text-muted-foreground">
          Expected monthly volume (EUR)
          <input name="expectedMonthlyVolume" type="number" min={0} max={10_000_000} step={500} className={FIELD_CLASS} value={values.expectedMonthlyVolume} onChange={(e) => set("expectedMonthlyVolume", e.target.value)} />
        </label>
      </div>
      {error && <p role="alert" className="text-[11px] text-red-700">{error}</p>}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <PlusCircle data-icon="inline-start" />}
        Add judge case to the queue
      </Button>
    </form>
  );
}

function PracticePanel({ tutor, onCases, canEnterJudgeCase }: { tutor: Tutor; onCases: (cases: readonly KycCase[]) => void; canEnterJudgeCase: boolean }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string }>();
  const [judgeOpen, setJudgeOpen] = useState(false);

  const generate = () => {
    setPending(true);
    setMessage(undefined);
    tutor.practice().then(
      ({ cases, note }) => {
        setPending(false);
        onCases(cases);
        const made = cases.length === 0 ? "No new practice cases." : `Added ${cases.map((c) => c.id).join(", ")} to the queue.`;
        setMessage({ tone: "info", text: note === null ? made : `${made} ${note}` });
      },
      (failure: unknown) => {
        setPending(false);
        setMessage({ tone: "error", text: describeError(failure) });
      },
    );
  };

  return (
    <Card className="gap-0 py-0 shadow-xs" role="region" aria-labelledby="practice-title">
      <CardHeader className="border-b py-3!">
        <h2 id="practice-title" className="text-sm font-semibold">
          More practice
        </h2>
        <CardDescription className="text-[11px]">
          New cases built at the edge of the rules you know least, so you meet the situations an expert finds hard.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 py-3">
        <Button type="button" size="sm" onClick={generate} disabled={pending}>
          {pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FlaskConical data-icon="inline-start" />}
          Generate practice cases
        </Button>
        {message && (
          <p role="status" className={cn("text-[11px]", message.tone === "error" ? "text-red-700" : "text-muted-foreground")}>
            {message.text}
          </p>
        )}
        {canEnterJudgeCase && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setJudgeOpen((o) => !o)} aria-expanded={judgeOpen}>
            {judgeOpen ? "Hide judge case form" : "Enter a judge case"}
          </Button>
        )}
        {canEnterJudgeCase && judgeOpen && (
          <JudgeCaseForm
            tutor={tutor}
            onAdded={(kycCase) => {
              onCases([kycCase]);
              setMessage({ tone: "info", text: `Added ${kycCase.id} to the queue.` });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The tutor's side panels (novice sessions): the mastery ladder, and practice and judge cases. */
export function TutorPanels({ tutor, onCases, canEnterJudgeCase = false }: { tutor: Tutor; onCases: (cases: readonly KycCase[]) => void; canEnterJudgeCase?: boolean }) {
  return (
    <>
      {tutor.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Tutor unavailable</AlertTitle>
          <AlertDescription>{tutor.error}</AlertDescription>
        </Alert>
      )}
      <MasteryPanel tutor={tutor} />
      <PracticePanel tutor={tutor} onCases={onCases} canEnterJudgeCase={canEnterJudgeCase} />
    </>
  );
}
