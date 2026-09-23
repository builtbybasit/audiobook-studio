import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const API_PORT = process.env.PORT ?? "8787";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // Backend mode talks to `/api` on the same origin, so there is no CORS to configure and no
    // base URL to set: `pnpm dev` (the API and this, side by side) is the whole arrangement.
    // The address rather than `localhost`, which can resolve to `::1` first while the API listens
    // on IPv4 loopback only (see `HOST` in server/env.ts).
    proxy: { "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true } },
  },
});
