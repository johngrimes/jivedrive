# syntax=docker/dockerfile:1

# Stage 1: install dependencies and build the SPA (the backend runs
# from source in the runtime stage).
FROM oven/bun:1.3.14 AS build

WORKDIR /app

# Install dependencies first so the layer is cached across builds.
COPY package.json bun.lock ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# frontend/tsconfig.json extends ../tsconfig.json; the SPA build resolves it.
COPY tsconfig.json ./
RUN bun install --frozen-lockfile

# Build the SPA (frontend build script and vite config land in Phase 2).
COPY frontend ./frontend
RUN bun run --cwd frontend build

# The backend runs from source (bun executes TypeScript natively) so
# that worker entry files referenced via new URL(..., import.meta.url)
# — the search scan and extraction workers — resolve at runtime; a
# single-file bundle cannot resolve them.
COPY backend ./backend

# Stage 2: runtime - the Hono server serves the built SPA.
FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/backend/src ./backend/src
COPY --from=build /app/frontend/dist ./frontend/dist
# SQL migrations are read from disk at startup.
COPY --from=build /app/backend/migrations ./migrations
COPY --from=build /app/node_modules ./node_modules

# The Hono server listens on this port (Phase 2 config default).
EXPOSE 3000

USER bun

CMD ["bun", "run", "./backend/src/server.ts"]
