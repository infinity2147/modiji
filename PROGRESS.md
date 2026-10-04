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
  | A record-only | 0 | 0.645 | 14.6% | — (was 0.633 / 14.9% before the demo training cases were redesigned; see below) |
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

---

## P2–P8 — parallel build (2026-10-04)

These phases ran in parallel waves after the shared contracts were committed: engine and Work Map schemas, the ledger-kind registry, the interview/frames/debrief/tutor HTTP contracts. Integrated baseline: commit `b444189`.
- **Checks:** typecheck clean (7 projects + root); eslint clean.
- **vitest:** 1229 passed, 1 todo, 89 files.
- **e2e:** 13/13 in the agents' isolated runs.

### P2 — Perception

**Status: acceptance NOT met (live).**

**Built.**
- Core (`packages/perception`): change detector (64×36 diff + dHash, bbox) and an ordered single-in-flight coalescing queue with a stale-result applier.
- Best-effort OCR PII redaction (vendored Tesseract, SHA-pinned `tessdata_fast`, served from our own origin).
- Haiku extraction schema and prompt.
- Evaluation harness with the plan's fixed thresholds.
- Web: capture card (disclosed), frames route (epoch/off-record/frameSeq checks, atomic storage, `frame.received`), extraction worker (`vision` `screen.event`, `concept.proposed`), media route.
- Recorded fixture: 617 captures; 52 rating changes and 42 committed outcomes, with DOM ground truth. The frames are kept out of git and verified by `frames.sha256`.
- Tests: "stale responses never applied" is tested at the queue, the applier and the server worker.

**Measured** (`docs/evidence/p2/eval-live.txt`, Haiku 4.5, one real-time pass):

| Metric | Live | Threshold | Result |
|---|---|---|---|
| Critical field-change recall | 0.192 | ≥ 0.95 | FAIL |
| Critical action recall | 0.262 | ≥ 0.95 | FAIL |
| False critical rate | 0.432 | ≤ 0.05 | FAIL |
| p95 frame→event | 8.9 s | ≤ 3 s | FAIL |
| Non-critical F1 | 0.792 | reported | — |

- Client OCR+blur in Chromium: p50 381 ms, p95 3.4 s.

**Causes, with evidence.**
1. A full-snapshot output on every frame makes each request slow (Haiku p50 5.6 s), so 254 of 311 changed frames were coalesced away.
2. Case switches are misread as edits to read-only fields.
3. Concept over-proposal.

A tuning pass is in progress. **Thresholds are unchanged.**

### P3 — Voice + gate

**Status: simulation acceptance met; live runs pending.**

**Built.**
- Deterministic gate core: reducer, evaluator, controller, HUD model.
- Browser voice loop (ElevenLabs React, token, `customLlmExtraBody`) and server question queue / `gate/authorize` / utterance capture.
- Judge view: HUD, engineering view, ledger ticker, compliance strip.

**Measured.**
- 5 scripted runs: 0 interruptions; authorization latency 0–4 ms in simulation; property tests show no interruption and ≤250 ms.
- Live (preflight): unauthorised turn silent for 8 s; authorised question first audio in 580–619 ms.
- Control turns never become evidence (tests). Live, ElevenLabs does not echo control messages.

**Pending.** 5 live typing/talking runs with real voice; first-audio p50/p95 over those runs.

### P4 — Hypothesis engine

**Status: core built and tested; the live 3-case acceptance run is pending.**

**Built.**
- Enumerator with a grouped prior (one unit per feature/direction/action; within a group, split ∝ exp(−λ·complexity)).
- Posterior, surprise, EIG (mutual information equals information gain to 1e-9).
- Constraint-valid counterfactuals; never asks what the screen answers.
- Answer application, evidence-validated promotion, event-sourced rulebook, Sonnet LLM contracts.

