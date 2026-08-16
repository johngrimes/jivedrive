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
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/healthcheck": "http://localhost:3000",
    },
  },
});
