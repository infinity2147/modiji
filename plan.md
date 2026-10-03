# [Product] — The Judgment Compiler · plan.md v2
### Hack-Nation 7th Global AI Hackathon · Challenge 01 "The AI Apprentice" (ElevenLabs)
*Research as of 3–4 Oct 2026. v2 incorporates an external technical review (see CHANGES.md). The team owns every scope and naming decision; this document gives options, defaults and reasons.*

> **Thesis line:** *LLMs infer. Experts confirm. Code enforces.*
> **One-liner:** Recorders capture what happened. We learn the decision boundary behind it — and prove it transfers by stopping a mistake on a case the expert never showed us.

**Working name.** "TacitOS" was the v1 working name. getAbstract already sells a tacit-knowledge product called **Tacit**, so v1's name invites confusion. Alternatives: **KnowWhy, ReasonMap, RuleTrace, Boundary, ProofWork, SkillProof, JudgmentOS**. Team decides (Decision D0). The repo codename is `apprentice` until then.

---

## 0. Technical thesis (defensible version)
The system maintains **competing executable explanations** of an expert's decisions. It interrupts only when a question is expected to eliminate meaningful alternatives, and only when a deterministic gate authorises speech. Every promoted rule requires exact expert evidence. A solver searches the confirmed rulebook for counterexamples *within the current feature model*; the expert resolves them. Transfer is demonstrated by stopping an unseen novice mistake — and the same rules guard an AI agent.

What we claim, precisely:
- **Schema-relative coverage / counterexample closure**: "No unresolved counterexample exists under the current feature model." We **never** claim complete knowledge of the expert. New concepts can always appear; the system is built to absorb them (schema versioning, §6.6).
- **Expected information gain** computed over an explicit, partly enumerated hypothesis space (§7.3), with a configurable expert-noise heuristic.
- **Deterministic enforcement**: speech authorisation, rule evaluation, Save interlock and exports are code, not model output.

---

## 1. Brief → system map (and how the demo proves each)

| Brief requirement | Component | Visible proof in the demo |
|---|---|---|
| M1 screen share + agent side panel; frames → vision → events | §7.1 Perception | Event ticker ("BO ownership read: 35% · risk tier changed: Medium→High") |
| M1 ≥3 questions at natural pauses about visible things, ≥1 guardrail | §7.2 Gate, §7.3 Hypothesis Engine | Compliance strip: **Live questions 3/3 · Guardrail ✓** |
| M2 debrief ≥3 new follow-ups + confirmed teach-back | §7.5 | **Debrief gaps closed 3/3 · Teach-back confirmed ✓** with one live correction |
| M2 Work Map: every step & guardrail → screen moment + expert words | §7.6 | Click a guardrail → redacted frame + the expert's audio clip; lineage trace animates |
| M3 tutor on new hire's screen, explains in expert's words, predict-next-decision, intervene before guardrail break, replay, mastery | §7.7 | Unseen case; wrong value → spoken intervention; Save interlock blocks commit; mastery ladder |
| Test Q1 When to ask | §7.2 | Gate HUD: waits while typing/speaking/screen moving |
| Test Q2 What to ask | §7.3 | "Asking — contradiction detected · EIG 0.61 bits" |
| Test Q3 When understood | §7.5 | Coverage-under-current-model panel: decisions explained 3/3 · unresolved witnesses 0 · undefined concepts 0 · sign-off ✓ |
| Test Q4 Did the new hire learn | §7.7, §9 | Held-out case handled; benchmark behavioural fidelity chart |
| Test Q5 Trust | §7.8 | "Off the record" mutes mic + stops frames (privacy epoch); best-effort PII blur; expert sign-off |
| Stretch: two experts | §7.10 | Solver produces a concrete case where their rulebooks disagree |
| Stretch: any language | §7.11 | Hindi/German expert → English tutor |
| Stretch: agent-ready guardrails | §7.9 | MCP `check_action` blocks a Claude agent with the expert's quote |

---

## 2. Market research

### 2.1 Landscape (2026)
| Category | Products | Strength | Relative to our loop |
|---|---|---|---|
| Process documentation | Scribe (Scribe Optimize) · Tango · Guidde ("visual imitation learning" for agents) · Loom AI · Trainual · Supademo · Arcade | Fast capture of steps | Capture actions; Guidde itself notes AI "can only document what someone explicitly tells it or what it observes" |
| Digital adoption | WalkMe (SAP) · Whatfix · Pendo · Userlane (validators "to catch errors before they're saved") | In-app guidance, pre-save validation | Guidance and validators are authored by admins |
| Process/task intelligence | **Skan AI** (Context Graph: decision inputs, exceptions, workarounds, operator judgment → traceable Agentic Operating Procedures) · Celonis · UiPath · Power Automate · SAP Signavio · Mimica · Soroco · KYP.ai | Decision-aware context at enterprise scale, inferred from work traces | Acquisition is inference from populations of traces, not live active interrogation of one expert at the screen moment |
| Expert interviews | **getAbstract Tacit** (interviews experts on how they decide, verifies claims, follows up on contradictions) · KNOA (flags disagreement) · Ontora (YC S26) · Interloom | Elicits reasoning, verifies claims | Interviews happen away from the exact screen moment; no transfer test on unseen cases |
| Demo-to-agent | Claude in Chrome "Record workflow" · Copilot Studio computer use · Amazon Nova Act · Minded (screen + voice notes on exceptions) · Simular · Skyvern | Turns demos into bots | Trains bots; doesn't coach humans or verify with the expert |
| Screen-aware assistants | Copilot Vision · Gemini Live · Cluely · Highlight | Live help over a shared screen | General-purpose; no org-specific verified procedure memory |
| Coaching | Second Nature · Hyperbound · Yoodli · Synthesia · Docebo | Role-play, content | Not screen-task judgment |
| Agent guardrails | AWS Automated Reasoning checks · AgentCore Policy (Cedar) · NeMo Guardrails · Guardrails AI | Enforce given policies | Assume a written policy exists — we produce one from the expert, with evidence |

