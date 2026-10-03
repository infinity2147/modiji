/** A scripted `fetch` for client-module tests: records requests, answers from a queue or a handler. */
import type { FetchFn } from "../../lib/client/api";

export type RecordedRequest = { url: string; method: string; body: unknown };

export type Deferred = { resolve: (response: Response) => void; reject: (error: unknown) => void };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Every call stays pending until the test settles it, so in-flight behaviour can be observed. */
export function controlledFetch() {
  const requests: RecordedRequest[] = [];
  const pending: Deferred[] = [];
  const fetch: FetchFn = (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined });
    return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
  };
  const next = (): Deferred => {
    const deferred = pending.shift();
    if (!deferred) throw new Error("no pending request");
    return deferred;
  };
  return { fetch, requests, pending, next };
}

/** Answers each request with `handler(url, body)`. */
export function scriptedFetch(handler: (url: string, body: unknown) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchFn = async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    requests.push({ url, method: init?.method ?? "GET", body });
    return handler(url, body);
  };
  return { fetch, requests };
}

/** Lets pending promise chains (including Response body reads) settle. */
export async function tick(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
