# Deploy — Railway (D5)

One persistent Node service built from the root `Dockerfile`, with one volume at `/data` for the SQLite
database and media. Exactly one instance: SQLite on a volume cannot be shared, and Railway does not
allow replicas on a service with a volume.

Service settings live in **`.railway/railway.ts`** (Railway Infrastructure as Code). There is no
`railway.json`: Config as Code is deprecated, new services cannot opt in, and existing files stop being
read on 2026-12-01 (docs.railway.com/infrastructure-as-code). The Railway CLI and the IaC SDK are root
dev dependencies, so every command below is `pnpm exec railway …` and needs no global install.

## Steps

1. **Create and link the project.**
   ```sh
   pnpm exec railway login
   pnpm exec railway init --name vashistha
   ```

2. **Apply the infrastructure** (service `vashistha`, volume `vashistha-data` at `/data`, Dockerfile
   builder, healthcheck `/api/health` with a 120 s timeout, restart On Failure, 1 replica, and
   `NODE_ENV`, `DATA_DIR` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`):
   ```sh
   pnpm exec railway config plan     # review
   pnpm exec railway config apply
   pnpm exec railway link            # pick service "vashistha"
   ```
   The volume is mounted as root. The image's entrypoint hands `/data` to the unprivileged `node`
   user before starting the server, so do **not** set `RAILWAY_RUN_UID`. The draining time matters
   because Railway's default is 0 s (SIGKILL right after SIGTERM), while the server drains for up to 10 s.

3. **Create the public domain.** Run `pnpm exec railway domain` and note the `https://…up.railway.app` URL.

4. **Set the secrets and URL from `.env.example`.** `.railway/railway.ts` marks them `preserve()`, so they are
   never written to the repo.
   - `NODE_ENV` and `DATA_DIR` are already set by the IaC file.
   - Do not set `PORT`; Railway injects it, and the healthcheck uses it.
   - Pass secrets on stdin so they stay out of shell history.

   ```sh
   pnpm exec railway variable set PUBLIC_BASE_URL=https://<domain>
   pnpm exec railway variable set ANTHROPIC_API_KEY --stdin    # paste, then Ctrl-D
   pnpm exec railway variable set ELEVENLABS_API_KEY --stdin
   openssl rand -base64 48 | pnpm exec railway variable set CUSTOM_LLM_SECRET --stdin
   ```

5. **Deploy.** Run `pnpm exec railway up` (builds the root `Dockerfile`). Wait until `/api/health` is
   healthy.

6. **Sync the ElevenLabs agents.** Run this locally, with a `.env` that has the same
   `PUBLIC_BASE_URL`, `ELEVENLABS_API_KEY` and `CUSTOM_LLM_SECRET`:
   ```sh
   pnpm agents:sync
   ```
   Set the agent ids it prints as `ELEVENLABS_INTERVIEWER_AGENT_ID` and `ELEVENLABS_TUTOR_AGENT_ID`
   with `pnpm exec railway variable set`. Each `set` triggers a redeploy.

7. **Run preflight** against the public URL:
   ```sh
   pnpm preflight
   ```
   It must be all green (plan §12).