**Skan and Tacit are useful to our story, not threats to hide.** Skan shows decision-aware process context is a real enterprise category; Tacit shows expert-reasoning capture is valued. We explore a different acquisition mechanism: **active, screen-grounded interrogation of a live decision, counterexample generation, expert verification, and transfer tests.**

### 2.2 Five capabilities rarely unified in one loop
1. Questions asked **at the live screen moment**, chosen by expected information gain.
2. **Counterexample generation** against the learned rulebook, resolved by the expert.
3. **Evidence-mandatory rules** traceable to the exact utterance and frame.
4. **Transfer test**: an unseen-case tutor that intervenes before a violation, with a deterministic Save interlock.
5. **One rulebook for humans and agents** (tutor + MCP guardrail).

### 2.3 Pitch-safe numbers (use sparingly)
- Brief's own macro story: 11,200 Americans turn 65 daily; Germany 12.9M workers past retirement age by 2036; 1.6B people 65+ by 2050.
- At most one adjacency slide: Scribe $75M Series C at $1.3B valuation (company press release); SAP acquired WalkMe for ~$1.5B; Skan AI $63M Series C (Aug 2026).
- TAM forecasts and vendor self-reported metrics stay in this research appendix, **not** in the pitch.

### 2.4 Positioning matrix (pitch slide)
| | Captures steps | Elicits reasons | At the screen moment | Counterexamples verified by expert | Coaches humans on unseen cases | Guards agents |
|---|---|---|---|---|---|---|
| Recorders (Scribe/Tango/Guidde) | ✅ | — | ✅ | — | partial | data only |
| Skan AI | ✅ | inferred | from traces | — | — | ✅ |
| Tacit / KNOA | — | ✅ | — | claim checks | — | — |
| DAPs (WalkMe/Whatfix/Userlane) | — | — | ✅ | — | authored | — |
| Policy guardrails (AWS/Cedar) | — | — | — | on given policy | — | ✅ |
| **Us** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 3. State of the art we build on (cite only official / peer-reviewed numbers)
| Layer | Reference | Published number | Our use |
|---|---|---|---|
| SOPs from demos | ECLAIR (Stanford, arXiv 2405.03710) | SOP precision 0.94 / recall 0.95; end-to-end completion 40% | Steps; we add reasons and verification |
| SOP over-generation | WONDERBREAD ICL (2409.15867) | precision 44%; 18 predicted vs 8.4 true steps | Step = decision-bearing segment; merge micro-events |
| Workflow memory | AWM (2409.07429); LearnAct (2504.13805) | AWM +24.6% Mind2Web / +51.1% WebArena; LearnAct 19.3→51.7% | Work Map reused by agents |
| Novice help | GUIDE (CVPR 2026, 2603.25864) | 44.6% state detection, 55.0% help prediction; +50.2 pts with user context | Tutor has the context (Work Map) |
| Proactive timing | OmniPro (2605.18577); ProactiveBench (2410.12361) | online F1 20.9%; best F1 66.47% | Timing is deterministic, not model-chosen |
| End of turn | Smart Turn v3.1; LiveKit Turn Detector v1.0 | 94.7–95.6% EN; 9.9% false cut-offs | One gate input (via ElevenLabs VAD) |
| Question selection | GATE (2310.11589); UoT (2402.03271); BED-LLM (2508.21184); info-gain clarifier (2606.03135) | UoT +38.1%; clarifier calls 4.2→1.3 | EIG over explicit hypotheses |
| Interview method | ACTA (Militello & Hutton 1998); Critical Decision Method (Klein 1989) | human-factors standard | Probe templates |
| Formal policy | AWS Automated Reasoning checks; Cedar (2403.04651); DMN overlap (1603.07466); Z3 | AWS: up to 99% verification accuracy on given policies | Z3 witnesses within domain constraints |
| Tutoring | Harvard RCT (Sci. Reports 2025); World Bank Nigeria; LearnLM (2412.16429) | 0.63 SD; 0.3 SD; +31% preferred | Predict-then-reveal |
| PII | Presidio; nvidia/gliner-PII | gliner-PII F1 0.70 | Best-effort client redaction |
| GUI grounding | Claude Sonnet 4.5 OSWorld 61.4% (official); UI-TARS-2 47.5; OmniParser v2 ScreenSpot-Pro 39.6 | 2026 aggregator scores >80% are vendor self-reported — do not cite | Frontier vision for events |

