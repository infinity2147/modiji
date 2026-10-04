/**
 * The signed-in account, for server components (pages). The front door (`server.ts`) has already sent
 * anyone without a sign-in on a protected page to /login; pages use this to render for the viewer.
 */
import "server-only";
import { cookies } from "next/headers";
import type { Viewer } from "../../contracts/auth";
import { sessionInfo } from "../casedesk/session";
import { getRuntime } from "../runtime";
import { sessionRefusal } from "./access";
import { viewerOf } from "./handlers";
import { SESSION_COOKIE } from "./principal";

export async function currentViewer(): Promise<Viewer | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const account = token === undefined ? undefined : getRuntime().accounts.resolve(token, Date.now());
  return account && viewerOf(account);
}

/**
 * Why the viewer may not WRITE to CaseDesk session `sessionId` (undefined when they may, or when the
 * session does not exist: its page then shows the API's own 404). A page renders read-only on a refusal.
 */
export async function sessionWriteRefusal(sessionId: string): Promise<string | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const runtime = getRuntime();
  const account = token === undefined ? undefined : runtime.accounts.resolve(token, Date.now());
  if (account === undefined) return "sign in first";
  const info = sessionInfo(runtime.ledger, runtime.casedesk, sessionId);
  return info && sessionRefusal({ kind: "user", account }, info, "write");
}
