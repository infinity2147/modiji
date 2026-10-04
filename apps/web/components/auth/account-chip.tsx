"use client";

import Link from "next/link";
import { LogOut, Users } from "lucide-react";
import { ROLE_LABELS } from "@/lib/auth/policy";
import type { Viewer } from "@/lib/contracts/auth";
import { signOut } from "@/lib/client/auth";
import { Button } from "@/components/ui/button";

/** Who is signed in, in the CaseDesk header: name, role, the admin's Accounts page, sign out. */
export function AccountChip({ viewer }: { viewer: Viewer }) {
  return (
    <div className="flex items-center gap-1.5">
      <p aria-label="Signed in as" className="flex items-center gap-1.5 whitespace-nowrap text-slate-700">
        <span className="max-w-40 truncate font-medium">{viewer.displayName}</span>
        <span className="text-xs font-normal text-slate-500">{ROLE_LABELS[viewer.role]}</span>
      </p>
      {viewer.role === "admin" && (
        <Button asChild size="sm" variant="ghost" className="text-slate-500 hover:bg-slate-100 hover:text-slate-900">
          <Link href="/admin">
            <Users data-icon="inline-start" />
            Accounts
          </Link>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        onClick={() => void signOut((input, init) => fetch(input, init)).finally(() => window.location.assign("/login"))}
      >
        <LogOut data-icon="inline-start" />
        Sign out
      </Button>
    </div>
  );
}
