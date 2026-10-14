<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Conventions

## Tests

- Extend or replace the tests a change touches before adding new ones. Changed behaviour → change its test; removed behaviour → remove its test in the same change.
- Add a test only for a failure the suite cannot already catch. If you can't name the assertion that would break, don't write it. Use `test.each` instead of copies.
- Never put an assertion behind an `if`. Assert the rule, not the fixture (no exact seeded counts, toast strings or unpromised array orders).
- Smallest fixture: `story(n)` and `line()` from `tests/support/epub.ts`. Use `voicedBook` / `narratedBook` instead of local import-script-narrate helpers.
- Server tests use `testApi()`, store tests `backendServer()`. Open `demoServer()` only when the test reads the seeded world.
- No paid or network calls: keep the fake providers. Replace real waits with gated providers or fake timers. Shared setup lives in `tests/support`.

## UI

- Toasts only through `uiStore.toast(msg, { kind, description, undo, action, timeout })` or `uiStore.toastLoading(promise, …)`.
- Icons: Lucide from `@lucide/vue`, aliased to the job they do (`RotateCcw as RetryIcon`), sized with `icon` / `icon-sm` / `icon-lg`.
- Form controls are the reka-ui wrappers in `src/ui/`. Every numeric field is `UiNumber`.
