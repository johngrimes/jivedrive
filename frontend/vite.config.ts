import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // In development the Vite dev server proxies API calls to the Hono
      // backend, which listens on the configured backend port (3000).
      // Plain keys are prefix matches, so /auth is anchored to its path
      // segment: the SPA's /authorize consent page must stay in Vite.
      "/api": "http://localhost:3000",
      "^/auth/": "http://localhost:3000",
      "/healthcheck": "http://localhost:3000",
      "/s": "http://localhost:3000",
      // Remote MCP endpoint and its OAuth 2.1 authorization server.
      "/mcp": "http://localhost:3000",
      "/oauth": "http://localhost:3000",
      "/.well-known": "http://localhost:3000",
    },
  },
});
