# CHANGES.md: plan.md v1 → v2

v2 keeps the v1 core and fixes the gaps an external review found in semantics, implementation and claims. Unchanged from v1:
- questions triggered by surprise and ranked by expected information gain
- formal rule reasoning with Z3
- Work Maps where every rule links to its evidence
- a tutor tested on cases the expert never showed
- a deterministic gate that decides when the agent speaks
- ElevenLabs voice
- one rulebook that guards both humans and agents

## Claims and wording
1. **"Completeness proof" and "100% understanding" are now "schema-relative coverage" (also called counterexample closure).** Z3 only proves things about the features we currently know of, their declared ranges, the domain constraints and the rule language. The UI shows: decisions explained N/N · unresolved witnesses · undefined concepts · sign-off.
2. **Market claims narrowed.** Removed "nobody / none captures decision boundaries", because Skan AI and getAbstract Tacit both do versions of this. Our position is now the *combination* (§2.2: "five capabilities rarely unified in one loop"). Skan and Tacit are presented as validation of the category.
3. **Pitch numbers trimmed.** TAM forecasts and vendor self-reported metrics move to the research appendix. The pitch keeps the brief's own macro facts and at most one adjacency slide.
4. **Name flagged.** getAbstract already sells a product called *Tacit*. Alternatives are listed; the name is decision D0.
5. **One-liner no longer attacks Scribe by name.** It now reads "Recorders capture what happened…"
6. **Moonshot reframed** as a private, verified judgment layer for one organisation. Pooling knowledge across companies is now a distant, opt-in idea.

## Data model and semantics
7. **Hypotheses and confirmed rules are now separate types.** Hypotheses (`HypothesisSet` / `CandidateRule`) carry weights. The authoritative rulebook (`ConfirmedRule`) does not, and rejected hypotheses can't leak into the Work Map, tutor or exports.
8. **Evidence is mandatory in the type itself.** A `ConfirmedRule` requires at least one `ExpertQuoteEvidence` with an exact quote, timestamps, frames, and a supports/contradicts relation.
9. **Three-valued logic (true / false / unknown).** A missing feature no longer evaluates to false. `check_action` returns allow / forbid / needs_approval / insufficient_information plus the missing features. We write our own evaluator, because json-logic-js only supports true/false.
10. **Rules now have priorities.** Effect types (`recommend`, `require_approval`, `forbid`, `route`), priority and explicit override links mean a guardrail overriding an ordinary decision rule is no longer reported as a contradiction. A Z3 conflict now means: same decision family, equal priority, neither rule overrides the other, and incompatible terminal outcomes.
11. **`DecisionContext` replaces the flat case snapshot.** It holds case, workflow/history, actor and environment, so rules can later depend on history (via derived features).
12. **Schema versioning.** When the expert confirms a new feature, coverage is invalidated and past cases are backfilled from stored frames where possible. Otherwise they are marked unknown and the solver reruns.
13. **Domain constraints.** Z3 counterfactual cases must satisfy them, so the system never asks about a 135% ownership share.
14. **Explicit action IDs** declared per domain, replacing free-text action strings.
15. **What vision sees is separated from activity signals.** Typing, focus, idle and voice activity are no longer events the vision model infers.
16. **Append-only event ledger.** Every entry has a sequence number, timestamps, source, trace ID and parent IDs, so any guardrail traces back to the expert moment that created it.

