# Development and verification

[Back to README](../README.md) · [Store ownership](../src/stores/README.md) · [Backend](backend.md) · [Demo workflows](demo.md)

## Setup and commands

You need Node.js for Vite 8, pnpm for the checked-in `pnpm-lock.yaml`, and Bun 1.4 or later, which runs the server and the tests. Installing dependencies does not install Bun. ffmpeg is optional: the server only needs it when started with `EXPORT_ENCODER=ffmpeg` ([export](exports.md)). No provider keys are needed: a fresh library has no endpoints, and the **Simulated (free)** preset on the Endpoints page adds one the server answers itself, without the network or a charge.

```sh
pnpm install
pnpm dev
```

That starts the API on :8787 and Vite beside it, each line prefixed `api` or `web`; stopping either stops both. Vite prints the local URL, normally `http://localhost:5173`, and proxies `/api` and `/demo/api` to the API. Server settings and their defaults are in [.env.example](../.env.example); every one has a working default, so no `.env` is needed.

The scripts are defined in [package.json](../package.json):

| Command            | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `pnpm dev`         | Start the API and the frontend together                                  |
| `pnpm dev:web`     | Start the frontend alone                                                 |
| `pnpm dev:server`  | Start the API alone, applying migrations first                           |
| `pnpm typecheck`   | Run `vue-tsc --build`                                                    |
| `pnpm lint`        | Check with Oxlint                                                        |
| `pnpm lint:fix`    | Apply lint fixes; review the resulting diff                              |
| `pnpm fmt:check`   | Check formatting with Oxfmt                                              |
| `pnpm fmt`         | Format files; review the resulting diff                                  |
| `pnpm test`        | Run the suite, one worker per core                                       |
| `pnpm test:live`   | Send a few real, paid requests to the providers named in `.env` (opt-in) |
| `pnpm build`       | Typecheck and build with Vite                                            |
| `pnpm preview`     | Serve the production build locally                                       |
| `pnpm db:generate` | Generate SQL in `drizzle/` after editing the server schema               |
| `pnpm db:migrate`  | Apply migrations without starting the server                             |
| `pnpm db:studio`   | Browse the database with Drizzle Studio                                  |

Run one test file with Bun directly, for example `bun test tests/history.test.ts`. `pnpm test` uses Bun's `--parallel`, which runs each file in a worker of its own. The seeded demo takes about half a second to open, and a test that opens it can pass 5 s when every core is busy, so the script allows each test 20 s. Tests make their temporary folders under one root per file, removed when the file is done ([tests/support/tempRoot.ts](../tests/support/tempRoot.ts)); make yours with `mkdtemp(tmpdir())` so they land there.

`pnpm typecheck` checks the tests as well as the code they test. The page's tests, in `tests/` and `tests/support/`, are checked with the DOM beside Bun ([tsconfig.tests.json](../tsconfig.tests.json)); the server's, in `tests/server/` and `tests/live/`, are checked with the server, without the DOM ([tsconfig.server.json](../tsconfig.server.json)). A helper either kind imports is checked with it, so a new one needs no entry in either.

`pnpm test:live` runs [tests/live/](../tests/live/) against real APIs with the keys in `.env` (the commented `SCRIPTING_PROVIDER_*` and `FISHAUDIO_*` lines in `.env.example`). It is the only code that reads them; the running server takes its providers from the Endpoints page.

## Code map

