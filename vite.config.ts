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
      // bun:test types `expect(...).rejects` matchers as void, so every awaited one is flagged
      "typescript/await-thenable": "off",
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
                  message: "Queries live in server/db/*.ts: add a function there and call it.",
                },
                {
                  name: "~/db/schema",
                  message: "Queries live in server/db/*.ts: add a function there and call it.",
                },
              ],
              patterns: [
                {
                  group: ["drizzle-orm/*", "~/db/schema/*"],
                  message: "Queries live in server/db/*.ts: add a function there and call it.",
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
    options: {
      typeAware: true,
      typeCheck: true,
    },
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
    // `/api` and `/demo/api` share this origin, so no CORS and no base URL. The IP rather than
    // `localhost`, which can resolve to `::1` while the API listens on IPv4 only (`HOST` in
    // server/env.ts).
    proxy: { "/api": API, "/demo/api": API },
  },
});