## Algorithms
17. **Hypothesis space from two sources.** A deterministic enumerator generates simple threshold, equality and two-condition rules with a complexity prior. The LLM adds only latent concepts, which the expert must confirm. The LLM no longer defines the whole space.
18. **Surprise defined explicitly:** P(a) = Σ w·P(a|h).
19. **Information gain is now the full formula including noise:** IG = H(W) − Σ_a P(a|q) H(W|a,q), computed as the identical mutual information H(A) − Σ_h w_h H(A|h). (v1's "entropy of predicted answers" was correct only for noise-free hypotheses, but v1 also added noise.)
20. **ε is now a configurable heuristic** called `expertNoisePrior`, calibrated on the benchmark.
21. **Mastery is now a transparent ladder** (untested → assisted → correct once → correct at a boundary case → mastered). Its parameters in v1 were arbitrary. BKT is optional and labelled heuristic.

## Runtime and voice
22. **The gate is now the only authority for speech.** It issues a `GateAuthorization` nonce. The custom-LLM wrapper returns `skip_turn` whenever no valid authorization exists. Patient eagerness and `sendUserActivity` (which holds the agent for only about 2 s) are supplementary.
23. **Control messages tracked by source.** `sendUserMessage` is a literal user turn, so triggers are tagged `system_control` and never become evidence.
24. **Option A (custom LLM) is justified by control, not novelty.** The wrapper is thin: it speaks a precomputed question and does not reinvent it.
25. **Work Map built by code, not compiled by Opus.** Opus only writes prose. Exports are deterministic or checked by converting back to the source rules.
26. **Interception is now a disclosed hybrid.** Fast sensing in the sandbox uses DOM events, vision runs independently and is measured, and a **deterministic Save interlock** blocks any commit that violates a confirmed stop-rule. We no longer claim cloud vision can beat a click.
27. **Frames are processed in order.** Each carries a sequence number, only one vision request runs at a time with newer frames coalesced, and stale responses are dropped.
28. **Deployment is a single persistent Node service** with a volume (Railway or Fly). Vercel doesn't suit SQLite on disk, long-lived SSE or Z3.

## Privacy
29. **"Off the record" now does what it says.** It mutes the mic, stops frames, cancels queued uploads, advances a privacy epoch so stale uploads are rejected, and stops local evidence capture. We no longer claim deletion from ElevenLabs. Verified: retention defaults to 2 years, deletion is whole-conversation only, and Zero Retention Mode is Enterprise-only.
30. **PII redaction is described as best-effort.** In the hackathon the real guarantee is synthetic data.
31. **The hidden rulebook is server/bench-only**, split into `domain.public.ts` and `domain.oracle.server.ts`, with a test that fails if it reaches a client bundle or a model prompt.

## Evaluation
32. **Apprentice-Bench uses a deterministic oracle.** The answers come from code. An LLM may only reword them, which removes the circular setup where an LLM learner was graded by an LLM expert and judge.
33. **Learned rules are scored by behaviour on held-out cases**, by guardrail recall and by unsafe false negatives, plus Z3 equivalence checks. String matching is gone. The headline chart is unsafe error rate vs number of questions asked.
34. **Human tester results are usability evidence only**, labelled n=2–3 and not a powered study.

## Phases and process
35. **P0 split.** P0a is local work that needs no decisions; P0b is external integration that needs them.
36. **Decisions D0–D6 are now set up front in the bootstrap prompt.** v1 told Claude Code to "ask and keep building while waiting", which it can't do.
37. **Acceptance thresholds are fixed before implementation** (team confirms in D6):
    - Perception counts recall on critical events.
    - The gate has a positive test: authorization within 250 ms of conditions being valid.
    - P4 is domain-independent.
    - P5 no longer says "meter reaches 100%".
38. **`pnpm preflight` and a labelled verified replay mode added.**
39. **Fewer exports:** Work Map JSON (core), MCP `check_action` and an ElevenLabs Procedure. DMN, Cedar, Skill and Markdown are optional.
40. **HUD has a simple judge view by default**, with an engineering toggle.
41. **The demo shows compliance counters** (3/3 live, guardrail ✓, 3/3 debrief, teach-back ✓, intercepted ✓) and includes a deliberate expert correction.
42. **API notes updated.** ElevenLabs' `simulate-conversation` endpoint is deprecated and will be removed 31 Oct 2026, so it is replaced by the Agent Testing APIs (verified on the docs page). Snippets are marked conceptual; installed types override them.
43. **Claude Code prompt tightened:**
    - The stack is frozen unless it blocks a required capability.
    - "Production quality" is defined.
    - The live demo path is the top-priority production path.