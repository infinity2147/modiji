# Verified replay mode (P11)

Plan §10: *"Verified replay mode (labelled) replays a genuine prior run through the same UI if the network fails; the live unseen-case tutor is still attempted."* Plan §12: verified replay from genuine stored runs. Bootstrap rule: never mock conclusions.

## What it is

- A **run bundle** is an immutable snapshot of a genuine recorded run. It holds the complete ledgers of a set of linked sessions (expert capture + debrief, novice/tutor), the redacted frames those ledgers reference, and recorded conversation audio only when the voice provider still has it (`--audio`). Nothing is synthesised. Whatever is unavailable is listed in the manifest's `missing`, with the reason.
- **Replay mode** (`/replay/<bundleId>`, index at `/replay`) re-renders the run through the same UI components:
  - CaseDesk queue, case file and review panel;
  - the tutor's predict/reveal/intervention cards and mastery ladder;
  - the debrief (coverage, teach-back, Z3 witnesses, rulebook diff);
  - the Work Map;
  - the judge view's HUD, event ticker and compliance strip.

  A virtual clock drives all of these: play, pause, seek by entry, and speed from 0.5× to 32×. Idle gaps longer than 2.5 s are shortened by default; this can be switched off for real time, and entry order is never changed.
- A persistent violet banner reads: `VERIFIED REPLAY — recorded run <id> from <host> at <time> UTC; integrity ✓ (<n> entries, chain <12 hex>)`. It also states "not live: nothing is written, no model or voice call", and has a **Try live** link to `/sandbox`.

## Bundle format (`apps/web/lib/replay/format.ts`)

```
<DATA_DIR>/replays/<bundleId>/
  manifest.json                      format vashistha.replay/1 (the only file not listed in `files`)
  ledger/<sessionId>.json            { sessionId, entries }: every entry, sequence 0..n-1, exactly as GET /ledger returned it
  cases/<sessionId>.json             GET /api/cases?set=&session= at export
  views/<sessionId>.debrief.json     GET /debrief at export (expert sessions): used for the end-of-run cross-check
  views/<sessionId>.tutor.json       GET /tutor at export (novice sessions): used for the end-of-run cross-check
  media/<sessionId>/frames/<id>.png  redacted frames referenced by frame.received entries
  audio/<conversationId>.mp3         only with --audio, and only if ElevenLabs still has it
```

The manifest records:
- the source (`baseUrl`, plus `version` and `commit` from `GET /api/health`);
- the exporter's git commit;
- each session's mode, case set, expert, entry count, first and last time, and conversation ids;
- the timeline;
- `files` (sha256 and size of every file);
- `missing`.

## Integrity scheme

- **File hashes.** Every file except `manifest.json` is listed with its sha256 and size.
- **Hash chain.** The chain runs over all entries of all sessions, in timeline order: `receivedAt`, then `sessionId`, then `sequence`. This is the order the server's rulebook store folds rule events in.
  - `link_0 = sha256("vashistha.replay/1")`
  - `link_i = sha256(link_{i-1} ‖ canonicalJson(entry_i))`
  - Links are lower-case hex, concatenated as UTF-8. `canonicalJson` sorts keys recursively, so the chain does not depend on key order.
  - The manifest stores the genesis and the head.
- **Bundle id.** The id is `yyyymmdd-hhmm-<first 12 hex of the head>` (UTC time of the first entry), so an id names exactly one recorded history.
- **Out-of-band pin.** `--manifest-copy docs/replay` writes `<id>.manifest.json`, which contains the manifest and its sha256. That small file is what gets committed for the demo bundle.
- **Re-verification on every load.** `GET /api/replays/:id` re-reads every listed file and re-hashes it. It then parses every ledger file entry by entry (strict schema, contiguous sequences), recomputes the chain, and compares the head.
  - On any mismatch the response is `409 integrity_failed` with the reason (for example `media/…/x.png: sha256 mismatch (file altered after export)` or `hash chain mismatch`).
  - The page then refuses to play and shows that reason. No views or media are served for the bundle until it verifies again.
  - Media files are also re-hashed on every read.
- **Immutability.** Bundles are written to a temporary directory and renamed into place. An existing bundle is never overwritten.

## Honesty: how the views are derived

