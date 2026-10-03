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

---

## P0b — integration

**Started:** 2026-10-04

**Goal.** One persistent Node service deployable to Railway (D5) with a volume, containing:
- ElevenLabs agents created and updated only by `scripts/agents.ts` from versioned JSON in `/agents`.
- A server-minted WebRTC conversation token endpoint.
- An OpenAI-compatible SSE custom-LLM endpoint (D2 option A) that returns `skip_turn` unless a valid `GateAuthorization` nonce is present.
- `pnpm preflight` covering every check in plan §12.

API facts come from `docs/api-notes.md`, not `plan.md` §15.

**Files.**
- `packages/core/src/server/elevenlabs*.ts`: typed raw-REST client and agent-invariant checks.
- `packages/core/src/server/claude.ts`: Anthropic wrapper with structured output, prompt caching and the oracle prompt guard.
- `packages/core/src/oracle-guard.ts`
- `packages/solver/`: Z3 init and self-test.
- `agents/interviewer.json`, `agents/tutor.json`, `scripts/agents.ts`
- `apps/web/lib/server/*`: runtime composition root, authorization store, custom-LLM handler.
- `apps/web/app/api/{llm/chat/completions,voice/token,preflight/authorize,health/deep}`
- `apps/web/app/sandbox`
- `Dockerfile`, `.railway/railway.ts` (Railway IaC; `railway.json` is deprecated for new services, see `docs/api-notes.md` §13), `docs/deploy.md`
- `scripts/preflight.ts`

**Acceptance (plan §11–12).** `pnpm preflight` is all green against the deployed public URL:
- Anthropic call with structured output.
- ElevenLabs agents exist with the invariant config.
- Conversation token minted.
- Custom-LLM URL reachable from the public internet.
- `skip_turn` honoured end to end through ElevenLabs: no agent speech on an unauthorised turn, and speech plus TTS audio on an authorised one.
- DB and `DATA_DIR` writable.
- Z3 initialises.
- Sandbox route up.
- Mic/screen permission checklist printed.

### P0b results (2026-10-04)

**Status: acceptance MET** — see the live preflight update after the open issues below. The text immediately below is the earlier, pre-credentials state.

**Earlier state: code complete and green locally. Acceptance NOT yet met.** `pnpm preflight` against the deployed URL needs `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and Railway access, and none exist on this machine. Nothing below was moved to make it pass.

**Measured.**
- `pnpm check`: exit 0 in 34 s; log in `docs/evidence/p0b-check.log`.
  - Typecheck covers root scripts/IaC, core, solver and web.
  - Lint is clean.
  - **513/513 tests** in 28 files, then a production build and bundle leak scan, 3/3.
- **Custom-LLM wrapper invariant** (`apps/web/lib/server/custom-llm.ts`): a turn speaks only when its last message is exactly a control message. The nonce must be valid, unexpired and unused, and match the agent, session and context version. Every other turn streams `skip_turn`.
  - Every skip reason has its own test.
  - A property test (fast-check, seed 20261004, 400 runs) checks safety: content appears only for a valid unspent nonce, and only its text. It also checks liveness: a valid first try, or a retry after an aborted stream, speaks once and then skips.
  - Mutation check: the agent broke each guard one at a time (context, expiry, replay, agent, release, complete, in-flight, plus "completion treated as abort"), and the suite failed every time.
- **Nonce lifecycle:** issued → in_flight → used. A stream aborted before `[DONE]` releases the nonce, because ElevenLabs retries the same custom LLM on errors (api-notes §12).
- **Ledger:** control messages are written as `system_control` / `gate.control_message`, storing only a nonce digest. Decisions are written as `engine` / `llm.turn_decision`, with the control entry as parent. `evidence()` excludes control entries (tested).
- **Bundle isolation:** route bundles contain no `z3-solver`, `drizzle-orm`, `better-sqlite3` or `@anthropic-ai` (grep of `.next/server` and `.next/static`). The composition root runs unbundled in `server.ts`.
- **Local production run** (`docs/evidence/preflight-2026-10-03T20-07-21.664Z.json`): `pnpm preflight --target http://127.0.0.1:4317 --only public-llm,server-deep,sandbox` was GREEN, 3/3.
  - **public-llm:** 401 without or with a wrong bearer. Unauthorised → `skip_turn` in 18 ms. Authorised → exact text, first chunk in 16 ms. Replay → `skip_turn` (`already_used`).
  - **server-deep:** DB ok in 0.8 ms, DATA_DIR ok in 24.9 ms, Z3 ok in 58.2 ms.
  - **sandbox:** 200.
  - The voice check correctly refuses a non-public target (`docs/evidence/preflight-2026-10-03T20-07-28.348Z.json`).
- **Z3** (z3-solver 5.2.0): cold init plus self-test 328 ms, warm 26 ms.
- **Agent sync:** `pnpm agents:sync --dry-run` renders both agents fully offline. Safety settings are checked as read-back invariants:
  - `first_message: ""`
  - `skip_turn` `pre_tool_speech: "off"`
  - soft timeout off
  - backup LLM disabled
  - client overrides for first message and LLM off
  - private agent (token auth)
  - retention 30 days