---

## 4. The product — four inventions
1. **Surprise-driven, EIG-ranked questioning** over a hybrid hypothesis space (deterministic enumeration for ordinary boundaries + LLM for latent concepts).
2. **Counterexample closure**: Z3 finds valid-domain cases the confirmed rulebook leaves unresolved or genuinely contradictory; the debrief asks exactly those.
3. **Hybrid interception**: spoken intervention as early as the wrong value is sensed, plus a **deterministic Save interlock** that runs confirmed guardrails before commit.
4. **One rulebook, two consumers**: human tutor and MCP `check_action` for agents, compiled by code.

Plus **Apprentice-Bench** with a deterministic hidden-policy oracle (§9).

---

## 5. Architecture

```
SCREEN (getDisplayMedia)
  ↓ client change detector (dHash/pixel diff) + best-effort OCR/PII blur + privacy epoch
  ↓ ordered perception queue (1 in flight per session, coalesce newer frames, frameSeq)
SCREEN EVENTS (vision)         ACTIVITY SIGNALS (input, focus, screen motion, VAD)   DOM EVENTS (CaseDesk only)
  ↓                                 ↓                                                     ↓
DECISION CONTEXT (case · workflow/history · actor · environment, schemaVersion)          Save interlock
  ↓
HYPOTHESIS ENGINE ── enumerated candidates + LLM concepts → weighted HypothesisSet per decision family
  ↓ surprise / EIG → question queue
DETERMINISTIC GATE → GateAuthorization{questionId, nonce, expiresAt, contextVersion}
  ↓
CUSTOM-LLM WRAPPER (thin) ── no valid authorization ⇒ skip_turn; valid ⇒ speak the precomputed question
  ↓
ELEVENLABS VOICE (Scribe realtime ASR · Eleven v3 Conversational TTS, Expressive Mode)
  ↓
EXPERT ANSWER (provenance: human_voice) → answer parser → evidence + hypothesis update
  ↓
Z3: valid-domain gap / conflict / boundary witnesses → debrief → expert verification
  ↓
CONFIRMED RULEBOOK (code-compiled, evidence-mandatory, versioned)
  ↓                                  ↓
HUMAN TUTOR (voice + Save interlock)   MCP GUARDRAIL check_action (agents)

APPEND-ONLY LEDGER underneath everything: every input and derivation, with parent provenance.
```

**Runtime:** one persistent Node service (Next.js custom server or Next + a co-located worker) on **Railway or Fly** with one volume: SQLite + `/data` media. Custom-LLM SSE endpoint and Z3 run in the same service. Serverless (Vercel) is a poor fit for SQLite-on-disk, long SSE and Z3 WASM; decided at P0 (D5).

**Model routing (Claude API IDs verified):**
| Job | Model |
|---|---|
| Per-frame event extraction (structured output) | `claude-haiku-4-5-20251001` |
| LLM hypothesis proposals, answer parsing, question phrasing (constrained schema) | `claude-sonnet-5-5` |
| Teach-back prose, step titles, summaries (non-authoritative) | `claude-opus-5-5` |
| Low-confidence frame re-read | `claude-opus-5-5` (optional) |

Cost reference: image tokens ≈ ⌈w/28⌉×⌈h/28⌉ → 1568×882 ≈ 1.8k tokens ≈ $0.002/frame on Haiku 4.5.

**Voice-brain option A (custom LLM, default)** is chosen for **control**, not novelty: deterministic silence, exact state access, provenance, precomputed questions, no spontaneous chat. The wrapper is deliberately thin. Option B (hosted `claude-haiku-4-5` / `claude-sonnet-5` inside ElevenLabs) remains a fallback; it cannot make "the LLM never decides when to speak" strictly true.

---

## 6. Data model (TypeScript, conceptual — validate with zod)

### 6.1 Ledger & signals
```ts
type LedgerEntry = {
  id: string; sessionId: string; sequence: number;             // monotonic per session
  source: "client"|"vision"|"dom"|"voice"|"engine"|"solver"|"expert"|"system_control";
  kind: string; occurredAt: number; receivedAt: number;
  traceId: string; parentIds: string[]; schemaVersion: number; privacyEpoch: number;
  payload: unknown;
};

type ActivitySignal = { kind: "typing"|"pointer"|"focus_change"|"screen_motion"|"idle"; t: number; value?: number };
type VoiceSignal    = { kind: "vad"|"user_speaking"|"agent_speaking"|"turn_end"; t: number; value?: number };

type ScreenEvent = {           // semantic only — produced by vision (or DOM in CaseDesk, labelled)
  id: string; frameSeq: number; captureTime: number; sessionEpoch: number;
  kind: "open_case"|"field_change"|"action"|"navigate";
  caseId?: string; field?: FeatureId; from?: Value; to?: Value; action?: ActionId;
  confidence: number; source: "vision"|"dom"; critical: boolean;
};
```