**Measured on the real training cases 1→2** (honest; not tuned to the demo script):
- Weight: country risk 0.306, owner share + owner verified 0.275, customer status 0.148, relationship age 0.148.
- Surprise: case 2 at 1.56–2.02 bits (no "contradiction" at the 3-bit default); case 3 (PEP) 5.41 bits, contradiction.
- Best counterfactual: "If country risk were medium instead of high…" at 0.73–0.95 bits.

**Gap.** Stated stop-rules ("never approve…") became `recommend` rules. Fix in progress (F1).

### P5 — Debrief + Work Map

**Status: acceptance met in tests and e2e; live voice path pending.**
- Starting from 3 decisions and 2 confirmed rules:
  - Z3 found 3 unresolved cells and 1 boundary → 4 witness questions (≤25 words each).
  - Answers plus one "escalate to controller" → 3/3 decisions explained.
  - Teach-back: Opus, given confirmed rules only (asserted in the prompt).
  - Deliberate correction (`>25%` → `≥25%`): revision +1, diff animated, solver reran.
  - Coverage **closed** on all 4 criteria. The sentence "No unresolved counterexample exists under the current feature model." is shown only then.
- Work Map JSON and Procedure exports round-trip. `/mcp` `check_action` blocks with the expert quote.
- Live: one real Opus teach-back (`docs/evidence/p5/teachback-live.txt`; 5.3 s, 57 words, prompt checks true).
- Screenshots: `docs/evidence/p5/`.

### P6 — Tutor

**Status: acceptance met in tests; the real stop-rule flow depends on the F1 fix.**
- **Interlock:** a property test blocked **132/132 violating commits** end to end, with a mutation check.
- **Intervention order:** ledger order is `tutor.intent` → `tutor.intervention` → queued intervention question, all before any `interlock.check`; Save then returns 409 blocked.
- **Unseen case:** NS-2026-0201 handled with predict → reveal → replay; mastery moves untested → assisted.
- **Practice cases:** Z3 generated cases at 24.9 / 25 / 25.1% owner share.
- **Oracle isolation:** no tutor module imports the oracle (static test).
- The intervention screenshot currently uses intercepted responses; it is replaced by the real flow in F1.

### P7 — Trust

**Status: built and tested; the live voice-phrase check is pending a redeploy.**
- **Off record:**
  - Mutes the mic first, then stops capture, cancels queued uploads and advances the epoch and context version (the in-flight nonce is refused).
  - Shows the red banner with the accurate claim, and fails closed.
- **Stores while off record:**
  - The server refuses capture entries and frames (409).
  - The voice phrase triggers a deterministic `set_off_record` client tool from our wrapper. Only a `privacy.phrase_detected` marker is stored, never the words.
- **PII:** best-effort OCR blur before upload.
- **Sign-off:** typed/spoken expert confirmation per rule.

### P8 — Exports

**Status: built and tested; the live agent demo is pending real stop-rules.**
- MCP `check_action` over Streamable HTTP, mounted at `/mcp` with a bearer token. It matches the interlock on 300 random cases.
- Work Map JSON round-trip; ElevenLabs Procedure compile/parse round-trip plus publisher.
- `agent-blocked` demo: the scripted run blocks with the quote; the live Claude run is pending.

### P2 — live tuning result and DECISION NEEDED (2026-10-04)

All 4 permitted live passes were used. Thresholds, fixture, matching window and the one-in-flight rule were left unchanged. Run 4 is the final code (`docs/evidence/p2/eval-live-4.txt`):

| Metric | Baseline | Run 4 | Threshold | Result |
|---|---|---|---|---|
| Critical field-change recall | 0.192 | 0.577 | ≥ 0.95 | FAIL |
| Critical action recall | 0.262 | 0.667 | ≥ 0.95 | FAIL |
| False critical rate | 0.432 | 0.227 | ≤ 0.05 | FAIL |
| p95 frame→event (server) | 8.9 s | 3.7 s | ≤ 3 s | FAIL |

- End-to-end estimate including client OCR: p95 5.8 s (`docs/evidence/p2/e2e-latency.json`).
- 16/17 false criticals come from Haiku misreading the small grey case id ("NS-2626-…"). With ids corrected after the fact (diagnostic only, not a result): false critical 0.013, action recall 0.88.

