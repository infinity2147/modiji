/**
 * HTTP handlers of the two-experts routes (contract: lib/contracts/disagreements.ts). Route files only
 * adapt Next's signature and pass `disagreementDeps()`.
 */
import "server-only";
import type { z } from "zod";
import { ExpertIdSchema, SymbolIdSchema } from "@vashistha/core";
import {
  AnswerDisagreementRequestSchema,
  SearchDisagreementsRequestSchema,
  type AnswerDisagreementResponseSchema,
  type SearchDisagreementsResponseSchema,
} from "../../contracts/disagreements";
import { ApiFailure, json, parseOr400, readJson, respond } from "../casedesk/http";
import type { DisagreementDeps } from "./deps";
import { answerDisagreement, disagreementsState, searchDisagreements, type PairRequest } from "./service";

/** `?experts=a,b&family=f` (both or neither). */
function pairQuery(request: Request): PairRequest | undefined {
  const params = new URL(request.url).searchParams;
  const experts = params.get("experts");
  const family = params.get("family");
  if (experts === null && family === null) return undefined;
  const ids = (experts ?? "").split(",").map((id) => parseOr400(ExpertIdSchema, id, "invalid_request"));
  const [a, b] = ids;
  if (ids.length !== 2 || a === undefined || b === undefined || a === b) throw new ApiFailure(400, "invalid_request", "experts=<a>,<b> names two different experts");
  return { experts: [a, b], decisionFamily: parseOr400(SymbolIdSchema, family ?? "reviewOutcome", "invalid_request") };
}

/** GET /api/disagreements[?experts=a,b&family=f] — the expert directory, and the pair's reconciliation state. Never writes. */
export function handleGetDisagreements(request: Request, deps: DisagreementDeps): Promise<Response> {
  return respond(deps.log, () => json(disagreementsState(deps, pairQuery(request))));
}

/** POST /api/disagreements — Z3 search over the two experts' rulebooks, record and ask, resolve agreed answers. */
export function handleSearchDisagreements(request: Request, deps: DisagreementDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const req = await readJson(request, SearchDisagreementsRequestSchema);
    const { written } = await searchDisagreements(deps, req);
    const body: z.infer<typeof SearchDisagreementsResponseSchema> = { written, state: disagreementsState(deps, req) };
    return json(body);
  });
}

/** POST /api/disagreements/answer — one expert's typed decision on a disagreement case. */
export function handleAnswerDisagreement(request: Request, deps: DisagreementDeps): Promise<Response> {
  return respond(deps.log, async () => {
    const req = await readJson(request, AnswerDisagreementRequestSchema);
    const result = await answerDisagreement(deps, req);
    const body: z.infer<typeof AnswerDisagreementResponseSchema> = { ...result, state: disagreementsState(deps, req) };
    return json(body);
  });
}