### 6.2 Domain config (public vs oracle)
```ts
// domain.public.ts — shipped to the browser
type DomainConfig = {
  id: string; title: string;
  features: Feature[];                         // typed, with domains
  actions: { id: ActionId; label: string; terminal: boolean; params?: Schema }[];
  decisionFamilies: { id: string; actions: ActionId[] }[];
  domainConstraints: Predicate[];              // e.g. 0 ≤ ownershipPct ≤ 100; entityType=individual ⇒ !hasUBO
  criticalFields: FeatureId[];
};
// domain.oracle.server.ts — server/bench only, never bundled or sent to any model
type HiddenPolicy = { rules: ConfirmedRuleLike[]; evaluate(ctx: DecisionContext): OracleResult };
```

### 6.3 Decision context
```ts
type DecisionContext = {
  case: Record<FeatureId, Value|Unknown>;
  workflow: { stepId?: string; priorActions: ActionId[]; reviewerHistory?: unknown[] };
  history: { derived: Record<FeatureId, Value|Unknown> };   // e.g. supplierPriorFailures
  actor: { role: string; id: string };
  environment: { date: string; periodEnd?: boolean };
  schemaVersion: number;
};
type Unknown = { unknown: true; reason: "not_visible"|"not_extracted"|"backfill_failed"|"off_record" };
```
Rules operate on **derived features** over this context; full temporal logic is out of scope for now, but the abstraction doesn't block it.

### 6.4 Hypotheses vs confirmed rules (separate types)
```ts
type HypothesisSet = { id: string; decisionFamily: string; candidates: CandidateRule[];
                       normalizationVersion: number; schemaVersion: number };

type CandidateRule = { id: string; hypothesisSetId: string; predicate: Predicate;
                       predictedAction: ActionId; weight: number;     // normalised within the set
                       complexity: number; origin: "enumerated"|"llm"|"expert_statement" };

type RuleEffect =
  | { type: "recommend"; action: ActionId }
  | { type: "require_approval"; role: string }
  | { type: "forbid"; action: ActionId }
  | { type: "route"; destination: string };

type ConfirmedRule = {
  id: string; decisionFamily: string; kind: "decision"|"guardrail"|"escalation"|"exception";
  predicate: Predicate; effect: RuleEffect;
  priority: number;                      // higher wins within a family
  overrides: string[];                   // explicit override edges
  evidence: [ExpertQuoteEvidence, ...EvidenceLink[]];   // ≥1 supporting expert quote, structurally required
  confirmedBy: Confirmation[]; revision: number; schemaVersion: number; expertId: string;
};

type ExpertQuoteEvidence = { kind: "expert_quote"; utteranceId: string; exactQuote: string;
  t0Ms: number; t1Ms: number; frameIds: [string, ...string[]]; eventIds: string[];
  relation: "supports"|"contradicts"; provenance: "human_voice"|"human_text" };
```
Rejected candidates never reach the Work Map, tutor, or exports. Weight lives only on candidates.

### 6.5 Three-valued evaluation
```ts
type Truth = true | false | "unknown";       // Kleene logic: unknown ∧ false = false, unknown ∨ true = true
type GuardrailResult = {
  decision: "allow"|"forbid"|"needs_approval"|"insufficient_information";
  matchedRules: string[]; missingFeatures: FeatureId[]; evidence: ExpertQuoteEvidence[];
};
```
Predicates use a **JSON-Logic-compatible subset** (`== != < <= > >= in and or not`, `var`) evaluated by **our own Kleene evaluator** (json-logic-js is two-valued). A guardrail whose predicate is `unknown` ⇒ `insufficient_information` (UI treats as needs approval).

### 6.6 Schema versioning
When the expert confirms a new feature: `schemaVersion++` → invalidate coverage → attempt backfill for past cases from stored redacted frames/events (vision re-read) → otherwise mark `Unknown{backfill_failed}` → rerun hypotheses and solver. The UI shows "Model updated: new concept *verifiedSourceOfFunds* — coverage recomputing".

---

## 7. Module specifications

### 7.1 Perception
- Capture `getDisplayMedia` → canvas every 500 ms → change detector (64×36 grayscale diff + dHash) → change bbox.
- **Best-effort** privacy pass in browser: Tesseract.js OCR on changed region → regex/name-list/optional small NER → blur. Frames tagged with `privacyEpoch`; server rejects frames from stale epochs.
- **Ordering & backpressure:** one vision request in flight per session; while waiting, keep only the newest frame (coalesce). Responses carry `frameSeq`; the state applier ignores any response older than the last applied.
- Upload ≤1568 px full frame + high-res change-bbox crop + previous case snapshot (text). Haiku 4.5, structured output → `ScreenEvent[]`; `critical` set from `criticalFields`.
- Proposed new features from vision go to an "undefined concepts" list for expert confirmation (§6.6).
- **CaseDesk DOM channel**: emits labelled `source:"dom"` events. Used for (a) the Save interlock and fast tutor sensing (disclosed in UI: *"Tutor sensing: DOM + vision validation"*), (b) measuring vision accuracy. Vision always runs independently so generality is measured, not assumed.