**Why field recall ≥ 0.95 cannot be met as specified.**
- Two of the 52 edits are never visible in any captured frame (overwritten within 500 ms), so the ceiling is 0.96 even with perfect reads.
- Reaching that ceiling with one request in flight needs mean extraction ≤ ~0.6 s. Measured Haiku 4.5 is 0.95 s at best (text-only), with crop reads at p50 1.43 s and full-screen reads at p50 1.93 s.

**Options for the team (D6).**
1. **Read the case id on the client.** Tesseract already reads the header; sending the id as metadata would remove ~90% of false criticals. Vision is then no longer "pure Haiku", and this would be disclosed.
2. **Larger/higher-resolution model for full-screen reads** (Sonnet/Opus at up to 2576 px). Better id reading; latency not measured.
3. **Re-record the fixture with realistic human pacing** (no edit overwritten within 500 ms). This changes the fixture, so it is the team's call.
4. **Revise the P2 thresholds or allow 2 requests in flight** (team call; roughly halves queue wait).

The product is unaffected for the demo: the tutor and the Save interlock use the disclosed DOM channel (D3), and vision is measured independently, as the plan intends.

---

## P10 — Stretch: two experts, then Hindi → English (D4)

**Started:** 2026-10-04

**Goal (plan §7.10, §7.11, §11 P10).**
- Two experts: align their sessions, encode both rulebooks, let Z3 find a valid case where they disagree, ask each expert, and turn the resolution into a revision that carries both experts' quotes.
- Any language: a Hindi-speaking expert is interviewed in Hindi. Rules stay language-neutral. Quotes are stored in the original language with an English translation, and the tutor speaks English.
- Acceptance: the disagreement witness is shown, and a Hindi→English run is completed.

### Expert identity
- `POST /api/sessions` takes an optional `expert: {name, language}`, for expert mode only. The launcher has "Your name" and "You will speak" fields.
- The expert id is the slug of the name, so "Asha Rao" becomes `asha-rao`. Sessions under one name share one rulebook.
- It is stored in `session.started.expert` as `{id, name, language}`.
- Backwards compatible: a session without a named expert is its own expert (`expert-<sessionId>`, the old id), speaking English. Every reader handles the legacy case: `sessionExpert` and `EngineState.expert`.

### Rulebook policy with two or more experts
- **Global fold, unchanged:** `rulebookFromLedger` over the `rule.*` entries of every expert session, in ledger order.
- **Per-expert rulebook:** `expertRulebook(book, expertId)` is a view of the global fold. It contains the rules whose author is the expert or whom the expert confirmed (`ruleExperts`: `expertId` ∪ `confirmedBy[].expertId`).
  - The view has its own revision count, so teach-backs go stale only on that expert's changes.
  - Each session's debrief reads only its own expert's rulebook, so another expert's rules can't be revised from a different debrief.
- **Team rulebook:** `teamRulebook(book, holds)`, in core `engine/team.ts`, holds every expert's rules except one category, held back while a disagreement is open:
  - rules of the disagreement's family;
  - whose effect is a decision (`recommend` or `route`);
  - that belong to either disagreeing expert;
  - and whose predicate is not false on the disagreement case.
- `forbid` and `require_approval` rules are **never** held back.
- The interlock, tutor, MCP `check_action` and `GET /api/rulebook` all read the team rulebook (`runtime.rulebook*`).
- **Safety is monotonic.** `checkAction` lets only guardrails constrain an action, and a held-back decision rule can affect a guardrail only through an override edge. Removing an overrider makes the guardrail's force `p ∧ ¬(o…)` truer, so an open disagreement can only make checks stricter:
  - a forbid from either expert always applies;
  - a sign-off is never lifted;
  - `insufficient_information` never becomes `allow`.
  - A property test covers this, including an exception that overrides a forbid: holding it back re-enables the forbid.
