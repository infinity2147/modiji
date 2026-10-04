"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react";
import { EXPERT_LANGUAGES, EXPERT_LANGUAGE_LABELS, ExpertLanguageSchema, type ExpertLanguage } from "@vashistha/core";
import type { ServedCaseSet } from "@/lib/auth/policy";
import type { SessionMode } from "@/lib/contracts/casedesk";
import { createSession, describeError } from "@/lib/client/api";
import { sessionHref } from "@/lib/client/session-url";
import { Button } from "@/components/ui/button";

/**
 * One button that starts exactly the session this card names (the server still checks the role).
 * A capture card also asks which language the expert will speak.
 */
export function StartCard({
  mode,
  caseSet,
  label,
  tone = "primary",
  askLanguage = false,
}: {
  mode: SessionMode;
  caseSet: ServedCaseSet;
  label: string;
  tone?: "primary" | "light";
  askLanguage?: boolean;
}) {
  const router = useRouter();
  const [language, setLanguage] = useState<ExpertLanguage>("en");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const start = () => {
    setPending(true);
    setError(undefined);
    createSession((input, init) => fetch(input, init), { mode, caseSet, ...(askLanguage && { language }) }).then(
      (session) => router.push(sessionHref({ sessionId: session.sessionId, caseSet: session.caseSet, mode: session.mode })),
      (failure: unknown) => {
        setPending(false);
        setError(describeError(failure));
      },
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {askLanguage && (
          <label className="flex items-center gap-2 text-sm font-medium">
            You will speak
            <select
              value={language}
              onChange={(e) => {
                const next = ExpertLanguageSchema.safeParse(e.target.value);
                if (next.success) setLanguage(next.data);
              }}
              className="h-10 rounded-md border bg-background px-4 text-sm text-foreground"
            >
              {EXPERT_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {EXPERT_LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button size="lg" variant={tone === "light" ? "outline" : "default"} disabled={pending} onClick={start}>
          {pending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          {label}
          {pending ? null : <ArrowRight data-icon="inline-end" />}
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-highlight">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