### 7.2 Deterministic gate (sole authority for speech)
Authorize iff all hold (thresholds configurable, defaults shown):
```
!userSpeaking for ≥ 1.2 s (ElevenLabs onVadScore / mode) · screenMotion idle ≥ 1.5 s · last keystroke ≥ 1.5 s
· (atBreakpoint || question.ephemeral) · queue.top.value ≥ θ_ask · liveBudget (default 5 per 10 min)
```
On authorize: create `GateAuthorization{questionId, nonce, expiresAt(+4 s), contextVersion}` → trigger the agent turn with a **control message** `sendUserMessage("⟦ctl:<nonce>⟧")`.
**Custom-LLM wrapper invariant:**
```
if (!validAuthorization(nonce, contextVersion)) return skip_turn
else stream the precomputed question text (Sonnet may rephrase within a ≤25-word schema; it may not change the question's target)
```
Every expert speech turn that arrives with no authorization ⇒ `skip_turn`. `turn_eagerness: patient` and `sendUserActivity()` (≈2 s hold) are supplemental, never the enforcement.
**Provenance:** control messages are recorded as `system_control` and are filtered out of evidence, transcripts shown to users, and the Work Map.
**Positive responsiveness:** the gate must authorize within 250 ms of conditions becoming valid; first-audio latency measured separately.
**HUD (judge view):** LISTENING · Typing ✓wait · Speaking ✓wait · Screen moving ✓wait · Question value ███ 0.83 → ASKING · "Reason: contradiction detected · EIG 0.61 bits". An **Engineering view** toggle shows full telemetry.

### 7.3 Hypothesis engine
**Hypothesis space (two sources):**
- **A. Deterministic enumerator** over typed features in `DecisionContext`: single conditions (`f > t`, `f ≥ t`, `f == v`, `f == true`, negations), thresholds at midpoints between observed values with different outcomes plus domain-meaningful round numbers, conjunctions up to 2 (optionally 3) conditions. Prior ∝ exp(−λ·complexity) (λ configurable).
- **B. LLM proposer (Sonnet 5.5)**: latent concepts the enumerator cannot invent ("missing asset number", "supplier relationship age"). A new concept becomes a feature only after expert confirmation (§6.6).
**Likelihood:** `P(a | h) = 1 − ε` if h predicts a, else `ε/(|A|−1)`; `ε = expertNoisePrior` (configurable heuristic; calibrated on Apprentice-Bench, labelled as heuristic otherwise).
**Surprise:** `P(observed a) = Σ_h w_h · P(a|h)` over the decision family's HypothesisSet; `surprise = −log₂ P(a)`.
**Expected information gain** for question q with answers a:
`IG(q) = H(W) − Σ_a P(a|q) · H(W | a, q)`; computed equivalently as mutual information `I = H(A_q) − Σ_h w_h H(A_q | h)` (cheaper; identical value).
**Question types:** ACTA why-probes (when no candidates exist yet), counterfactual cases (current case with one feature moved across a candidate threshold — must satisfy `domainConstraints`), concept-definition probes ("what counts as *new*?").
**Never ask what the screen answers** (check `DecisionContext` first).
**Answer parsing:** Sonnet maps the answer to: surviving candidates, a stated rule (becomes an `expert_statement` candidate with quote/timestamps), exceptions, new concepts. Promotion to `ConfirmedRule` requires evidence + (expert confirmation in debrief or explicit statement).

### 7.4 Voice layer (ElevenAgents) — conceptual config, re-validate against installed SDK types
- Interviewer: `llm: "custom-llm"` → `/api/llm` (OpenAI-compatible SSE; strip `elevenlabs_extra_body`; buffer words for latency), `built_in_tools: skip_turn, language_detection, end_call`, `turn_eagerness: "patient"`, `tts.model_id: "eleven_v3_conversational"`, `expressive_mode: true`, `asr.provider: "scribe_realtime"` with domain keywords.
- Tutor: same wrapper; different authorization policy (guardrail interventions authorize immediately — safety overrides politeness).
- Client tools: `set_off_record`, `replay_moment`, `highlight_field`, `show_gap`, `confirm_rule`, `ask_prediction`, `record_outcome`.
- Auth: server mints WebRTC conversation token (`GET /v1/convai/conversation/token?agent_id=`).
- Agents created/updated by script from versioned JSON.

### 7.5 Debrief & counterexample closure
1. Gap sources: queued live questions · unexplained decisions · undefined concepts · Z3 witnesses · low-confidence critical events.
2. **Z3 encoding:** features with domain bounds + `domainConstraints`; unknown modelled with `known_f` booleans where relevant.
   - *Unresolved*: valid assignment where no terminal decision rule in a family fires.
   - *Conflict* (precise): two rules of **equal priority, neither overriding the other**, in the same family, with **incompatible terminal effects** on the same valid assignment. Guardrails overriding decisions are **not** conflicts.
   - *Boundary*: witnesses at/near thresholds.
3. ≥3 follow-up questions from witnesses, phrased plainly.
4. **Teach-back:** Opus writes ≤60 s prose **from confirmed rules only**; agent speaks; corrections become rule revisions (diff animates, `revision++`, solver reruns). The demo includes one deliberate correction.
5. **Stop criterion (labelled "Coverage under current model"):** observed decisions explained N/N · unresolved witnesses 0 (or explicitly marked "expert: escalate to controller") · undefined concepts 0 · teach-back confirmed. UI sentence: *"No unresolved counterexample exists under the current feature model."*