- **When a disagreement is "open":** from its `witness.found` to its `witness.resolved`, in ledger append order (`createDisagreementHolds`). The rulebook revision counts rule events only; holds are reported separately (`team.held`).

### Reconciliation flow
Code is in `lib/server/disagreements/`; routes are `/api/disagreements` and `/api/disagreements/answer`.
- **`POST /api/disagreements {experts:[a,b], decisionFamily}`** runs one reconciliation step:
  1. Resolve open disagreements that both experts answered the same way.
  2. Run `findDisagreements` (Z3) over both experts' rulebooks, in the base feature model and within the domain constraints.
  3. Close (`witness.resolved` in both sessions) any disagreement the solver no longer finds.
  4. Record each new one as `witness.found` (source solver) in each expert's **latest** session, with a `witness` question for that expert.
  - The step is idempotent, and writes are serialised across the pair.
- **Where it lives:** the experts' latest sessions, not a new session type.
  - That expert's own interview or debrief voice loop asks the question, and the answer is ordinary evidence of their session.
  - Each session's debrief ignores disagreement witnesses.
- **Questions:** the plain-language decision cell plus the two decisions, for example "Customer status existing, relationship age at least 24 months, country risk high — approve onboarding or send to enhanced review?". For a Hindi-speaking expert the text is in Hindi (`localizeQuestion`), with `textEnglish` kept alongside.
- **Answers:**
  - Typed: `POST /api/disagreements/answer {…, witnessId, expertId, decision, quote}` writes an `expert.statement` with intent `answer_disagreement` in that expert's session. It needs a redacted frame.
  - Spoken: the utterance answering that question, through the answer parser's `answeredAction`. A Hindi answer keeps its original words, plus its `utterance.translated` English rendering.
  - The latest answer counts.
- **Resolution, when both experts answer with the same action y:**
  - If one expert's rulebook already decides y on the case, its deciding rule R gets a `rule.revised` (revision + 1):
    - `confirmedBy` gains both experts' confirmations, so R joins the other expert's rulebook;
    - the evidence starts with both experts' exact quotes (`supports`), followed by the first quote of every rule R now overrides (`contradicts`);
    - `overrides` gains the other expert's deciding rules.
  - Otherwise, a new decision rule for the case's decision cell gets a `rule.confirmed`, confirmed by both and overriding both experts' deciding rules.
  - Every quote passes the same ledger validation as a promotion: a real utterance or statement, a real `frame.received`, and a real confirmation entry.
  - Different answers leave the disagreement open, still held back from the team rulebook, and shown as "still disagree".

### The "Two experts" view
`/experts?a=&b=&family=`, linked from the debrief header. It shows:
- both rulebooks side by side, in plain-language predicates, with "also confirmed by" and "held back" marks;
- the Z3 case in domain labels, with each rulebook's decision now and when found;
- each expert's question (Hindi plus its English original), their answer and quote (original, plus a translation labelled "English translation (machine, not authoritative)");
- the resolution diff (before → after: experts and overrides);
- the team rulebook in force.
- Empty states are honest: fewer than two experts, no pair chosen, no disagreement recorded yet.
- The page polls, and runs a step when a spoken answer completes an agreement.

### Hindi → English
Built by a delegated sub-agent; details in `docs/api-notes.md` §16.
- **Detection:** code-only (`detectLanguage`).
  - Devanagari letters ≥ 20% → `hi`.
  - A conservative romanised-Hindi function-word heuristic → `hi`.
  - Otherwise `en`.
  - The prior (the client's ASR language, else the expert's declared language) only lowers the romanised-Hindi bar; it never overrides the text.
- **Translation:** Sonnet, structured, as a separate `utterance.translated` entry (source engine, parent the utterance).
  - Its `segments` are checked by code to be verbatim, in order, and to cover every word.
  - With no model or an unverifiable translation, nothing is written and the translation stays pending. Nothing is fabricated.
- **Parser:** it reads the English for meaning, but every `exactQuote` must be verbatim in the ORIGINAL (`containsQuote`).
  - `ExpertQuoteEvidence` gains optional `language` and `translation`; the quote's English is derived from the segments it overlaps.
