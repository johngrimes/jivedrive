# syntax=docker/dockerfile:1

# Stage 1: install dependencies, build the SPA, and bundle the backend.
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

# Bundle the backend into a single file. Runtime dependencies (including
# any native modules) are externalised, so node_modules is copied into the
# runtime image as well.
COPY backend ./backend
RUN cd backend && bun build ./src/server.ts --target=bun --outfile=/app/server.js

# Stage 2: runtime - the Hono server serves the built SPA.
FROM oven/bun:1.3.14 AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/server.js ./server.js
COPY --from=build /app/frontend/dist ./frontend/dist
# SQL migrations are read from disk at startup.
COPY --from=build /app/backend/migrations ./migrations
COPY --from=build /app/node_modules ./node_modules

# The Hono server listens on this port (Phase 2 config default).
EXPOSE 3000

USER bun

CMD ["bun", "run", "./server.js"]
