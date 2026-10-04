# Deploy — Railway (D5)

One persistent Node service built from the root `Dockerfile`, with one volume at `/data` for the SQLite
database and media. Exactly one instance: SQLite on a volume cannot be shared, and Railway does not
allow replicas on a service with a volume.

Service settings live in **`.railway/railway.ts`** (Railway Infrastructure as Code). There is no
`railway.json`: Config as Code is deprecated, new services cannot opt in, and existing files stop being
read on 2026-12-01 (docs.railway.com/infrastructure-as-code). The IaC SDK (`railway`) is a root dev dependency; the Railway **CLI** is installed separately (`npm i -g @railway/cli`, or the release binary on PATH as `railway`). It is not a repo dependency: its postinstall downloads a binary from GitHub on every install, which would add a failure point to the Docker build.

## Steps

1. **Create and link the project.**
   ```sh
   railway login
   railway init --name vashistha
   ```

2. **Apply the infrastructure** (service `vashistha`, volume `vashistha-data` at `/data`, Dockerfile
   builder, healthcheck `/api/health` with a 120 s timeout, restart On Failure, 1 replica, and
   `NODE_ENV`, `DATA_DIR` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`):
   ```sh
   railway config plan     # review
   railway config apply
   railway link            # pick service "vashistha"
   ```
   The volume is mounted as root. The image's entrypoint hands `/data` to the unprivileged `node`
   user before starting the server, so do **not** set `RAILWAY_RUN_UID`. The draining time matters
   because Railway's default is 0 s (SIGKILL right after SIGTERM), while the server drains for up to 10 s.

3. **Create the public domain.** Run `railway domain` and note the `https://…up.railway.app` URL.

4. **Set the secrets and URL from `.env.example`.** `.railway/railway.ts` marks them `preserve()`, so they are
   never written to the repo.
   - `NODE_ENV` and `DATA_DIR` are already set by the IaC file.
   - Do not set `PORT`; Railway injects it, and the healthcheck uses it.
   - Pass secrets on stdin so they stay out of shell history.

   ```sh
   railway variable set PUBLIC_BASE_URL=https://<domain>
   railway variable set ANTHROPIC_API_KEY --stdin    # paste, then Ctrl-D
   railway variable set ELEVENLABS_API_KEY --stdin
   openssl rand -base64 48 | railway variable set CUSTOM_LLM_SECRET --stdin
   ```

5. **Deploy.** Run `railway up` (builds the root `Dockerfile`). Wait until `/api/health` is
   healthy.

6. **Sync the ElevenLabs agents.** Run this locally, with a `.env` that has the same
   `PUBLIC_BASE_URL`, `ELEVENLABS_API_KEY` and `CUSTOM_LLM_SECRET`:
   ```sh
   pnpm agents:sync
   ```
   Set the agent ids it prints as `ELEVENLABS_INTERVIEWER_AGENT_ID` and `ELEVENLABS_TUTOR_AGENT_ID`
   with `railway variable set`. Each `set` triggers a redeploy.

7. **Run preflight** against the public URL:
   ```sh
   pnpm preflight
   ```
   It must be all green (plan §12). Never set `LLM_CALLS=off` on the service: that hermetic switch (used by
   the e2e suite) makes the server build no Anthropic client at all. Preflight catches it in two places:
   the `env` check fails if the local `.env` sets it, and `server-deep` fails unless the target's
   `/api/health/deep` reports `"llmCalls": "on"` (the only check that sees the deployed environment;
   `--target http://127.0.0.1:<port> --only server-deep` likewise fails a local server started with it off).

## Fresh demo ledger

Before the judged demo, the lead starts the service on an empty ledger, so the shared rulebook, the
expert directory and the session list hold only what the demo itself records. Nothing is deleted: the
ledger is append-only and the old data stays on the volume.

Why: production is at rulebook revision 23 — 23 confirmed rules, 9 distinct (BUGS #9, before rule
de-duplication existed). Those `rule.*` entries stay in the append-only ledger. The server now merges
identical rules (a re-confirmation by the same expert is a `rule.revised` of the existing rule; the team
rulebook view shows semantically identical rules of different experts once), but the demo should not
start from the test history.

1. **Export (and archive) the replay bundle of the live acceptance run first**, from the current
   ledger. A production export archives the sessions it exports by default (`--archive`; see
   `docs/replay.md`), so their ids — published in the bundle — can no longer write. It needs
   `CUSTOM_LLM_SECRET` in the local `.env`:
   ```sh
   pnpm replay:export --base https://vashistha-production.up.railway.app \
     --sessions <expertSessionId>,<noviceSessionId> \
     --out apps/web/data/replays --manifest-copy docs/replay
   ```
2. **Point `DATA_DIR` at a fresh directory on the same volume.** This redeploys; the entrypoint creates
   the directory and hands it to the `node` user, and the server migrates an empty database there:
   ```sh
   railway variable set DATA_DIR=/data/demo-$(date -u +%Y%m%d)
   ```
   The previous database, media and bundles stay untouched under `/data` (the old `DATA_DIR`).
3. **Wait for the deploy, then check it is empty and healthy:**
   ```sh
   curl -s https://vashistha-production.up.railway.app/api/health
   curl -s https://vashistha-production.up.railway.app/api/rulebook    # {"revision":0,"rules":[]}
   ```
4. **Import the bundle** into the new `DATA_DIR/replays` (bundles live in `DATA_DIR`, so the old ones are
   not served from the fresh directory):
   ```sh
   pnpm replay:import --base https://vashistha-production.up.railway.app --bundle apps/web/data/replays/<bundleId>
   ```
5. **Run `pnpm preflight`.** It must be all green.

To go back to the previous ledger, run `railway variable set DATA_DIR=/data` (another redeploy). Note
that `railway config apply` also sets `DATA_DIR=/data` (it is declared in `.railway/railway.ts`), so
applying the IaC file switches back to the old ledger too. Both ledgers share the 500 MB volume.
