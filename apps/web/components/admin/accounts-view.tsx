"use client";

/**
 * The admin's Accounts page: pending expert requests first (granting the expert role is the decision
 * the whole rulebook rests on), then every account, then the append-only audit trail of who changed
 * whom. Every action is checked again by the server.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, X } from "lucide-react";
import { USER_ROLES } from "@vashistha/core";
import { ROLE_LABELS } from "@/lib/auth/policy";
import type { AccountEvent, AdminActionRequest, AdminUser, AdminUsersResponse, Viewer } from "@/lib/contracts/auth";
import { describeError } from "@/lib/client/api";
import { accountAction, listAccounts } from "@/lib/client/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

function eventText(e: AccountEvent): string {
  const by = e.actor === null ? "" : ` by ${e.actor}`;
  switch (e.kind) {
    case "signed_up":
      return `${e.subject} signed up${e.detail.expertRequested === true ? " and requested expert access" : ""}`;
    case "bootstrapped":
      return `${e.subject} created as the first admin (ADMIN_USERNAME)`;
    case "role_changed":
      return `${e.subject}: ${String(e.detail.from)} → ${String(e.detail.to)}${by}`;
    case "expert_declined":
      return `${e.subject}'s expert request declined${by}`;
    case "disabled":
      return `${e.subject} disabled${by}`;
    case "enabled":
      return `${e.subject} enabled${by}`;
  }
}

/** Sessions recorded under this username before it had an account: granting the expert role hands them over. */
function PriorSessions({ user }: { user: AdminUser }) {
  if (user.role === "expert" || user.expertSessions === 0) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      {user.expertSessions} capture session{user.expertSessions === 1 ? "" : "s"} already exist under the expert id “{user.username}”, from before accounts. Granting the expert role makes that rulebook theirs: check this is the same person.
    </p>
  );
}

export function AccountsView({ viewer }: { viewer: Viewer }) {
  const [state, setState] = useState<AdminUsersResponse | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    listAccounts(fetch).then(setState, (e: unknown) => setError(describeError(e)));
  }, []);

  const act = useCallback((user: AdminUser, body: AdminActionRequest) => {
    setBusy(user.id);
    setError(undefined);
    accountAction(fetch, user.id, body)
      .then(setState, (e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(undefined));
  }, []);

  const pending = state?.users.filter((u) => u.expertRequested && u.role === "trainee" && !u.disabled) ?? [];

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {viewer.displayName} (admin). Anyone may sign up as a trainee; only an admin grants the expert role.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link href="/sandbox">
            <ArrowLeft data-icon="inline-start" />
            CaseDesk
          </Link>
        </Button>
      </header>
      {error !== undefined && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
          {error}
        </p>
      )}
      {state === null && error === undefined && <p className="text-muted-foreground">Loading accounts…</p>}
      {state !== null && (
        <>
          <Card aria-label="Expert requests">
            <CardHeader>
              <CardTitle>Expert requests ({pending.length})</CardTitle>
              <CardDescription>An expert&apos;s confirmed words become rules that every trainee and agent is checked against. Grant only to people who do this work.</CardDescription>
            </CardHeader>
            <CardContent>
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">No pending requests.</p>
              ) : (
                <ul className="space-y-2">
                  {pending.map((u) => (
                    <li key={u.id} className="grid gap-2 rounded-md border p-3" data-testid="expert-request">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{u.displayName}</span>
                        <span className="font-mono text-xs text-muted-foreground">{u.username}</span>
                        <span className="text-xs text-muted-foreground">signed up {WHEN.format(u.createdAt)}</span>
                        <div className="ml-auto flex gap-2">
                          <Button size="sm" disabled={busy !== undefined} onClick={() => act(u, { action: "set_role", role: "expert" })}>
                            <Check data-icon="inline-start" />
                            Grant expert
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => act(u, { action: "decline_expert" })}>
                            <X data-icon="inline-start" />
                            Decline
                          </Button>
                        </div>
                      </div>
                      <PriorSessions user={u} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card aria-label="All accounts">
            <CardHeader>
              <CardTitle>All accounts ({state.users.length})</CardTitle>
              <CardDescription>A role change applies on the account&apos;s next request. Disabling ends every sign-in at once. You cannot change your own account.</CardDescription>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 font-medium">Account</th>
                    <th className="py-2 font-medium">Role</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {state.users.map((u) => {
                    const self = u.id === viewer.id;
                    return (
                      <tr key={u.id} className="border-b align-top last:border-0" data-testid="account-row" data-username={u.username}>
                        <td className="py-2">
                          <span className="font-medium">{u.displayName}</span> <span className="font-mono text-xs text-muted-foreground">{u.username}</span>
                          {self && <span className="text-xs text-muted-foreground"> (you)</span>}
                          <PriorSessions user={u} />
                        </td>
                        <td className="py-2">
                          <Badge variant={u.role === "trainee" ? "outline" : "secondary"}>{ROLE_LABELS[u.role]}</Badge>
                          {u.expertRequested && u.role === "trainee" && <span className="ml-1.5 text-xs text-muted-foreground">expert requested</span>}
                        </td>
                        <td className="py-2">{u.disabled ? <Badge variant="destructive">disabled</Badge> : <span className="text-muted-foreground">active</span>}</td>
                        <td className="py-2">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <select
                              aria-label={`Role of ${u.username}`}
                              disabled={self || busy !== undefined}
                              value={u.role}
                              onChange={(e) => {
                                const role = USER_ROLES.find((r) => r === e.target.value);
                                if (role !== undefined) act(u, { action: "set_role", role });
                              }}
                              className="h-7 rounded-md border bg-background px-2 text-xs"
                            >
                              {USER_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                            <Button size="xs" variant="outline" disabled={self || busy !== undefined} onClick={() => act(u, { action: "set_disabled", disabled: !u.disabled })}>
                              {u.disabled ? "Enable" : "Disable"}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card aria-label="Audit trail">
            <CardHeader>
              <CardTitle>Audit trail</CardTitle>
              <CardDescription>Append-only: who granted whom which role, and when. It cannot be edited or deleted.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {state.events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">{WHEN.format(e.at)}</span>
                    <span>{eventText(e)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
