# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Full node image (Debian bookworm) — it has the toolchain needed to compile the
# native modules (better-sqlite3, bcrypt) and to run the Vite client build.
FROM node:22-bookworm AS build
WORKDIR /app

# Install dependencies first for better layer caching. npm ci needs the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source, then build the React client into ./dist
# (Vite's default outDir — which is exactly where server.ts serves the UI from).
COPY . .
RUN npm run build

# Fetch the prebuilt agent binaries from the GitHub release into ./agent so the
# server can offer them as admin-only downloads. Bump AGENT_VERSION per release.
ARG AGENT_VERSION=v0.2.0
RUN mkdir -p agent && cd agent \
 && BASE="https://github.com/hollow-forge/nomyx/releases/download/${AGENT_VERSION}" \
 && curl -fL -O "${BASE}/nomyx-agent-win-x64.exe" \
 && curl -fL -O "${BASE}/nomyx-agent-linux-x64" \
 && curl -fL -O "${BASE}/nomyx-agent-linux-arm64"

# ── Runtime stage ────────────────────────────────────────────────────────────
# Slim base, same bookworm + Node 22 as the build stage, so the native binaries
# compiled above stay ABI-compatible. Nothing compiles here, so no build tools.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring over everything the builder produced: the installed-and-compiled
# node_modules, the built ./dist, and all the server source. The server runs
# straight from TypeScript via tsx, matching `npm start`.
COPY --from=build /app ./

# Ensure the DB directory exists even when no volume is mounted. The Unraid
# template maps a host path to /data and sets NOMYX_DB=/data/nomyx.db.
RUN mkdir -p /data

EXPOSE 4433

# Same as `npm start`: tsx server.ts
CMD ["./node_modules/.bin/tsx", "server.ts"]
