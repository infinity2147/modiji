"use client";

import { useSearchParams } from "next/navigation";
import { parseSessionParams } from "@/lib/client/session-url";
import { Launcher } from "./launcher";
import { TopBar } from "./top-bar";
import { Workspace } from "./workspace";

/** `/sandbox`: the launcher, or the session named in the URL (a reload resumes it). */
export function CaseDesk() {
  const ref = parseSessionParams(useSearchParams());
  const session = ref === "invalid" ? undefined : ref;
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <TopBar session={session} />
      {session ? (
        <Workspace key={session.sessionId} session={session} />
      ) : (
        <Launcher notice={ref === "invalid" ? "The session link is malformed. Start a new session." : undefined} />
      )}
    </div>
  );
}
