"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clapperboard, Home, LogOut, Lock, Mic, Play, Scale, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { ROLE_LABELS } from "@/lib/auth/policy";
import { ROLE_NAV, activeKey, type NavIcon } from "@/lib/auth/nav";
import type { Viewer } from "@/lib/contracts/auth";
import { signOut } from "@/lib/client/auth";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = { home: Home, play: Play, mic: Mic, people: Users, shield: ShieldCheck, film: Clapperboard, scale: Scale };

export function Logo({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 font-heading text-xl font-bold tracking-tight">
      <svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true">
        <rect width="40" height="40" rx="12" fill={onDark ? "#14777A" : "var(--primary)"} />
        <path d="M12 13h16M12 20h10M12 27h16" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <circle cx="29" cy="20" r="3.5" fill="var(--highlight)" />
      </svg>
      Vashistha
    </span>
  );
}

/** The role-aware sidebar: the viewer's own links, what is locked and why, and who is signed in. */
export function SidebarNav({ viewer, badges }: { viewer: Viewer; badges?: Record<string, number> }) {
  const pathname = usePathname();
  const nav = ROLE_NAV[viewer.role];
  const active = activeKey(viewer.role, pathname);
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 border-b bg-sidebar p-4 md:sticky md:top-0 md:h-dvh md:w-64 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0">
      <Link href="/home" className="px-2 pt-1 pb-5" aria-label="Vashistha home">
        <Logo />
      </Link>
      {nav.sections.map((section) => (
        <div key={section.title} className="flex flex-col gap-1 pb-2">
          <span className="px-3 py-1.5 text-[11px] font-bold tracking-widest text-muted-foreground uppercase">{section.title}</span>
          {section.items.map((item) => {
            const Icon = ICONS[item.icon];
            const on = item.key === active;
            const count = badges?.[item.key] ?? 0;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold transition-colors",
                  on ? "bg-primary text-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-[18px]" aria-hidden />
                {item.label}
                {count > 0 && <span className="ml-auto rounded-full bg-highlight px-2 py-0.5 text-[11px] font-bold text-highlight-foreground">{count}</span>}
              </Link>
            );
          })}
        </div>
      ))}
      {nav.locked.length > 0 && (
        <div className="flex flex-col gap-1 pb-2">
          <span className="px-3 py-1.5 text-[11px] font-bold tracking-widest text-muted-foreground uppercase">Locked</span>
          {nav.locked.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <span key={item.label} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-semibold text-muted-foreground/80">
                <Icon className="size-[18px]" aria-hidden />
                <span className="grid">
                  {item.label}
                  <span className="text-[11px] font-medium">{item.reason}</span>
                </span>
                <Lock className="ml-auto size-3.5" aria-hidden />
              </span>
            );
          })}
        </div>
      )}
      <div className="mt-auto flex items-center gap-3 border-t pt-4">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-primary font-bold text-primary-foreground">
          {viewer.displayName.slice(0, 1).toUpperCase()}
        </span>
        <p aria-label="Signed in as" className="grid min-w-0 text-sm leading-tight">
          <strong className="truncate">{viewer.displayName}</strong>
          <span className="text-xs text-muted-foreground">{ROLE_LABELS[viewer.role]}</span>
        </p>
        <button
          type="button"
          className="ml-auto grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Sign out"
          onClick={() => void signOut((input, init) => fetch(input, init)).finally(() => window.location.assign("/login"))}
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </nav>
  );
}