### 7.6 Work Map (built by code)
Canonical Work Map is constructed deterministically from confirmed rules, ledger, evidence and steps. LLMs only title steps and write summaries.
Views: timeline with redacted thumbnails · step cards (screen moment, decision, reason quote + ▶ clip, guardrails) · rule graph · coverage panel · **lineage trace** (Frame → ScreenEvent → Decision → Candidate → Question → Answer → ConfirmedRule → TutorIntervention).
Exports: **Work Map JSON (core)**; **MCP `check_action` (primary agent export)**; **ElevenLabs Procedure (sponsor export)**. DMN / Cedar / Claude Skill / Markdown SOP are optional team-approved extras, each deterministic or round-trip validated.

### 7.7 Tutor
- Same perception on the novice screen; DOM channel in CaseDesk (disclosed).
- **Predict-then-reveal** at decision nodes not yet mastered.
- **Guardrail monitor** on every context update (three-valued). Violation or `insufficient_information` on a stop-rule ⇒ immediate spoken intervention + `replay_moment` of the expert.
- **Save interlock (deterministic):** Save → `checkAction(context, proposedAction)` → `allow` commits; `forbid` blocks; `needs_approval`/`insufficient_information` require acknowledgement or escalation. *The novice cannot commit an action that violates a confirmed stop-rule without acknowledgement or escalation.*
- **Mastery ladder (default, transparent):** untested → assisted → independently correct once → correct at a boundary case → mastered. BKT optional, labelled "heuristic estimate" unless calibrated.
- **Unseen practice cases:** Z3 generates valid boundary cases for the weakest rules; judges can also enter their own.

### 7.8 Trust & privacy (accurate claims only)
- **Off the record** (voice phrase or button): stop frame capture · `setMicMuted(true)` immediately · cancel queued uploads · `privacyEpoch++` (server rejects stale uploads) · suppress local evidence capture · red banner. Resume: unmute, new epoch.
  Claim: *"Off-record content is prevented from entering our evidence store; microphone and frame transmission are disabled while off the record."* The trigger phrase itself may reach the voice provider. ElevenLabs retention is configurable per conversation (default 2 years; deletion is whole-conversation; Zero Retention Mode is Enterprise) — we set a short retention on our agents and say so.
- **PII:** best-effort client-side redaction; the hackathon sandbox is fully synthetic — that is the real privacy guarantee for the demo.
- **Expert sign-off** per rule; evidence deletable by the expert.

### 7.9 Agent export
`check_action(context, proposedAction) → GuardrailResult` over confirmed rules, served as an MCP server (Streamable HTTP). 10-second demo: a Claude agent on the same unseen case is blocked with the expert's quote. No agent framework building beyond that.

### 7.10 Two experts (stretch)
Align sessions; encode both rulebooks; Z3 searches a valid case where they disagree; ask each expert; resolution becomes a revision with both quotes.

### 7.11 Any language (stretch)
Scribe realtime + `language_presets`/`language_detection`; rules language-neutral; quotes stored original + translation.

---

