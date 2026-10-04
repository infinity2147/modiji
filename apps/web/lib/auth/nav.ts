/**
 * The sidebar, per role (browser-safe). A role sees only what it can use; what it cannot is listed
 * once under "Locked" with the reason, so nobody wonders where a feature went.
 */
import type { UserRole } from "@vashistha/core";

export type NavIcon = "home" | "play" | "mic" | "people" | "shield" | "film" | "scale";

export type NavItem = { key: string; label: string; href: string; icon: NavIcon };
export type LockedItem = { label: string; reason: string; icon: NavIcon };
export type NavSection = { title: string; items: NavItem[] };

export type RoleNav = { sections: NavSection[]; locked: LockedItem[] };

const HOME: NavItem = { key: "home", label: "Home", href: "/home", icon: "home" };
const REPLAYS: NavItem = { key: "replay", label: "Recorded runs", href: "/replay", icon: "film" };

export const ROLE_NAV: Readonly<Record<UserRole, RoleNav>> = {
  trainee: {
    sections: [{ title: "Learn", items: [HOME, { key: "practice", label: "Practice", href: "/sandbox", icon: "play" }, REPLAYS] }],
    locked: [{ label: "Expert capture", reason: "Needs the expert role", icon: "mic" }],
  },
  expert: {
    sections: [
      { title: "Your work", items: [HOME, { key: "capture", label: "Capture", href: "/sandbox", icon: "mic" }, { key: "experts", label: "Two experts", href: "/experts", icon: "scale" }, REPLAYS] },
    ],
    locked: [],
  },
  admin: {
    sections: [
      { title: "Admin", items: [HOME, { key: "admin", label: "Accounts", href: "/admin", icon: "shield" }] },
      { title: "Review", items: [{ key: "sandbox", label: "Try the tutor", href: "/sandbox", icon: "play" }, { key: "experts", label: "Two experts", href: "/experts", icon: "scale" }, REPLAYS] },
    ],
    locked: [],
  },
};

/** The nav item whose page the path belongs to (the longest matching href), else none. */
export function activeKey(role: UserRole, pathname: string): string | undefined {
  const items = ROLE_NAV[role].sections.flatMap((s) => s.items);
  const hit = items.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.key;
}
