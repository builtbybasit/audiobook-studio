import { defineConfig, lazyPlugins } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const API = { target: `http://127.0.0.1:${process.env.PORT ?? "8787"}`, changeOrigin: true };

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["drizzle"],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "vue"],
    categories: {
      correctness: "error",
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    env: {
      builtin: true,
    },
    overrides: [
      {
        files: ["server/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "drizzle-orm",
                  message:
                    'Queries live in server/db/*.ts (docs/backend.md, "The shape of it"): add a function there and call it.',
                },
                {
                  name: "~/db/schema",
                  message:
                    'Queries live in server/db/*.ts (docs/backend.md, "The shape of it"): add a function there and call it.',
                },
              ],
              patterns: [
                {
                  group: ["drizzle-orm/*", "~/db/schema/*"],
                  message:
                    'Queries live in server/db/*.ts (docs/backend.md, "The shape of it"): add a function there and call it.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ["server/db/**/*.ts", "server/demo/**/*.ts", "server/usage/ledger.ts"],
        rules: {
          "no-restricted-imports": "off",
        },
      },
    ],
    // ponytail: type-aware lint off — it reads the root tsconfig (no `~/` alias, no .vue exports)
    // and flags ~230 sites; `vue-tsc --build` does the type check. Turn on with tsconfig paths fixed.
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [vue(), tailwindcss()]),
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // The page talks to `/api` on the same origin — and to `/demo/api`, the demo library the same
    // server holds — so there is no CORS to configure and no base URL to set: `pnpm dev` (the API
    // and this, side by side) is the whole arrangement. The address rather than `localhost`, which
    // can resolve to `::1` first while the API listens on IPv4 loopback only (see `HOST` in
    // server/env.ts).
    proxy: { "/api": API, "/demo/api": API },
  },
});