| Location                                                          | Responsibility                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [src/views](../src/views) and [src/components](../src/components) | Pages and interactions                                                                                          |
| [src/ui](../src/ui)                                               | Styled, reusable UI controls                                                                                    |
| [src/stores](../src/stores)                                       | Feature state and user actions; ownership is documented in the [store guide](../src/stores/README.md)           |
| [src/queries](../src/queries)                                     | Reads from the server on [Pinia Colada](https://pinia-colada.esm.dev), and what each write invalidates          |
| [src/services](../src/services)                                   | The page's HTTP services, one base per tab: `/api`, or `/demo/api` in a demo tab                                |
| [src/composables](../src/composables)                             | Shared view logic: the player, the shell's facts about a book, voice samples, the preset picker                 |
| [src/lib](../src/lib)                                             | Pure rules shared by the page and the server: run plans, pricing, script history, export planning, providers    |
| [src/types](../src/types)                                         | Domain types, imported through `@/types` on both sides                                                          |
| [server](../server)                                               | The API, the job queue, EPUB import, providers and files. Its own guide is [backend](backend.md)                |
| [server/demo/seed](../server/demo/seed)                           | The world, fixtures and situations the demo is seeded with; no store imports it                                 |
| [drizzle](../drizzle)                                             | Generated SQL migrations                                                                                        |
| [tests](../tests)                                                 | Store and rule tests; [tests/server](../tests/server) for the server, [tests/support](../tests/support) helpers |

## State that survives a reload

Everything the page shows is the server's, in SQLite: your library in `data/library.db`, and the demo, opened from the header's **Demo** chip, in `data/demo.db`, where it stays as you left it until you reset it or pick a situation. A job the server was running when it stopped is picked up again when it starts. See [backend](backend.md) and [the demo](demo.md).

The browser's localStorage keeps reader typography and whether the cast rail shows, the Library grid/list choice, and whether Narration's setup panel is open. `sessionStorage` keeps whether this tab is in the demo and which situation it last applied. Searches, filters and some navigation state are in the URL. None of this is library data.

## Verification and test maintenance

Use checks appropriate to the change:

- Layout, wording and simple UI controls: inspect the relevant browser interactions; run lint/typecheck for code changes.
- Pricing, restoration, cancellation, audio preservation and scenario reset: run the relevant behavior tests and add coverage for a distinct missing failure case.
- Refactoring: establish the existing baseline and check that covered behavior still holds. Inspect existing coverage before adding another test.
- Documentation: check local links, source references, command definitions and changed implementation claims. Documentation changes alone do not require new unit tests.

### Before adding a test

A change extends or replaces the tests it touches before it adds any. Read what already covers the
behavior first — the topic guide names the file, and the store method is worth a `grep`. When a
behavior changes, change its test; when a behavior is removed, remove its test in the same change.
Extend the nearest existing test when the new case shares its setup and its subject, and add a new
one only for a behavior or a failure case the suite cannot already fail on. Each test protects one
distinct behavior: if you cannot name the assertion that would break, there is no new test to write.

The same goes the other way. A test is redundant only when another one would fail on the same
breakage — name that test when you delete this one, and check it is not itself being removed. A
repeated case belongs in a `test.each` table whose row names itself in the failure, not in a copy.

Keep tests inexpensive. Use the smallest fixture that still reaches the rule: `story(n)` for the few
paragraphs a test needs rather than the default whole chapter, which renders dozens of clips. Replace a real wait with a gated provider or fake timers. Keep the fake
providers; no test makes a paid or network call. The real encoder runs only where it is the point,
and skips where `ffmpeg` is not installed.

Open the seeded demo (`demoServer()`) only when a test reads the seeded world: a store test of the
server's routes takes `backendServer()` and a book of its own, and a server test takes `testApi()`,
whose database is migrated once per file and copied. Tests that only read the demo share one opened
in `beforeAll`; a test that changes it applies a situation, which rebuilds it whole, so a `reset()`
just before a `situate()` is wasted. A store test about what an edit sends can record it with
`unwrittenEdits()` rather than reseed the demo after every write. For a narrated book, reach for
`voicedBook`, `narratedBook` and `line()` in [tests/support](../tests/support) rather than a local
import-script-narrate helper. `pnpm test` runs every file in a worker of its own; a plain serial
`bun test` shares one process, so leave module state the way you found it.

Never guard an assertion behind an `if`: a condition the test needs in order to mean anything is
itself an assertion, and a test that skips its own point reports green while checking nothing. Assert
the rule rather than the fixture — an exact seeded count, an exact toast string or an array order the
code does not promise is a test that breaks when the sample data is edited, and points at itself
rather than at the change.

Shared setup lives in [tests/support](../tests/support); express a per-file difference as an option
there rather than as a local copy. Split a file when navigating it is hard, along a seam the store
guide already names — no file-length or test-count target is imposed, in either direction.

The topic guides name the relevant tests beside the behavior they explain. Cross-feature coverage includes [tests/stores.test.ts](../tests/stores.test.ts), [tests/demoStore.test.ts](../tests/demoStore.test.ts) and [tests/server/demoSituations.test.ts](../tests/server/demoSituations.test.ts), [tests/history.test.ts](../tests/history.test.ts), [tests/bulkRuns.test.ts](../tests/bulkRuns.test.ts), the three pricing files — [tests/pricing.rates.test.ts](../tests/pricing.rates.test.ts) for the rate in force at a given instant, [tests/pricing.tokens.test.ts](../tests/pricing.tokens.test.ts) for the scripting side and [tests/pricing.speech.test.ts](../tests/pricing.speech.test.ts) for the speech side — and [tests/server/usage.test.ts](../tests/server/usage.test.ts) for the ledger. The [demo walkthroughs](demo.md#things-to-try) are the manual testing entry point.

## Keeping documentation useful

Document stable behavior in its topic guide and ownership rules in the store guide. Keep the root README as the entry point. Describe what the app does now, in the present tense: when a feature changes, rewrite its explanation rather than appending how it used to work. Keep the design rationale — why a rule is shaped the way it is — beside the rule, and put chronology and superseded approaches in [design history](design-history.md). Say where the demo differs from your own library, and label anything not yet built as such.

## Toasts

Toasts run on [vue-toastflow](https://www.toastflow.top) for the runtime only — queue, timers, pause on hover, swipe to dismiss, Escape, focus handling, live regions, the promise `loading` helper. The plugin is created with `{ css: false }`, so none of its stylesheet loads: stack layout, motion and the time-left bar are in [src/toasts.css](../src/toasts.css), and the card is our own Tailwind markup in [components/Toasts.vue](../src/components/Toasts.vue) through the headless slot (`ui.getRootProps / getCloseProps / getButtonProps / progress.*` keep the a11y and behaviour wiring). The app only ever calls `uiStore.toast(msg, { kind, description, undo, action, timeout })` and `uiStore.toastLoading(promise, { loading, success, error })`.

UX rules: undoable toasts get ↻, an Undo button first, a `⌘Z` hint on the newest one, 10 s with a visible time-left bar that pauses on hover; warnings/errors are `role="alert"` with a stronger left accent, never a full-colour background; close only shows on hover/focus on pointer devices and always on touch; four visible, the rest queue; duplicates are suppressed.

## Icons

Icons are [Lucide](https://lucide.dev) SVGs from `@lucide/vue`, imported where they are used and
aliased to the job they do (`import { RotateCcw as RetryIcon } from "@lucide/vue"`). Size them with
the `icon` / `icon-sm` / `icon-lg` classes in [src/style.css](../src/style.css) (14 / 12 / 16 px, aligned to the text
they sit in); `icon-fill` fills the play and pause triangles, which read better solid at that size.
Keyboard legends (`⌘`, `↵`, `↑↓`) and prose arrows ("teasing, light → cold, deliberate") stay as text,
and so does the `⁄` caret marking a cut point inside a line in split mode.

## UI primitives

Form controls are built on [reka-ui](https://reka-ui.com) (headless, accessible) with thin styled wrappers in [src/ui/](../src/ui/):
`UiSelect` (grouped items, colour dots, hints, a `null-value` option), `UiCombobox` (searchable, grouped, `action` mode for "merge into…"), `UiSlider`, `UiNumber`, `UiCheckbox` (tri-state), `UiSwitch`, `UiToggleGroup`, `UiTooltip`, and the shells around a page's own content: `UiDialog` (centred, near the top, or filling the screen) and `UiSheet` (from the right or the bottom) share one overlay, so every modal dims the page alike and stacks at one height, and `UiTabs` is the tab row with the underline, inside the page's `TabsRoot`. Popover, Collapsible and TooltipProvider are used directly from reka-ui. Reka forbids `''` as a Select item value — the wrapper maps it to a sentinel.

`UiNumber` is every numeric field in the app (price, cap, gap, limit, year). It drops the native
spinner — at this size the arrows eat a third of the box and fire on a stray scroll — and keeps the
behaviour: `↑`/`↓` step (`shift` ×10), `Esc` reverts, `Enter`/blur commits, values are clamped to
`min`/`max` and float noise is rounded off. It holds a draft while you type, so a half-typed `0.` never
reaches the store, and an unreadable entry snaps back to what is actually set. `prefix` / `unit` sit
inside the box (`$ 12`, `0.35 s`), and `empty` lets a blank field mean something — "no cap".
