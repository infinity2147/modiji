import { getRuntime } from "../runtime";
import type { AdminDeps, AuthDeps } from "./handlers";

export function authDeps(): AuthDeps {
  const { accounts, authLimits } = getRuntime();
  return { accounts, limits: authLimits, now: Date.now, log: console };
}

export function adminDeps(): AdminDeps {
  const { experts } = getRuntime();
  return { ...authDeps(), expertSessions: (expertId) => experts.directory().find((e) => e.id === expertId)?.sessionIds.length ?? 0 };
}
