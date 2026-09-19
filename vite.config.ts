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
    // base URL to set: `pnpm dev:server` alongside `pnpm dev` is the whole arrangement.
    proxy: { "/api": { target: `http://localhost:${API_PORT}`, changeOrigin: true } },
  },
});
