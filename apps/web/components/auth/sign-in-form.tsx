"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { describeError } from "@/lib/client/api";
import { safeNext, signIn } from "@/lib/client/auth";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { inputClass } from "./auth-card";

export function SignInForm({ next }: { next: string | undefined }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    signIn((input, init) => fetch(input, init), { username, password }).then(
      // A full navigation, so every server-rendered page sees the new sign-in.
      () => window.location.assign(safeNext(next)),
      (failure: unknown) => {
        setPending(false);
        setError(describeError(failure));
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4" aria-label="Sign in">
      <Label htmlFor="username" className="grid gap-1.5 font-normal">
        <span className="text-sm font-medium">Username</span>
        <input id="username" name="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
      </Label>
      <Label htmlFor="password" className="grid gap-1.5 font-normal">
        <span className="text-sm font-medium">Password</span>
        <input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
      </Label>
      {error !== undefined && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        {pending && <Loader2 data-icon="inline-start" className="animate-spin" />}
        Sign in
      </Button>
    </form>
  );
}