## 8. CaseDesk sandbox
Domain-pluggable back-office app (`/sandbox`), realistic ERP look. Each domain ships `domain.public.ts` (features, actions, decision families, domain constraints, critical fields, case generator) and `domain.oracle.server.ts` (hidden policy; **server/bench only**; a build test fails if it appears in any client bundle or model prompt).
Domain options (D1):
- **Synthetic KYC — "Northstar Bank Synthetic Review Policy"** (fictional thresholds; designed hidden interactions: threshold, exception, escalation, missing-data condition, multi-factor conjunction). Never presented as real law.
- AP invoices (brief's running example; likely common among teams).
- Insurance claims.
- Team's own real workflow on fake data.

---

## 9. Apprentice-Bench (non-circular)
- **Oracle:** `HiddenPolicy.evaluate(case)` is a deterministic program. Counterfactual questions are answered by evaluating the oracle on the case; why-questions return the fired rule IDs. An LLM may **verbalize** the oracle's structured answer (with controllable vagueness) but cannot change it.
- **Strategies:** (A) record-only, (B) generic why every step, (C) ACTA templates, (D) ours (surprise + EIG + Z3).
- **Metrics:** behavioural fidelity on N valid held-out cases (learned policy vs oracle action accuracy) · guardrail recall · **unsafe false-negative rate** · Z3 logical equivalence for simple recovered rules · questions asked · interruptions.
- **Money chart:** unsafe error rate vs number of expert questions, per strategy.
- **Human testers (n=2–3):** usability evidence only, reported as "internal demonstration, not a powered learning study".
- ElevenLabs voice regression tests use the current **Agent Testing APIs** (`/v1/convai/agent-testing/create`, `/v1/convai/agents/{id}/run-tests`); the old `simulate-conversation` endpoint is deprecated and removed 31 Oct 2026.

---

## 10. Demo script (~3 min) + compliance strip
Persistent strip: **Live questions 3/3 · Guardrail ✓ · Debrief gaps closed 3/3 · Teach-back ✓ · Unseen case intercepted ✓**
1. 0:00 Hook — the brief's Sabine/Lena problem; "Recorders capture what happened."
2. 0:10 Capture — expert works 3 cases; HUD waits; on a contradiction: "You sent this one to enhanced review but not the last — was it the ownership share or the jurisdiction?" (show all three questions fast, highlight the best).
3. 1:05 Debrief — Z3 witness ("existing customer, high-risk country, verified source of funds — enhanced review?"); teach-back; **expert corrects the AI**; rule diff; solver reruns; "No unresolved counterexample under the current feature model."
4. 1:50 Work Map — click guardrail → frame + clip + lineage animation.
5. 2:05 Teach — unseen case; novice picks wrong outcome; tutor intervenes; Save interlock; replay; mastery ladder.
6. 2:40 Agent — MCP `check_action` blocks a Claude agent with the expert's quote (10 s).
7. 2:50 Proof + moonshot — benchmark chart; "A verified organisational judgment layer: every human and every agent decides routine cases from the same expert-approved rulebook." *LLMs infer. Experts confirm. Code enforces.*
**Verified replay mode** (labelled) replays a genuine prior run through the same UI if the network fails; the live unseen-case tutor is still attempted.

---

## 11. Build sequence

**Decisions (team; Claude Code reads them from the bootstrap prompt):** D0 name · D1 domain · D2 voice brain A/B · D3 tutor DOM sensing (disclosed) · D4 stretch goals & optional exports · D5 deploy target (affects P0b) · D6 acceptance thresholds (confirm defaults below before P2).

| Phase | Deliverable | Acceptance (defaults — team confirms in D6 before P2) |
|---|---|---|
| **P0a** local foundation | pnpm monorepo, shared types + zod schemas, ledger, SQLite/Drizzle, env validation, domain-config parser, Kleene evaluator, tests | `pnpm test` green; evaluator truth tables pass; oracle-not-in-client-bundle test exists |
| **P0b** integration | Deploy target, agents created by script, token endpoint, custom-LLM endpoint reachable externally, `pnpm preflight` | preflight all green (see §12) |
| P1 CaseDesk | Chosen domain, case generator, public/oracle split, DOM events, Save button wired to interlock stub | 3 cases processable by hand; Playwright smoke |
| P2 Perception | Change detector, privacy pass, ordered queue, Haiku extraction, ticker | On recorded fixture: **critical field-change recall ≥ 0.95, critical action recall ≥ 0.95, false critical rate ≤ 0.05, non-critical F1 reported, p95 frame→event ≤ 3 s**; stale responses never applied (test) |
| P3 Voice + gate | Interviewer via custom LLM, authorization/nonce, skip_turn invariant, HUD | **0 interruptions** across 5 scripted typing/talking runs; **authorization ≤ 250 ms** after conditions valid; first-audio p50/p95 reported; control turns never in evidence (test) |
| P4 Hypothesis engine | Enumerator + LLM concepts, surprise, EIG, answer parsing, promotion | From 3 training cases (any domain): ≥1 threshold rule, ≥1 guardrail/exception, ≥1 unresolved concept surfaced; every promoted rule passes evidence validation |
| P5 Debrief + Work Map | Z3 witnesses with domain constraints, precise conflict semantics, teach-back + correction, code-built Work Map, lineage | No unresolved witness under current schema · all observed decisions explained · ≥3 debrief questions · teach-back confirmed with ≥1 revision applied |
| P6 Tutor | Predict-then-reveal, guardrail monitor, Save interlock, mastery ladder, Z3 practice cases | Interlock blocks 100% of violating commits in test suite; spoken intervention occurs before Save in scripted run; unseen case handled |
| P7 Trust | Off-record epoch, mic mute, upload cancel, PII pass, sign-off | Off-record frames/utterances absent from our stores (test); stale-epoch uploads rejected |
| P8 Exports | Work Map JSON, MCP `check_action`, ElevenLabs Procedure (+ optional extras per D4) | Agent blocked with expert quote; exports round-trip against source rules |
| P9 Bench | Oracle, 4 strategies, metrics, chart | Reproducible `pnpm bench`; chart generated |
| P10 Stretch | Per D4: two experts / multilingual | Disagreement witness shown / Hindi→English run |
| P11 Story | Verified replay mode, demo + tech videos, deck | Replay labelled and sourced from a real run |

Parallel tracks: (1) CaseDesk + perception · (2) voice, gate, tutor UI · (3) hypothesis engine, Z3, Work Map · (4) bench, exports, preflight, replay, video.

---

## 12. Reliability engineering
- **`pnpm preflight`:** Anthropic call + structured output · ElevenLabs agents exist · conversation token · custom-LLM URL reachable from the public internet · `skip_turn` honoured by custom-LLM path · TTS session starts · DB and `/data` writable · Z3 initialises · sandbox route up · mic/screen permission checklist printed.
- **Verified replay mode** from genuine stored runs.
- **Ledger-based debugging**: every UI element can show its trace.

## 13. Risks
| Risk | Mitigation |
|---|---|
| Model-chosen timing unreliable (OmniPro online F1 20.9%) | Deterministic gate + authorization nonce |
| Custom-LLM latency | Precomputed questions; stream immediately; buffer words |
| Vision can't outrun a fast Save | DOM-sensed intervention + deterministic Save interlock (disclosed) |
| LLM picks the wrong hypothesis space | Enumerated baseline space + complexity prior; LLM only adds concepts |
| False "contradictions" from overrides | Effect types, priority, override edges in Z3 conflict query |
| Nonsense counterfactuals | `domainConstraints` on every witness |
| New concept invalidates coverage | Schema versioning + backfill + Unknown |
| Stale vision responses | frameSeq, single in-flight, coalescing |
| Provenance contamination from control messages | `system_control` source, filtered everywhere |
| Overclaiming privacy | Accurate off-record semantics; best-effort PII; synthetic data |
| SDK drift | Installed types + docs override this plan; `docs/api-notes.md` |

## 14. Moonshot
Now: one expert → verified rulebook → tutor + agent guardrail. Next: **Company Memory** (every expert, one rulebook that stays current; when work changes, ask only about what's new) → **always-on apprentice** (notices never-seen cases during normal work) → **the verified organisational judgment layer** for humans and agents, audit-ready. Cross-company aggregation is a distant, opt-in idea, not the pitch.

## 15. API notes (verified 3–4 Oct 2026; installed types and official docs override)
**ElevenLabs:** `@elevenlabs/react` v1.x (`ConversationProvider`, `useConversation`, `useConversationClientTool`) · session `{conversationToken, connectionType:"webrtc"}` · `sendContextualUpdate` (background, no interruption) · `sendUserMessage` (literal user turn — treat as control traffic) · `sendUserActivity` (~2 s hold) · `setMicMuted` · callbacks `onVadScore`, `onModeChange`, `onMessage` · token `GET /v1/convai/conversation/token?agent_id=` · create `POST /v1/convai/agents/create` · `turn_eagerness` patient|normal|eager, `turn_timeout` 1–30 s · `tts.model_id: eleven_v3_conversational`, `expressive_mode` · `asr.provider: scribe_realtime` · system tools `skip_turn`, `language_detection`, `end_call` · custom LLM `llm:"custom-llm"`, `custom_llm:{url, model_id, api_key, api_type}`, SSE, OpenAI function calling, strip `elevenlabs_extra_body` · Procedures under `/v1/convai/agents/{id}/branches/{branch_id}/procedures` · **testing: `/v1/convai/agent-testing/create` + `/v1/convai/agents/{id}/run-tests` (simulate-conversation deprecated, removed 31 Oct 2026)** · post-call `GET /v1/convai/conversations/{id}` (+`/audio`) · retention configurable (default 2 years, whole-conversation deletion; Zero Retention Mode = Enterprise) · Agents $0.08/min. SDK `Llm` enum lacks `claude-sonnet-5-5` (custom LLM sidesteps this).
**Claude:** `claude-opus-5-5` ($4/$20) · `claude-sonnet-5-5` ($2/$10) · `claude-haiku-4-5-20251001` ($1/$5) · vision tokens ≈ ⌈w/28⌉×⌈h/28⌉, standard long edge ≤1568 px · structured outputs `output_config.format = {type:"json_schema", schema}` · prompt caching `cache_control` (min 512 tokens Opus/Sonnet 5.5; 4,096 Haiku 4.5) · Agent SDK `@anthropic-ai/claude-agent-sdk`.

## 16. Sources
Market: skan.ai · getabstract.com/en/productivity/tacit · guidde.com/knowledge-hub/challenges-of-ai-for-sops · venturebeat.com (Guidde) · globenewswire.com (Scribe Series C) · userlane.com/platform-overview · medium.com/cathay-innovation (Skan Series C) · minded.com/blog/train-ai-agent-recording-screen · getknoa.com · ycombinator.com/companies/ontora · aws.amazon.com blogs (Automated Reasoning checks; AgentCore Policy).
SOTA: arXiv 2405.03710 · 2409.15867 · 2409.07429 · 2504.13805 · 2603.25864 · 2605.18577 · 2410.12361 · 2310.11589 · 2402.03271 · 2508.21184 · 2606.03135 · 2403.04651 · 1603.07466 · 2412.16429 · 2509.02544 · daily.co (Smart Turn v3.1) · livekit.com/blog/solving-end-of-turn-detection · nature.com/articles/s41598-025-97652-6 · blogs.worldbank.org (Nigeria) · github.com/microsoft/presidio · huggingface.co/nvidia/gliner-PII · anthropic.com/news/claude-sonnet-4-5.
APIs: elevenlabs.io/docs/agents-platform/* · elevenlabs.io/docs/api-reference/agents/simulate-conversation (deprecation notice) · elevenlabs.io/docs/agents-platform/customization/privacy/retention · github.com/elevenlabs/packages · platform.claude.com/docs (models, vision, structured outputs, prompt caching) · code.claude.com/docs/en/agent-sdk/typescript.
Brief: Hack-Nation × ElevenLabs "The AI Apprentice".