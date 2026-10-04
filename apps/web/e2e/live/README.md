# Live acceptance runner (`@live`)

Playwright specs that drive the **deployed** service (production by default) with real ElevenLabs voice
over WebRTC, real Anthropic calls and the production ledger. They are not part of `pnpm test:e2e`
(`playwright.config.ts` ignores `e2e/live/**`) and they cost money: each run is a few minutes of agent
conversation plus the product's own Sonnet/Haiku calls.

All expert speech is **synthetic voice input (ElevenLabs TTS)**. Every artefact says so.

## Run

Credentials come from the repo-root `.env` (never printed). Node must prefer IPv4 on this network.

```sh
cd apps/web
export NODE_OPTIONS=--dns-result-order=ipv4first
npx playwright test -c e2e/live/playwright.live.config.ts --grep @smoke   # harness check, ~40 s
npx playwright test -c e2e/live/playwright.live.config.ts --grep @p3      # 5 gate runs, ~15 min
LIVE_P4_VARIANT=single-sentence+concept \
  npx playwright test -c e2e/live/playwright.live.config.ts --grep @p4    # P4, ~3 min
set -a; . ../../.env; set +a                                               # MCP_BEARER_TOKEN, ANTHROPIC_API_KEY
npx playwright test -c e2e/live/playwright.live.config.ts --grep @p8      # exports + MCP round trip
npx tsx ../../packages/mcp-guardrails/demo/agent-blocked.ts \
  --url https://vashistha-production.up.railway.app --case NS-2026-0201 --action approve   # live Claude agent
npx tsx e2e/live/support/summarize.ts                                      # docs/evidence/live/SUMMARY.*
```

`LIVE_BASE_URL` overrides the target. Evidence goes to `docs/evidence/live/`.

## How it works (test-side only; no product code is changed or hooked)

`support/harness.ts` is installed with `page.addInitScript` before the app loads:

- **Microphone**: `getUserMedia({audio})` returns a fresh `MediaStreamDestination` stream fed by one WebAudio
  bus. The test plays decoded TTS clips (and optional white noise) into it, so it knows exactly when the
  "expert" speaks.
- **Screen**: `getDisplayMedia` returns a canvas stream (as `e2e/perception.spec.ts`). The canvas shows
  synthetic text. Production vision reads it, and in one run it proposed junk concepts from it.
- **Instrumentation** by wrapping browser APIs only:
  - `RTCDataChannel.send` timestamps the control message `⟦ctl:…⟧` leaving the browser;
  - data-channel messages give `agent_response`, `user_transcript`, `vad_score` and audio events;
  - an `AnalyserNode` on the agent's remote WebRTC track gives the agent's audio on/off;
  - `fetch` times `gate/authorize` and utterance posts;
  - capture-phase `keydown`/`wheel` listeners are the ground truth for typing and scrolling;
  - the voice panel's "Agent speaking" text is the SDK mode.

  All timestamps are `Date.now()` in the page, the gate's own clock.
- **Typing**: CaseDesk has no free-text field in Expert mode. The test sets `tabindex=-1` on the case-file
  `<main>` (a DOM attribute, test-side) and types real keystrokes there.
- **Answers** (`support/answers.ts`): keyword rules over the question the agent *actually* asked plus the
  case just decided, following the synthetic policy's public narrative. P3 answers avoid "never …"
  wording, so the gate runs add no stop-rules to the shared production rulebook.

## Ground truth and metrics (`support/analyze.ts`)

- **Interruption**: a `gate.authorized.decidedAt` (from the ledger) or an agent audio onset (measured on
  the track) falls inside one of these half-open windows:
  - `[speech start, speech end + 1.2 s)`;
  - `[keystroke, +1.5 s)`;
  - `[wheel, +1.5 s)`.

  The windows are half-open because the plan's conditions are "≥ 1.2 s / ≥ 1.5 s". Talk-over (agent
  audio overlapping expert speech, either side first) is reported separately.
- **Authorization latency**: the ledger's `decidedAt − becameValidAt`. Also reported:
  - the `gate/authorize` round trip;
  - conditions valid → control message sent.
- **First audio**: control message sent → first agent audio on the track. Each control message is paired
  only with audio before the next control message. Also reported: the first audio event on the data
  channel, and the first `agent_response` text.
- **Control turns never in evidence**: no control text in any of these:
  - `utterance.transcript` or `agent.utterance`;
  - echoed `user_transcript`s;
  - posted utterances.

  In addition, every `gate.control_message` entry is `system_control`, and no rule evidence cites one.

Nonces in saved evidence are redacted (`support/report.ts`). `support/reanalyze.ts` re-derives a run's
summary from its saved JSON.
