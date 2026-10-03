# Perception fixtures (P2 evaluation)

A fixture is one recorded CaseDesk session: screenshots every 500 ms plus the DOM-channel events
the app emitted during the same session. `scripts/eval-fixture.ts` replays the screenshots through
the perception pipeline and scores the vision events against the DOM events (plan §11 P2).
Fixtures contain synthetic CaseDesk data only; never record a real screen.

## Layout

```
<fixture-dir>/
  fixture.json
  frames/000001.png
  frames/000002.png
  …
```

## `fixture.json`

Validated by `FixtureSchema` in `src/evaluation.ts`. Unknown keys are rejected.

```jsonc
{
  "version": 1,
  "domainId": "kycNorthstar",        // KYC_DOMAIN.id; the only domain the script supports today
  "sessionEpoch": 0,                 // the session's privacy epoch; one epoch per fixture
  "frames": [
    { "frameSeq": 1, "captureTime": 1790000000250, "file": "frames/000001.png" }
  ],
  "domEvents": [ /* ScreenEvent[] */ ]
}
```

### `frames[]`

| field | rule |
|---|---|
| `frameSeq` | 1, 2, 3, … strictly increasing (the capture index). The pipeline assigns its own queue frameSeq; this one only orders the files. |
| `captureTime` | Epoch ms from `Date.now()` in the Playwright (Node) process, read immediately before `page.screenshot()`. Strictly increasing. |
| `file` | Path relative to the fixture directory, ending `.png`, no `..`, no leading `/`. |

Screenshots:
- `page.screenshot({ type: "png" })` of the viewport (not `fullPage`). Playwright's defaults
  (caret hidden, 8-bit RGB/RGBA, non-interlaced) are what the decoder supports.
- Fixed viewport for the whole session (e.g. 1440×900, `deviceScaleFactor: 1`), with the Review
  panel (risk rating, outcome) visible without scrolling.
- One screenshot every 500 ms on a fixed-rate schedule. Write every capture, including ones where
  nothing changed: the change detector decides what is sent, as it does live. If a screenshot
  takes longer than the interval, skip the missed ticks; don't let the schedule drift.

### `domEvents[]`

Every `ScreenEvent` the CaseDesk DOM channel sent during the recording, exactly as sent, in any
order:
- `source: "dom"`, `confidence: 1`
- `sessionEpoch` equal to the fixture's
- `captureTime` from the browser's `Date.now()`

The simplest capture point is the request body. Collect `JSON.parse(request.postData()).events`
from `page.on("request")` for `POST /api/sessions/:id/events`. Reading the ledger's `dom` /
`screen.event` payloads works too.

Frames and DOM events must be stamped by the same machine's clock. Run the browser and the
recorder on one host.

## How events are scored

- **Match:** a vision event matches a DOM event with the same `(kind, caseId, field or action, to)`
  (navigate: kind only) whose `captureTime` lies within `[dom − 1000 ms, dom + 5000 ms]`.
  Matching is one-to-one.
- **Critical:**
  - a `field_change` of a `criticalFields` member;
  - an `action` whose definition is `terminal`.

  Everything else is non-critical.
- **Thresholds** (plan §11, fixed in code as `P2_THRESHOLDS`):
  - critical field-change recall ≥ 0.95
  - critical action recall ≥ 0.95
  - false critical rate ≤ 0.05 (unmatched critical vision events ÷ all critical vision events)
  - p95 frame→event ≤ 3000 ms (capture → events applied)
- **Reported only:**
  - non-critical precision, recall and F1;
  - change→event latency (DOM event → matching vision event applied).

A metric with no data counts as FAIL.

## Recording script guidance

- Recall is only meaningful with enough critical events. With 20 of a kind, one miss is exactly
  0.95; aim for **≥ 40 risk-rating changes and ≥ 40 committed outcomes** across the case set.
- Pace actions like a reviewer (1–3 s apart). Include a few fast bursts (two edits within 500 ms)
  so coalescing happens.
- Keep a fixture to a single privacy epoch. Going off the record ends the fixture.

## Commands (from the repo root)

```sh
# live: needs ANTHROPIC_API_KEY (env or repo-root .env); replays in real time
pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/eval-fixture.ts <abs-or-apps/web-relative fixture dir> --out report.json

# harness check without a key: deterministic fake extractor on a simulated clock
pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/eval-fixture.ts ../../packages/perception/test/fixtures/synthetic-kyc --fake

# regenerate the tiny synthetic fixture (flat shapes, 48 frames, 13 DOM events)
pnpm --filter @vashistha/web exec tsx ../../packages/perception/scripts/make-synthetic-fixture.ts
```

Relative paths resolve against `apps/web`, because pnpm runs the script there.

The exit code is 0 if every threshold passes, 1 if any fails, and 2 on a usage or setup error.

`--fake` reads the DOM ground truth and adds seeded noise. It proves the harness and says nothing
about Haiku's accuracy.