**How to see it.**
- `pnpm check`
- `pnpm agents:sync --dry-run` (needs `ELEVENLABS_API_KEY`, `CUSTOM_LLM_SECRET` and an https `PUBLIC_BASE_URL` in `.env`)
- Local server: build, then `cd apps/web && NODE_ENV=production … npx tsx server.ts`, then `pnpm preflight --target http://127.0.0.1:<port> --only public-llm,server-deep,sandbox`
- Deploy steps: `docs/deploy.md`

**Open issues / decisions needed.**
1. **Blocked: credentials and deployment.** Needed: the two API keys and Railway access (`pnpm exec railway login` by a team member, or a Railway account token). Then follow `docs/deploy.md` to deploy, run `agents:sync`, and run `pnpm preflight` against the public URL.
2. **Live-only unknowns that the voice preflight settles:**
   - the bearer header ElevenLabs sends;
   - whether ElevenLabs accepts our streamed `skip_turn` and stays silent;
   - how `pre_tool_speech` interacts with `skip_turn`;
   - whether `sessionId` arrives via `elevenlabs_extra_body` on every turn;
   - whether expressive v3 alters `agent_response` text.
3. **Default voice `cjVigY5qzO86Huf0OWal`:** default voices exist only for ElevenLabs accounts created before March 2026, and expire on 31 Dec 2026. Sync validates it; if it's missing, the team picks a voice.
4. **Railway:** `railway.json` is deprecated for new services, so the service is defined in `.railway/railway.ts`. The `railway` SDK and `@railway/cli` were added as root dev dependencies. The file typechecks but has not been planned live yet.
5. **Unverified until a real build runs:** the Docker image (no Docker here), and the `setpriv` drop to the `node` user on a root-owned Railway volume.
6. **Haiku 4.5 retirement:** not sooner than 15 Oct 2026 (carried from P0a).
7. **`CHANGES.md` is still missing.**

**Live preflight update (after credentials were provided).**
- `pnpm preflight` against `https://vashistha-production.up.railway.app` is **GREEN, 8/8** (`docs/evidence/preflight-2026-10-03T21-51-17.182Z.json`):

  | Check | Result |
  |---|---|
  | env | pass |
  | anthropic | Haiku structured 1.7 s; Sonnet 1.5 s; Opus 1.8 s |
  | agents | invariants hold, spec matches, secret current |
  | token | API 0.46 s; public endpoint 0.75 s |
  | public-llm | 401 ×2, `skip_turn`, exact text, replay refused |
  | **voice-skip-turn** | **silent for 8 s on an unauthorised turn; authorised text spoken, first audio 619 ms** |
  | server-deep | db, dataDir and Z3 ok |
  | sandbox | 200 |

- **What was deployed.** Branch `deploy/p0b`: commit `dd93502` (P0b + P1 + core packages) plus removal of the Railway CLI dependency. An earlier failed deploy had uploaded a working tree with in-progress files.
  - **Rule:** deploy only from a clean, committed snapshot that builds.
- **Open issues resolved.**
  - Issue 2's live unknowns are resolved; see `docs/api-notes.md` §15.
  - Issue 5: the Docker build, run, and `setpriv` drop on the root-owned volume are verified on Railway.

---

## P1 — CaseDesk

**Started:** 2026-10-04

**Goal.** Build the domain-pluggable back-office sandbox at `/sandbox` on the D1 domain, "Northstar Bank Synthetic Review Policy" (synthetic KYC: fictional bank, jurisdictions and thresholds).
- **Domain split:** a browser-safe public config, plus a hidden-policy oracle that is server- and bench-only.
- **Cases:** a deterministic case generator with the demo sets (training, held-out) and bench cases.
- **DOM channel:** labelled `source: "dom"` screen events go to the ledger.
- **Save interlock:** Save is wired to a deterministic `checkAction` over the confirmed rulebook. The rulebook is empty until P5, but the evaluation is real code, not a stub.

**Files.**
- `packages/core/src/domains/kyc/`: `domain.public.ts`, `case.ts`, generator and demo sets, `domain.oracle.server.ts`.
- `packages/core/src/rules/check-action.ts` and `packages/core/src/domain/values.ts`.
- `apps/web/lib/contracts/casedesk.ts`
- `apps/web/app/api/{sessions,cases,interlock}`
- `apps/web/app/sandbox/**`
- `apps/web/e2e/**` (Playwright)

**Acceptance (plan §11 P1).**
- Three cases can be processed by hand.
- Playwright smoke test passes, with screenshots.

Also required:
- The oracle-not-in-bundle test now covers a real oracle.
- The oracle marker is wired into the model-prompt guard.

### P1 results (2026-10-04)

**Status: acceptance met.**

