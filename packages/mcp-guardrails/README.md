# @vashistha/mcp-guardrails

The confirmed rulebook for agents (plan §7.6, §7.9): the MCP tool `check_action` over Streamable HTTP
(stateless, JSON responses), plus Work Map JSON and ElevenLabs Procedure exports. Decisions come from
`checkAction` in `@vashistha/core`, the function the tutor's Save interlock calls. No model is involved.

## Mount at `/mcp` in apps/web/server.ts

Add `"@vashistha/mcp-guardrails": "workspace:*"` to apps/web; then, after `createRuntime(...)`:

```ts
import { KYC_DOMAIN } from "@vashistha/core/domains/kyc";
import { createGuardrailMcpServer, createMcpHttpHandler } from "@vashistha/mcp-guardrails";

const token = process.env.MCP_BEARER_TOKEN; // optional; when set, clients send `Authorization: Bearer <token>`
const mcp = createMcpHttpHandler(
  // Revision 0 until the rulebook store exposes one (P5).
  () => createGuardrailMcpServer({ domain: KYC_DOMAIN, rulebook: () => ({ rules: runtime.rulebook(), revision: 0 }) }),
  token ? { bearerToken: token } : {},
);
// In httpServer.on("request"), replace `handle(req, res).catch(...)` with:
const isMcp = new URL(req.url ?? "/", "http://localhost").pathname === "/mcp";
(isMcp ? mcp(req, res) : handle(req, res)).catch(/* the existing error handler */);
```

## Demo (P8: the agent is blocked with the expert's quote)

```sh
pnpm --filter @vashistha/web exec tsx ../../packages/mcp-guardrails/demo/serve.ts   # local server, synthetic rulebook
pnpm --filter @vashistha/web exec tsx ../../packages/mcp-guardrails/demo/agent-blocked.ts --url http://127.0.0.1:4318
```

`agent-blocked.ts` needs `ANTHROPIC_API_KEY` (`--scripted`: same MCP calls, no model). For the deployed app use
`--url https://<deployment>`, and set `MCP_BEARER_TOKEN` if the server requires it.

## Exports
- `exportWorkMapJson` / `importWorkMapJson`: canonical JSON (sorted keys), validated against `WorkMapSchema`.
- `compileProcedure` / `parseProcedure`: Markdown with *when / then / why* per rule, under 50,000 characters.
  It embeds a JSON copy of the rules, and `parseProcedure` reads them back for the round-trip check.
- `publishProcedure` with `createElevenLabsProcedureApi`: create, then write the draft, then publish the branch (api-notes §6).