- **Questions:** live interview questions, debrief witness/teach-back questions and disagreement questions are translated into Hindi for a Hindi expert, with `textEnglish` kept. The deterministic fallback is the English question. The gate and wrapper invariant is unchanged.
- **Display:** the tutor, Work Map, MCP `check_action` citation and Procedure export show the original plus the labelled machine translation.
- The English tutor voices only the labelled translation, never the Hindi words. When no translation is on record, it points to the screen.
- **Agent:** the interviewer is v3, with `language_presets.hi` (`first_message` "") and the client language override allowed. Invariants were extended. The tutor stays English.

### Results
- **Unit and integration tests:**
  - `packages/core/test/engine.team.test.ts`: per-expert views, holds, the forbid enforced while experts disagree, and the monotonic-safety property (seed 20261004, 400 runs).
  - `apps/web/test/server/two-experts.test.ts`, 9 tests through the public handlers:
    - named sessions and directory;
    - Z3 witness found, valid under every domain constraint, recorded in both sessions and asked;
    - held-back rules, with Priya's forbid still enforced (with her quote);
    - both answers → `rule.revised` with BOTH quotes, Asha's exception quote as `contradicts`, both experts in `confirmedBy` → `witness.resolved` in both sessions → rerun finds nothing;
    - different answers stay open;
    - refusals;
    - each debrief reads only its own rules;
    - a spoken Hindi answer is quoted in Hindi with its translation;
    - agreement on a third action → a new rule confirmed by both.
  - `apps/web/test/server/tutor-language.test.ts`, plus the Part B tests listed in api-notes §16.
- **Witness found** (unit and e2e): `{customerStatus: existing, accountAgeMonths: 24, jurisdictionRisk: high, …}`, decided Asha → approve, Priya → enhanced review. That is the long-standing high-risk exception.
- **e2e:** `apps/web/e2e/two-experts.spec.ts` (public APIs, frames uploaded, LLM_CALLS=off). Screenshots are `docs/evidence/p10/two-experts-disagreement.png` and `two-experts-resolved.png`.
- **Hindi:** the local production build with real Sonnet (scripted transcript) is at `docs/evidence/p10/hindi-local-scripted.{json,txt}`, and the synthetic TTS audio is `hindi-run-synthetic-voice.wav` / `hindi-tts.json`.
- **The live ASR run (`docs/evidence/p10/hindi-run.{json,txt}`) is pending.** It needs the redeploy of this tree and `pnpm agents:sync` (interviewer v3). Then run `pnpm live:hindi`.

