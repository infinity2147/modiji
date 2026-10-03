import { AGENT_ID_ENV, AGENT_ROLES } from "../../../packages/core/src/server/elevenlabs-agents";
import { describeError, httpRequest, joinUrl, parseJsonObject, requireVars } from "../http";
import { httpTarget } from "../target";
import type { CheckOutcome, Facts, PreflightContext } from "../types";

/**
 * Conversation tokens mint server-side for both agents (proves key + agent ids), and the deployed public endpoint
 * `GET /api/voice/token?agent=interviewer` mints one too (proves the browser path). Tokens are registered as secrets
 * and never reported; conversation ids are (they identify the stored transcript, not a credential).
 */
export async function checkToken(
  ctx: Pick<PreflightContext, "env" | "target" | "createElevenLabs" | "secrets" | "fetch" | "now" | "options">,
): Promise<CheckOutcome> {
  const vars = requireVars(ctx.env, ["ELEVENLABS_API_KEY", ...Object.values(AGENT_ID_ENV)]);
  const client = ctx.createElevenLabs(vars.ELEVENLABS_API_KEY);
  const problems: string[] = [];
  const facts: Facts = {};
  const lines: string[] = [];

  const minted = await Promise.all(
    AGENT_ROLES.map(async (role) => {
      const started = ctx.now();
      try {
        const { token, conversationId } = await client.getConversationToken(vars[AGENT_ID_ENV[role]]);
        ctx.secrets.add(token);
        return { role, ok: true as const, conversationId, ms: Math.round(ctx.now() - started) };
      } catch (error) {
        return { role, ok: false as const, error: describeError(error) };
      }
    }),
  );
  for (const m of minted) {
    if (m.ok) {
      facts[m.role] = { conversationId: m.conversationId, ms: m.ms };
      lines.push(`${m.role} token ${m.ms} ms`);
    } else {
      problems.push(`${m.role}: ${m.error}`);
    }
  }

  const target = httpTarget(ctx.target);
  if (!target.ok) {
    problems.push(`public endpoint: ${target.error}`);
  } else {
    try {
      const r = await httpRequest(ctx, joinUrl(target.baseUrl, "/api/voice/token?agent=interviewer"));
      const body = parseJsonObject(r.text);
      if (typeof body?.token === "string") ctx.secrets.add(body.token);
      if (r.status !== 200) {
        const error = typeof body?.error === "string" ? ` (${body.error})` : "";
        problems.push(`GET /api/voice/token?agent=interviewer returned HTTP ${r.status}${error}`);
      } else if (typeof body?.token !== "string" || body.token === "" || typeof body.conversationId !== "string") {
        problems.push("GET /api/voice/token?agent=interviewer: body is not { token, conversationId }");
      } else {
        facts.public = { conversationId: body.conversationId, ms: r.ms };
        lines.push(`public /api/voice/token ${r.ms} ms`);
      }
    } catch (error) {
      problems.push(`public endpoint: ${describeError(error)}`);
    }
  }
  if (problems.length > 0) return { status: "fail", detail: [...problems, ...lines].join("; "), facts };
  return { status: "pass", detail: lines.join("; "), facts };
}
