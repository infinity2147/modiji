Superseded P3 attempts of the 2026-10-04 re-run. They are not counted. Every one was a real session on production
(build f317447). All expert speech is synthetic voice input (ElevenLabs TTS). Rules confirmed in these sessions are in the
shared production rulebook, because the ledger is append-only.

Before the re-run: no trace of the earlier, interrupted attempt. There was no rerun-* directory and no Playwright output,
the production rulebook was still at revision 23, and the ElevenLabs interviewer agent had no conversation after the
preflight at 03:15:28Z. That interrupted attempt therefore never started a conversation.

attempt-1-runner-0403Z (Playwright started 04:03:55Z)
  run A, session 2bbcae60-0e66-4155-a8dc-d869c0925b5a, conv_4501m42hagtmfn9v0sc2v2p2bvzs. Harness defect.
    - The production rulebook now holds "PEP → require_approval(compliance_officer)" (rule_0db2a2b89d2203, from the
      earlier live P4 run). It applies to every outcome of the family, so Save on NS-2026-0103 ("Escalate to compliance
      officer") opened the interlock dialog.
    - The harness threw on any interlock dialog (playwright-error-context.md).
    - Fix, test-side only (support/expert.ts): for escalateCompliance with "Approval required", type a note and press
      "Escalate", as an expert would.
  runs B–E of this runner kept running. My stop command (pkill -f) killed its own shell before it reached Playwright, so
  this runner continued with the old harness and overlapped attempt 2. Operator error. Its sessions:
    - B c4286c22-2a9c-4c99-98ab-dcffb6ed2496 (conv_4401m42hfshaec9vfd9fp6hwvgfs);
    - C 90e3317d-da67-4283-a880-61cc3a86ac4c (conv_7801m42hm0jhf1ess2375h18dkan: ElevenLabs "custom_llm generation
      failed"; run then hit the same interlock);
    - D ffff6162-5935-4a57-8f0a-0eac60ce050a (conv_4501m42hqf1fff7avgx1zqv4fwpy);
    - E 5fdd0e97-ebed-47c9-9b69-7bac3b989f54 (conv_8101m42hrm04e4vs0q0yrtghcaa6): completed, 0 interruptions,
      6 authorizations of which 1 lapsed and was re-queued, 5 spoken. Its files are kept here.
    The ledgers and ElevenLabs transcripts are in this folder.

attempt-2-runner-0409Z (Playwright started 04:09:08Z, with the harness fix; overlapped attempt 1 from 04:09 to ≈04:15)
  run A, a2860d2f-2fc2-45d6-9a81-97e58813c62b (conv_8601m42hm278fe0977g41jxs0s5z): Save failed with "Request
    refused (502 http_502)". The failing request was POST /api/sessions/:id/events, the DOM-event flush, which the Railway
    edge answered with 502 after 6.8 s (trace, x-railway-edge cdg1).
  run B, 76329d42-8b5b-4724-bb65-ad34f2546b83 (conv_6001m42hnf20fq69fs9e4rb6y0dv): Save failed the same way. The
    /events POST got 502 after 13.0 s, and a frames POST got 502 after 12.4 s. The ElevenLabs conversation failed with "custom_llm generation failed".
  During both runs, production requests took 6–20 s. GET /api/health/deep then reported eventLoop.maxMs 12774 (04:10:44Z)
  and 13856 (by 04:12:40Z); at preflight it was 1015. See ../../BUGS.txt R1.
  run C, b5d8fd71-41f7-4dca-815d-85edcb85799b (conv_8301m42hq3a2e2tbhrs5pc33rp4k): completed; files kept here.
  run D, 15c1854d-3b2f-49f6-8f86-1e1e92752cb9 (conv_9601m42hw4gsfmvbrqnbcsfnjkz2): killed by me at ≈04:15Z, when I found
    and killed both orphaned runners by PID.
  The playwright-error-context-*.md files come from the shared outputDir. Runs C/D/E there may belong to either runner.

None of these runs is in the counted results. The clean run (../, 04:17–04:35Z) was the only live runner on this
machine, verified with ps before starting.