### Open issues
1. A disagreement is searched on request (`POST /api/disagreements`, or the page's button), not after every rule change. Until a search records it, nothing is held back.
2. The search runs in the base feature model; rules over session-confirmed concepts are left out of it.
3. Typed Hindi quotes (debrief forms) are not detected or translated. Only spoken utterances are.

---

## P11 — Verified replay mode (2026-10-04)

**Goal.** Plan §10–12: replay a genuine run through the same UI if the network fails. The replay is labelled and sourced from a real run, and is never mocked. Spec and integrity scheme: `docs/replay.md`.

### Status: acceptance met locally; the demo bundle of the live acceptance run is still to export

**Built.**
- `pnpm replay:export` (`scripts/replay-export.ts`) uses public read APIs only and prefers IPv4. It writes an immutable bundle:
  - the complete ledgers of the linked sessions;
  - the cases;
  - the server views at export;
  - the redacted frames;
  - audio only with `--audio`, and only if ElevenLabs has it.
  
  Integrity is a sha256 for every file plus a hash chain over all entries in timeline order: `link_i = sha256(link_{i-1} ‖ canonicalJson(entry_i))`. The bundle id ends in the chain head. The export also:
  - refuses if the run grew during export;
  - warns when the live rulebook holds rules from sessions outside the bundle;
  - can write the small manifest copy for git (`--manifest-copy docs/replay`).
- `pnpm replay:import` uploads a bundle through the guarded import endpoint (`PUT|POST /api/replays/:id/import…`, bearer `CUSTOM_LLM_SECRET`). The server re-verifies the bundle before moving it into `DATA_DIR/replays` and never overwrites one.
- `/replay` and `/replay/<id>`:
  - The page re-verifies the bundle on every load. On a mismatch it refuses with the reason.
  - A persistent banner reads "VERIFIED REPLAY — recorded run … integrity ✓ (n entries, chain …)", with a "Try live" link.
  - Controls: play, pause, seek by entry, speed 0.5–32×, and an option to shorten idle gaps.
  - The same components render the replay: CaseDesk, tutor cards, debrief, Work Map, HUD, ticker and compliance strip.
- **Derivations.** Every replayed view comes from the recorded entries, using the live code:
  - client: `tickerLines`, `computeCompliance`, `summariseLedger`;
  - server: `snapshot`/`debriefState`, the new `readOnlyWorkMap`, `tutorState`.
  
  The server functions run over a scratch in-memory SQLite holding the first n entries verbatim. Its ledger refuses writes, there is no model client, and Z3 runs as it does live. The HUD comes from the recorded gate entries; live timing signals are not recorded, and the HUD says so. At the end of the recording, the replay cross-checks its views against the views the server returned at export.
- **Shared edits (kept minimal).**
  - `HudBar` is split into `HudDisplay`.
  - `EventTicker` takes a `caption`.
  - The debrief cards and `WorkMapBody` are now exported.
  - `workmap.ts` is split into the pure `workMapInput`/`workMapResponse` plus `readOnlyWorkMap`.
  - `server.ts` registers the replay service.
  - `/api/health` reports `commit` (`RAILWAY_GIT_COMMIT_SHA`/`GIT_COMMIT`, else null).

**Measured.**
- `apps/web/test/server/replay.test.ts` and `test/client/replay.test.ts`: 16 tests. They cover:
  - chain definition and determinism;
  - export → bundle → verify, and immutability;
  - tampering (one byte in an entry → file hash; a forged hash → chain; one byte in a frame → refused and no longer served);
  - guarded import;
  - **parity**:
    - the replayed debrief equals the live `GET /debrief`, coverage included, except `llmAvailable`;
    - the tutor view, ticker lines, compliance strip and CaseDesk equal the live ones, both at the end and at the moment of the intervention;
  - read-only derivation.
- Full `vitest run`: 1385 passed, 1 todo.
- `e2e/replay.spec.ts`, isolated (`NEXT_DIST_DIR=.next-p11 E2E_PORT=4411`): 1/1 passed in 12 s. The test:
  1. makes a genuine run through public APIs (LLM_CALLS=off);
  2. exports it (101 entries, 3 frames);
  3. opens the replay and checks the banner shows integrity ✓;
  4. plays, with ticker and strip in step;
  5. seeks to the intervention (strip earned) and back (un-earned);
  6. shows the debrief, the Work Map, and the end-of-run cross-check (debrief ✓, tutor ✓);
  7. tampers one frame byte → refused with the reason, then restores it → plays again.
  
  Screenshots: `docs/evidence/p11/replay-*.png`. Export log: `docs/evidence/p11/replay-export.log`.

**Open issues.**
1. The demo bundle has not been exported yet; it needs the session ids of the live acceptance run. The command is in `docs/replay.md`.
2. Work Map titles and summary are the labelled templates in replay; the recorded model prose is not stored in any public API.
3. Lineage trace buttons are hidden in replay (the trace route reads the live ledger).
4. Audio is opt-in (`--audio`) and depends on ElevenLabs retention (30 days on our agents).

### P11 update — the demo bundle is exported (2026-10-04)

- Bundle `20261004-0119-96acd563eb14` was exported from production.
- Sources: the genuine live voice run, sessions `cad2596d…` (stop-rules by voice) and `f77499f8…` (P4 final).
- Contents: 393 entries, chain head `96acd563…`, and the recorded ElevenLabs conversation audio for both conversations.
- Manifest: `docs/replay/20261004-0119-96acd563eb14.manifest.json`.

---

## Live acceptance runs against production (commit 1da6e3c, 2026-10-04 00:27–01:37 UTC)

Source: `docs/evidence/live/ACCEPTANCE.txt` and `SUMMARY.txt`. All expert speech was **synthetic voice input (ElevenLabs TTS)**.

**P3 — NOT MET.**
- 3 interruptions across 5 runs, all in run D (noisy, near the VAD threshold). Root causes: ElevenLabs VAD missed quiet speech and lagged speech onset by ~600 ms.
- Gate decision latency: p50 0, p95 3, max 15 ms (n=22).
- Conditions valid → control message sent, including the production round trip: p95 967 ms. The network RTT alone is ≈265 ms.
- First audio: p50 697, p95 808 ms.
- Control turns never appeared in evidence.

**P4 — MET, by voice with real Sonnet.**
- Threshold rule: `uboOwnershipPct > 25 ∧ ¬uboVerified → enhancedReview`.
- Guardrail: PEP requires compliance sign-off, with the exact quote.
- 2 unresolved concepts surfaced.
- 2/2 promoted rules pass evidence validation.
- The script choices made after earlier bugs are disclosed.

**P8 — MET.**
- A real Claude (Opus 5.5) agent on held-out NS-2026-0201 was blocked via production `/mcp`, citing the expert's exact quote.
- The Work Map JSON round-trips byte-identically. The Procedure rules equal `/api/rulebook`.
- MCP agrees with a local check on 55/55 cases.

**Bugs found:** 6 product bugs. All were fixed in commits `1b0c089` and `f317447`:
- worker threads for Z3, question generation and vision preparation (event-loop p99 112 → 32 ms on 1 CPU);
- open-turn tracking and a local speech-onset detector;
- authorization hold, plus a server refusal of a second pending authorization;
- multi-segment answers;
- budget rollback;
- explicit-statement promotion;
- re-queue of lapsed questions;
- session archiving;
- canonical rule de-duplication;
- a filter for concepts proposed from screen chrome;
- ledger kind indexes plus incremental folds.

**Simulation after the fixes:** 0 interruptions on all 5 scripted runs and on a reproduction of run D, at authorize RTTs of 0, 270 and 2640 ms. With the local detector removed, the run-D reproduction interrupts again, as live run D did.

**The live P3 re-run on the fixed build is pending.**

---

## Production stall diagnosis (2026-10-04, build f317447)

`/api/health/deep` on production after the live re-runs:
- `eventLoop`: **p50 0.1 ms · p99 1.8 ms · max 13,856 ms** over 542,704 samples.

**Reading.** 99% of event-loop samples are ≤ 1.8 ms — the code is healthy; Z3, question generation and vision preparation are already off the main thread (FX1). A lone 13.8 s maximum with a 1.8 ms p99 is the signature of a **host-level freeze** (Railway container CPU throttling or a long GC pause), not an algorithmic stall that scales with sessions or rules (a sub-agent read the decision path and found nothing that scales). Worker threads raise total CPU, which can trigger a CPU quota sooner under the demo's multi-modal burst (vision + voice + engine).

**Mitigations (in priority order).**
1. **Run the judged demo with vision extraction off** (`LLM_CALLS`/vision off): the tutor and Save interlock use the disclosed DOM channel (D3), and vision accuracy is measured separately. This removes the heaviest live-path CPU burst (PNG decode + Haiku + OCR).
2. **Use the verified replay** for the capture/debrief beats (plan §10); only the tutor intervention runs live, which is light.
3. **Response-path hardening** (code): flush the custom-LLM SSE and gate/authorize responses before any post-decision engine work (`setImmediate`), so a host freeze cannot delay the live speech path. Add GC/throttle visibility to deep health.
4. **Resource bump (cost decision, for the team):** raise the Railway service CPU/memory so the container isn't throttled under burst. Not applied unilaterally.

**Fresh demo ledger required before judging:** production is at rulebook revision 60 (14 team rules) from the live runs, including a Hindi rule that now forbids approval for every high-risk-country customer. Point `DATA_DIR` at a fresh path before the demo (procedure in `docs/deploy.md`); the old data stays on the volume.

**P9 re-run after the demo-case redesign (2026-10-04).** The training cases 1 and 2 were redesigned (they now differ only on ownership share and jurisdiction), which changes the seed observation stream. Re-running `pnpm bench` (still deterministic, 7.5 s) moved only the record-only floor: A fidelity 0.633 → 0.645, unsafe 14.9% → 14.6%. Strategies B, C and D are unchanged at every budget (D 0.990 / 1.2% from 8 questions; B 0.0% unsafe at 24 questions), so every comparative claim above still holds. `results.json` sha256 changed from `9d8e2584…` to `c66a686a…`; the committed evidence is the new run.

---

## Final state notes (2026-10-04)

**Known issues (not fixed).**
1. **Stale witness question text.** A debrief witness keeps its id, and therefore its already-queued question, while its assignment is unchanged. If the confirmed rulebook changes afterwards so that the same cell now needs another condition to describe it, the spoken or displayed question can omit that condition (for example it says "Politically exposed person: no" when the live cell is also "country risk not medium"). The answer still targets the correct cell, because the card's chips and the cell rule are computed live. Candidate fix: re-queue or refresh a witness question when its cell description changes.
2. **P2 vision thresholds not met.** See the P2 sections above. On the current fixture, with the thresholds unchanged: false critical 0.024 (pass), server p95 2.93 s (pass), critical field recall 0.846 and critical action recall 0.857 (both below 0.95). The team accepted reporting the miss. The human-paced fixture is still to be delivered and re-measured.
3. **Host freeze.** One-off event-loop freezes of up to 13.8 s occurred in production while memory sat at about 96% of the 1 GB cap and CPU stayed near idle. Raising the memory limit to 2 GB is a dashboard action (docs/deploy.md).

---

## Deployed state (2026-10-04, ~12:10 IST)

- **Production runs `main` at `6abc2a4`**: the accounts, roles and new UI merge (`39f3cd3`), plus the live-path fixes, the P2 vision changes, the redesigned training cases and the expert Debrief / Work Map buttons. Deployment `4df5220b`: SUCCESS, started cleanly, deep health ok, event-loop p99 1.8 ms.
- **Sign-in is enforced.** Anonymous `POST /api/sessions` and `GET /api/auth/me` return 401. Anonymous `/sandbox` redirects to `/login`. Anonymous `GET /api/voice/token` returns 401.
- **Vision extraction is OFF in production** (`VISION_EXTRACTION=off`, a plain Railway variable). Frames are still stored and ledgered; no Haiku reads. This was ON before, which with screen motion explains the high latency reported during the first live session.
- **Fresh demo ledger**: `DATA_DIR=/data/demo-20261004`. The old data is still on the volume. The verified replay bundle `20261004-0119-96acd563eb14` is imported (393 entries, chain head `96acd563eb14`).
- **Admin not yet created.** `ADMIN_USERNAME` and `ADMIN_PASSWORD` must be set together on Railway. With neither set, nobody can grant the expert role, and startup logs a warning. Setting only one fails startup.
- **Live preflight on this build: GREEN 9/9.** It includes the retry-window invariant (same text inside 10 s, refusal after it), the anonymous voice-token refusal and the sign-in gate on `/sandbox`.

**Operational lessons recorded in `docs/deploy.md`.**
1. Putting `limitOverride` and `VISION_EXTRACTION` in `.railway/railway.ts` crashed a deploy (the `preserve()` variables arrived missing). A failed deploy leaves the old build serving. After every deploy, check `railway deployment list` and confirm a new behaviour is live.
2. This machine's network stalls about one new connection in six for the full 10 s connect timeout, on every host. Preflight now retries a connect timeout once.
