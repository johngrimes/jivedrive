# Local development processes, launched with `overmind start`.
# Ports mirror the defaults in backend/src/config.ts (JIVEDRIVE_PORT) and
# frontend/vite.config.ts; Vite proxies /api, /auth and /healthcheck to 3000.

web: bun run --cwd frontend dev
web.port: 5173

api: bun run --cwd backend dev
api.port: 3000
