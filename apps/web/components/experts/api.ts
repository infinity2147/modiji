/** Typed client for the two-experts routes; every body is validated with the contract. */
import { postJson, requestJson, type FetchFn } from "@/lib/client/api";
import {
  AnswerDisagreementResponseSchema,
  DisagreementsStateSchema,
  SearchDisagreementsResponseSchema,
} from "@/lib/contracts/disagreements";

export type PairQuery = { experts: [string, string]; decisionFamily: string };

export const getDisagreements = (f: FetchFn, pair: PairQuery | undefined) =>
  requestJson(
    f,
    pair === undefined
      ? "/api/disagreements"
      : `/api/disagreements?${new URLSearchParams({ experts: pair.experts.join(","), family: pair.decisionFamily }).toString()}`,
    DisagreementsStateSchema,
  );

export const searchDisagreements = (f: FetchFn, pair: PairQuery) => requestJson(f, "/api/disagreements", SearchDisagreementsResponseSchema, postJson(pair));

export const answerDisagreement = (f: FetchFn, pair: PairQuery, body: { witnessId: string; expertId: string; decision: string; quote: string }) =>
  requestJson(f, "/api/disagreements/answer", AnswerDisagreementResponseSchema, postJson({ ...pair, ...body }));
