"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { describeError } from "@/lib/client/api";
import { signUp } from "@/lib/client/auth";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { inputClass } from "./auth-card";

export function SignUpForm() {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [requestExpert, setRequestExpert] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    signUp((input, init) => fetch(input, init), { displayName, username, password, requestExpert }).then(
      () => window.location.assign("/home"),
      (failure: unknown) => {
        setPending(false);
        setError(describeError(failure));
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4" aria-label="Create an account">
      <Label htmlFor="display-name" className="grid gap-1.5 font-normal">
        <span className="text-sm font-medium">Your name</span>
        <input id="display-name" name="displayName" autoComplete="name" required maxLength={60} placeholder="e.g. Asha Rao" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
      </Label>
      <Label htmlFor="username" className="grid gap-1.5 font-normal">
        <span className="text-sm font-medium">Username</span>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          minLength={3}
          maxLength={48}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          placeholder="e.g. asha-rao"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          className={inputClass}
        />
        <span className="text-xs leading-snug text-muted-foreground">
          Lowercase letters, digits and hyphens. It never changes: if you become an expert, it names your rulebook.
        </span>
      </Label>
      <Label htmlFor="password" className="grid gap-1.5 font-normal">
        <span className="text-sm font-medium">Password</span>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        <span className="text-xs text-muted-foreground">At least 10 characters.</span>
      </Label>
      <Label htmlFor="request-expert" className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 font-normal">
        <input id="request-expert" type="checkbox" checked={requestExpert} onChange={(e) => setRequestExpert(e.target.checked)} className="mt-0.5 size-4" />
        <span className="grid gap-1">
          <span className="text-sm font-medium">I review these cases for a living: request expert access</span>
          <span className="text-xs leading-snug text-muted-foreground">
            You start as a trainee. An admin reviews the request; once granted, you capture sessions and your confirmed words become rules.
          </span>
        </span>
      </Label>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        {pending && <Loader2 data-icon="inline-start" className="animate-spin" />}
        Create account
      </Button>
    </form>
  );
}
