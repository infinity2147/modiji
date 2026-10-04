import { bearer, httpRequest, joinUrl, parseJsonObject, requireVars } from "../http";
import { httpTarget } from "../target";
import type { CheckOutcome, Facts, PreflightContext } from "../types";

type Ctx = Pick<PreflightContext, "env" | "target" | "fetch" | "now" | "options">;

const DEEP_PARTS = ["db", "dataDir", "z3"] as const;

/**
 * `/api/health` is up, `/api/health/deep` refuses an anonymous caller, and with the bearer reports the database
 * writable, DATA_DIR writable and Z3 initialised (plan §12), and model calls on: a target running with the hermetic
 * `LLM_CALLS=off` (e2e setting) would never call the model, so it fails here, where the deployed env is observable.
 */
export async function checkServerDeep(ctx: Ctx): Promise<CheckOutcome> {
  const { CUSTOM_LLM_SECRET: secret } = requireVars(ctx.env, ["CUSTOM_LLM_SECRET"]);
  const target = httpTarget(ctx.target);
  if (!target.ok) return { status: "fail", detail: target.error };
  const problems: string[] = [];
  const facts: Facts = {};

  const health = await httpRequest(ctx, joinUrl(target.baseUrl, "/api/health"));
  const healthBody = parseJsonObject(health.text);
  if (health.status !== 200 || healthBody?.ok !== true) problems.push(`/api/health: HTTP ${health.status}, ok=${String(healthBody?.ok)}`);
  if (typeof healthBody?.version === "string") facts.version = healthBody.version;
  if (typeof healthBody?.uptimeS === "number") facts.uptimeS = healthBody.uptimeS;

  const anonymous = await httpRequest(ctx, joinUrl(target.baseUrl, "/api/health/deep"));
  if (anonymous.status !== 401) problems.push(`/api/health/deep without bearer: expected HTTP 401, got ${anonymous.status}`);

  const deep = await httpRequest(ctx, joinUrl(target.baseUrl, "/api/health/deep"), { headers: bearer(secret) });
  const body = parseJsonObject(deep.text);
  if (body === null) {
    problems.push(`/api/health/deep: HTTP ${deep.status}, body is not JSON`);
  } else {
    for (const part of DEEP_PARTS) {
      const value = body[part];
      const result = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      const ms = typeof result?.ms === "number" ? Math.round(result.ms * 10) / 10 : null;
      facts[part] = { ok: result?.ok === true, ms };
      if (result?.ok !== true) {
        const error = typeof result?.error === "string" ? `: ${result.error.slice(0, 200)}` : "";
        problems.push(`${part} not ok${error}`);
      }
    }
    if (body.ok !== true && problems.length === 0) problems.push(`/api/health/deep: ok=${String(body.ok)} (HTTP ${deep.status})`);
    const llmCalls = body.llmCalls === "on" || body.llmCalls === "off" ? body.llmCalls : null;
    facts.llmCalls = llmCalls;
    if (llmCalls === "off") problems.push("target runs with LLM_CALLS=off: model calls disabled");
    else if (llmCalls === null) problems.push("/api/health/deep does not report llmCalls (server older than this preflight?)");
  }
  facts.deepMs = deep.ms;

  if (problems.length > 0) return { status: "fail", detail: problems.join("; "), facts };
  const parts = DEEP_PARTS.map((p) => {
    const f = facts[p];
    const ms = f !== null && typeof f === "object" && !Array.isArray(f) ? f.ms : null;
    return `${p} ok${typeof ms === "number" ? ` ${ms} ms` : ""}`;
  });
  return { status: "pass", detail: `health 200; deep 401 without bearer; ${parts.join(", ")}; model calls on`, facts };
}

/** The CaseDesk sandbox page renders. */
export async function checkSandbox(ctx: Omit<Ctx, "env">): Promise<CheckOutcome> {
  const target = httpTarget(ctx.target);
  if (!target.ok) return { status: "fail", detail: target.error };
  const r = await httpRequest(ctx, joinUrl(target.baseUrl, "/sandbox"));
  const facts: Facts = { status: r.status, bytes: r.text.length, ms: r.ms };
  const problems: string[] = [];
  if (r.status !== 200) problems.push(`HTTP ${r.status}`);
  if (!r.contentType.startsWith("text/html")) problems.push(`content-type ${r.contentType || "missing"}, expected text/html`);
  if (!r.text.includes("CaseDesk")) problems.push(`page does not contain "CaseDesk"`);
  if (problems.length > 0) return { status: "fail", detail: `/sandbox: ${problems.join("; ")}`, facts };
  return { status: "pass", detail: `/sandbox 200 text/html with "CaseDesk" (${r.ms} ms)`, facts };
}