- **Three cases processed by hand:** Playwright drives an Expert/Training session through all 3 training cases: open, rate risk, choose outcome, Save, marked Decided. It then asserts the ledger:
  - one `session.started`;
  - `dom` `screen.event`s for navigate, open_case, field_change and action, with frameSeq strictly increasing from 1 and critical field changes flagged;
  - 3 `interlock.check` and 3 `case.decision` entries, each decision's parent being its own check.
- **`pnpm test:e2e`:** **5/5 passed** against the production server in 20 s (log in `docs/evidence/p1-e2e.log`). The other specs cover:
  - interlock forbid;
  - needs_approval with an acknowledgement note;
  - insufficient_information with Escalate;
  - resume after reload.
- **Screenshots** in `docs/evidence/p1/`: `case-1..3.png`, `queue-start.png`, `review-form.png`, `queue-finished.png`, `interlock-forbid.png`, `interlock-needs-approval.png`, `resume-after-reload.png`.
  - The forbid and needs-approval screenshots use **route-intercepted test responses** with fixture quotes, because the confirmed rulebook stays empty until P5. They show the UI states, not a real confirmed rule.
- **Unit and integration tests:** web 241/241, core 397/397 plus 2 exception-scope regression tests.
- **Domain:** `NSRP-1` hidden policy (server/bench only) with 11 rules: threshold, conjunction, exception (priority 50 with an override edge), escalation, missing-data and guardrail rules.
  - Demo sets: training ×3, held-out ×2, practice ×6, plus a stratified bench generator. Every rule fires on ≥4% of bench cases, and no equal-priority disagreement occurs across 2400 cases.
- **Interlock:** `checkAction` uses Kleene override semantics: an unknown overrider gives `insufficient_information`, never `allow`.
  - Property-tested: filling in unknowns never changes a `forbid`, and supplying the reported missing features settles every `insufficient_information`.
- **Oracle isolation:** the marker `oracle:kycNorthstar:…` has **0 hits** in `.next/static` and `.next/server`. The bundle test now covers a real oracle module.
  - `runtime.claude` is created with the marker as a forbidden prompt string, which closes P0a open issue 3.

**How to see it.**
- `pnpm test:e2e`
- Or run the server and open `/sandbox`, choose Expert + Training, and process the 3 cases.

**Open issues.**
1. Novice mode looks identical to expert mode until the tutor UI lands (P6).
2. Only 1440×900 is verified by screenshot.
3. CaseDesk endpoints are unauthenticated; the session UUID acts as a capability (no enterprise auth, by design).

---

## P9 — Apprentice-Bench

**Started and finished:** 2026-10-04. It ran in parallel with P2–P5 because it depends only on the oracle, engine and solver.

**Goal.** A deterministic hidden-policy oracle, 4 strategies, metrics and a chart.

**Files.** `bench/**`, root script `pnpm bench`, outputs in `docs/evidence/bench/`.

**Acceptance.** `pnpm bench` is reproducible and generates the chart.

### P9 results

**Status: acceptance met.**

- `pnpm bench` runs in 10.5 s on 24 worker threads. Two runs gave **byte-identical** `results.json` (sha256 `9d8e2584…`).
- `pnpm bench --quick` runs in about 7 s.
- 20/20 bench tests pass.
- Artefacts: `unsafe-vs-questions.svg` (the money chart), `fidelity-vs-questions.svg`, `report.md` (method, metric definitions, simulation disclaimer, caveats) and `results.json`.
- **Setup.** 5 seeds; budgets 0–24; 24 observed decisions, then 500 held-out cases. The expert is **simulated** and answers only through the question channel, from the oracle.
  - Every strategy shares the same learner (engine, then solver `effectiveDecision`, then `checkAction`).
  - A test fails if the learner or any strategy imports the oracle.
- **Headline numbers** (mean over 5 seeds):

  | Strategy | Questions | Fidelity | Unsafe FN rate | Notes |
  |---|---|---|---|---|
  | A record-only | 0 | 0.633 | 14.9% | — |
  | D (ours) | 8 | **0.990** | **1.2%** | about 13 questions and 8 interruptions at its plateau |
  | B generic-why | 16–24 | 0.949 | **0.0%** | 16–24 questions and interruptions |
  | C ACTA | 12+ | 0.940 | 4.1% | — |

- **Honest losses.**
  - B is safer than D at budgets ≥12 (0% vs 1.2%). On one seed, D never learns the adverse-media rule, because that rule only ever co-fires with the high-risk-country rule. This is the schema-relative limit stated in plan §0.
  - With 2 questions, guardrail recall drops below record-only (94.1% vs 98.3%), because a stated exception outranks guardrails that haven't been stated yet.
  - One post-hoc change to D (debrief questions must also have EIG ≥ θ) is disclosed in `report.md`.

**How to see it.** `pnpm bench`, then open `docs/evidence/bench/report.md` and the SVGs.

**Open issues.**
1. The "why" answers are rich (exact rules at vagueness 0), which upper-bounds real verbalisation and favours B. This is disclosed.
2. There is a single synthetic policy.
3. Human-tester usability (n=2–3) is still to be run with the live system and reported as an internal demonstration only.
