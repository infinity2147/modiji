"use client";

import Link from "next/link";
import { LogOut, Users } from "lucide-react";
import { ROLE_LABELS } from "@/lib/auth/policy";
import type { Viewer } from "@/lib/contracts/auth";
import { signOut } from "@/lib/client/auth";
import { Button } from "@/components/ui/button";

/** Who is signed in, on the dark CaseDesk bar: name, role, the admin's Accounts page, sign out. */
export function AccountChip({ viewer }: { viewer: Viewer }) {
  return (
    <div className="flex items-center gap-1.5">
      <p aria-label="Signed in as" className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 whitespace-nowrap text-slate-200">
        <span className="max-w-40 truncate font-medium">{viewer.displayName}</span>
        <span className="rounded bg-slate-700 px-1 py-px text-[10px] font-semibold tracking-wide text-slate-100 uppercase">{ROLE_LABELS[viewer.role]}</span>
      </p>
      {viewer.role === "admin" && (
        <Button asChild size="sm" variant="ghost" className="text-slate-300 hover:bg-slate-800 hover:text-white">
          <Link href="/admin">
            <Users data-icon="inline-start" />
            Accounts
          </Link>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-slate-300 hover:bg-slate-800 hover:text-white"
        onClick={() => void signOut((input, init) => fetch(input, init)).finally(() => window.location.assign("/login"))}
      >
        <LogOut data-icon="inline-start" />
        Sign out
      </Button>
    </div>
  );
}
