# syntax=docker/dockerfile:1
# One persistent Node service (plan §5, D5): Next.js behind the custom server in apps/web/server.ts.
# SQLite and media live on the volume mounted at /data. Build context: the repo root.

# Same Node (and so corepack 0.36) the repo is developed and verified on.
FROM node:22.23.3-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable pnpm && corepack install --global pnpm@12.8.1
WORKDIR /app

FROM base AS build
# CI=true: non-interactive pnpm (the prod prune below may recreate node_modules without asking).
ENV CI=true
# Fetch depends on the lockfile alone, so this layer stays cached until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# pnpm-workspace.yaml `allowBuilds` decides which dependency build scripts run (esbuild, better-sqlite3).
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @vashistha/web build
# Reinstall production dependencies only (typescript, eslint, vitest, tailwind, drizzle-kit, ... gone;
# ~610 MB -> ~460 MB, most of the rest is next + its SWC binary) and drop Next's build cache.
# node_modules is removed first because `install --prod` over a full install leaves the virtual store intact.
# Runtime keeps the workspace sources: tsx compiles server.ts and the TypeScript workspace packages on start.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --offline --frozen-lockfile --prod \
  && rm -rf apps/web/.next/cache

FROM node:22.23.3-bookworm-slim AS runtime
# HOME: setpriv keeps the environment, and root's home is not writable by `node`.
ENV NODE_ENV=production DATA_DIR=/data NEXT_TELEMETRY_DISABLED=1 HOME=/home/node
COPY --from=build /app /app
# The app tree stays root-owned (read-only to the service user) except Next's runtime cache.
RUN mkdir -p /data /app/apps/web/.next/cache && chown node:node /data /app/apps/web/.next/cache
WORKDIR /app/apps/web
EXPOSE 3000
# Railway mounts volumes owned by root, so the entrypoint starts as root only to hand $DATA_DIR to
# the `node` user, then execs the server as `node` (setpriv ships in bookworm's essential util-linux).
# No pnpm in the chain: pnpm does not forward SIGTERM (api-notes §11). The tsx bin shim execs node,
# which relays SIGTERM/SIGINT to the server process for its graceful shutdown.
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p \"$DATA_DIR\" && chown node:node \"$DATA_DIR\" && exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"", "entrypoint"]
CMD ["/app/apps/web/node_modules/.bin/tsx", "server.ts"]
