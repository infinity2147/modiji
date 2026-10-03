# PROGRESS

Phase log for Vashistha (codename). Spec: `plan.md` v2. Decisions D0–D6 are fixed by the team (bootstrap prompt, 4 Oct 2026).

---

## P0a — local foundation (decision-independent)

**Started:** 2026-10-04

**Goal.** A pnpm TypeScript-strict monorepo with the shared types and zod schemas from `plan.md` §6, an append-only provenance ledger on SQLite/Drizzle, env validation, a domain-config parser, the three-valued (Kleene) predicate evaluator, a minimal Next.js app with a custom Node server, and a test that fails if a hidden-policy oracle appears in any client bundle.

**Files.**
- Root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.env.example`, `.gitignore`.
- `packages/core/src/schemas/*`: shared types and zod schemas (primitives, predicate, domain, ledger, signals, context, rules, guardrail, gate).
- `packages/core/src/logic/*`: Kleene connectives, `evaluatePredicate`, `contextLookup`, `typecheckPredicate`.
- `packages/core/src/domain/*`: `parseDomainConfig` / `loadDomainConfig`.
- `packages/core/src/server/*`: Drizzle schema and migrations (append-only triggers), `openDatabase`, `createLedger`, `loadServerEnv`.
- `apps/web/*`: Next.js App Router + Tailwind v4, custom server (`server.ts`), `/api/health`, oracle-leak scanner and tests.

**Acceptance (plan §11, P0a).**
- `pnpm test` green.
- Evaluator truth tables pass: exhaustive and/or/not over {true,false,unknown}, plus property tests for JSON-Logic compatibility (json-logic-js agrees when everything is known) and Kleene soundness (a boolean result never changes when unknowns are filled in).
- The oracle-not-in-client-bundle test exists, and it is proven by a negative control (a deliberately leaking fixture bundle is detected).

### P0a results (2026-10-04)

**Status: acceptance met.**

- `pnpm check` (typecheck → lint → test → production build + bundle leak scan): exit 0 in 44 s. Log: `docs/evidence/p0a-check.log`.
- `pnpm test`: **243/243 passed** across 11 files.

  | Area | File | Tests |
  |---|---|---|
  | Schemas | schemas | 21 |
  | Kleene connectives | kleene | 47 |
  | Evaluator | evaluate | 45 |
  | Properties | logic.property | 2 (×400 seeded runs) |
  | Typecheck | typecheck | 12 |
  | Context lookup | context | 4 |
  | Domain parser | domain | 17 |
  | Env | env | 27 |
  | Ledger | ledger | 37 |
  | Ledger (DB) | ledger.db | 10 |
  | Oracle-leak unit | oracle-leak.unit | 21 |

- **Evaluator truth tables:** and/or over all 9 pairs of {true, false, unknown}, not over all 3, and n-ary associativity and commutativity over all triples. The same tables are reproduced through `evaluatePredicate`.
  - **Property test, JSON-Logic compatibility:** json-logic-js agrees on fully known contexts.
  - **Property test, Kleene soundness:** a boolean result never changes when unknowns are filled in. Supplying the reported `unknownFeatures` always yields a boolean.
  - Both properties use seed 20261004 and 400 runs each.
- **Oracle-not-in-client-bundle:** the test exists and is proven by controls.
  - An esbuild bundle that imports a fixture oracle **is detected**, and a clean bundle is not.
  - `pnpm test:bundle` scans `.next/static` plus the browser-facing RSC, HTML and client-manifest files after a real `next build`: 3/3 passed.
  - A manual probe showed two layers of protection. A server component that rendered an oracle made the scan fail. A `"use client"` import of an oracle made `next build` fail via `server-only`.
- **Ledger:** append-only is enforced by SQLite triggers on entries and edges. Sequences are gap-free per session, including across two connections. Parents must exist. Capture sources are rejected when the epoch is stale or the session is off the record. `setOffRecord` advances the epoch and writes a `system_control` entry. `evidence()` never returns `system_control`. Lineage walks use recursive CTEs.
- **Env:** errors list variable names only, never values (tested with a fake secret).

**How to see it.**
- `pnpm check`
- `pnpm --filter @vashistha/web build && cd apps/web && NODE_ENV=production PORT=3000 npx tsx server.ts`, then `curl localhost:3000/api/health`

**Open issues.**
1. `CHANGES.md`, referenced by the bootstrap prompt, is not in the repo.
2. The bundle scan passes trivially until the KYC oracle lands in P1 (no real `*.oracle.server.ts` yet). The controls above prove that the detector works.
3. The model-prompt half of the oracle guard (`findMarkersInText`) gets wired into the Anthropic client wrapper in P0b.
4. Context values are not yet validated against feature types. Ingestion (P1/P2) must validate them or map them to `Unknown`. LLM-proposed predicates must pass `typecheckPredicate` (P4).
5. `openDatabase` resolves migrations relative to its own module, so it must run where it isn't bundled by Next. Handled in P0b.
6. `claude-haiku-4-5-20251001` has an earliest retirement date of 15 Oct 2026 (see `docs/api-notes.md` §10).