- **Ticker and compliance strip.** These come from the live client functions (`tickerLines`, `computeCompliance`) over the recorded prefix.
- **CaseDesk.** It uses `summariseLedger`, the fold the live CaseDesk resumes from, plus the recorded DOM-channel and tutor entries: case opened, rating edits, outcome selected.
- **Debrief, Work Map and tutor.** These use the live server code (`snapshot` + `debriefState`, `readOnlyWorkMap`, `tutorState`).
  - The code runs over a scratch in-memory SQLite that holds exactly the first n recorded entries, verbatim.
  - The rulebook is composed by the same store functions as `runtime-init.ts`.
  - The ledger handed to these derivations refuses every write, and there is no model client.
  - Z3 runs as it does live; it is deterministic code, not a model.
  - Work Map step titles and the summary are the labelled deterministic templates, because no model is called.
- **HUD.** It is derived from the recorded gate entries:
  - WAITING when a question is queued;
  - ASKING after `gate.authorized`, with the condition snapshot recorded at that moment;
  - LISTENING after the expert answers.

  The live activity timings (typing, speech and screen countdowns) are deliberately not recorded, and the HUD says so: "Typing · Speaking · Screen: not recorded".
- **Splitting one request's writes.** A position can fall inside entries one request appended together (same session and trace id, for example an intervention before its queued question). No live reader ever saw that state, so the server views run to the end of that write. The status line says `views derived from entries 1–m (end of that recorded write)`.
- **End-of-run cross-check.** At the end of the timeline, the replay compares its derivation with the views the live server returned at export. A mismatch is shown, not hidden.
  - **Debrief fields compared:** coverage, rulebook revision, gaps, decisions, teach-back.
  - **Tutor fields compared:** rules, levels, cases.
- **Rules from outside the bundle.** If the live rulebook held rules confirmed in sessions outside the bundle, the export warns and records it in `missing`. The fix is to add those expert sessions to `--sessions`.

## Commands

The export uses only public read APIs, and prefers IPv4. It sends the bearer (`CUSTOM_LLM_SECRET`) only if a route answers 401. It refuses to export if the run grew while it was being exported.

```sh
pnpm replay:export --base https://vashistha-production.up.railway.app \
  --sessions <expertSessionId>,<noviceSessionId> \
  --out apps/web/data/replays \
  --manifest-copy docs/replay \
  [--audio]
```

Relative paths resolve from the directory `pnpm` was started in. `apps/web/data/` is gitignored, and it is the default `DATA_DIR=./data` of a local server started from `apps/web`.

To replay offline, start the local production server and open `http://localhost:3000/replay/<bundleId>`:

```sh
pnpm --filter @vashistha/web build && cd apps/web && NODE_ENV=production npx tsx server.ts
```

To put a bundle on the deployed server, use the guarded import:

```sh
pnpm replay:import --base https://vashistha-production.up.railway.app --bundle apps/web/data/replays/<bundleId>
```

The import:
- verifies the bundle locally first;
- uploads every file to `PUT /api/replays/<id>/import/<path>` with `Authorization: Bearer $CUSTOM_LLM_SECRET`;
- calls `POST /api/replays/<id>/import`, where the server re-verifies hashes and the chain, then moves the bundle into `DATA_DIR/replays` (`422 integrity_failed` otherwise);
- never replaces an existing bundle (`409`).

## Tests and evidence

- `apps/web/test/server/replay.test.ts`:
  - hash-chain definition and determinism;
  - export → bundle → verify;
  - immutability;
  - one byte changed in an entry → refused by file hash;
  - an entry changed and its hash forged → refused by the chain;
  - one byte changed in a frame → refused, and the frame is no longer served;
  - **parity:**
    - the replayed debrief equals the live `GET /debrief` (coverage included) and cross-checks;
    - the replayed tutor view, ticker lines, compliance strip and CaseDesk equal the live ones, at the end and at the moment of the intervention;
  - the derivation's ledger refuses writes.
- `apps/web/test/client/replay.test.ts`: the virtual clock, the HUD from recorded gate entries, and follow focus.
- `apps/web/e2e/replay.spec.ts`:
  1. A genuine run is made on the local production server through public APIs (LLM_CALLS=off).
  2. `pnpm replay:export` exports it.
  3. The replay page shows the banner with integrity ✓.
  4. Play, seek and speed work, with the ticker and strip in step.
  5. The intervention, debrief and Work Map are shown.
  6. One byte of a frame is tampered → refused with the reason; once restored, it plays.

  Screenshots are in `docs/evidence/p11/replay-*.png`.
