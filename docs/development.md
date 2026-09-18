# Development and verification

[Back to README](../README.md) · [Store ownership](../src/stores/README.md) · [Demo workflows](demo.md)

## Setup and commands

Use Node.js compatible with the installed Vite version, pnpm for the checked-in `pnpm-lock.yaml`, and Bun for the existing test runner. No provider keys or backend are required for the seeded demo.

```sh
pnpm install
pnpm dev
```

Vite prints the local URL, normally `http://localhost:5173`. If that port is occupied, use the URL it prints. There is no `prototype` script; `dev` is the current command.

The scripts are defined in [package.json](../package.json):

| Command          | Purpose                                      |
| ---------------- | -------------------------------------------- |
| `pnpm dev`       | Start the development server                 |
| `pnpm typecheck` | Run `vue-tsc --build`                        |
| `pnpm lint`      | Check with Oxlint                            |
| `pnpm lint:fix`  | Apply lint fixes; review the resulting diff  |
| `pnpm fmt:check` | Check formatting with Oxfmt                  |
| `pnpm fmt`       | Format files; review the resulting diff      |
| `pnpm test`      | Run the existing suite with `bun test tests` |
| `pnpm build`     | Typecheck and build with Vite                |
| `pnpm preview`   | Serve the production build locally           |

Run an individual test file directly with Bun, for example `bun test tests/history.test.ts`. Installing dependencies does not install the Bun executable used by the test script.

## Code map

| Location                                                          | Responsibility                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [src/views](../src/views) and [src/components](../src/components) | Pages and interactions                                                                     |
| [src/ui](../src/ui)                                               | Styled, reusable UI controls                                                               |
| [src/stores](../src/stores)                                       | Feature state and application actions; ownership is documented in the store guide          |
| [src/lib](../src/lib)                                             | Shared calculations and helpers: run plans, script comparison, pricing and export planning |
| [src/mock/fixtures](../src/mock/fixtures)                         | Hand-authored sample content and configurations                                            |
| [src/mock/world](../src/mock/world)                               | Expands fixtures into a coherent book library                                              |
| [src/mock/scenarios](../src/mock/scenarios)                       | Repeatable demo situations                                                                 |
| [src/mock/simulators](../src/mock/simulators)                     | Timer-driven fake requests and jobs                                                        |
| [src/services/endpoints.ts](../src/services/endpoints.ts)         | Endpoint service contract and fixture implementation                                       |
| [src/types](../src/types)                                         | Feature types, imported through `@/types`                                                  |
| [tests](../tests)                                                 | Bun tests for domain rules and workflows                                                   |

The scenario catalogue and shared store rules remain in their existing locations; this documentation does not introduce another state or service layer.

## State that survives a reload

Books, scripts, history, jobs, usage, endpoint settings and credentials are in memory. Reloading reconstructs the seeded world.

Browser localStorage retains reader typography and cast-rail preferences, the Library grid/list choice, and whether Narration’s setup panel is open. Searches, filters and some navigation state are also represented in the URL. These preferences are not persistence for library data.

## Verification and test maintenance

Use checks appropriate to the change:

- Layout, wording and simple UI controls: inspect the relevant browser interactions; run lint/typecheck for code changes.
- Pricing, restoration, cancellation, audio preservation and scenario reset: run the relevant behavior tests and add coverage for a distinct missing failure case.
- Refactoring: establish the existing baseline and check that covered behavior still holds. Inspect existing coverage before adding another test.
- Documentation: check local links, source references, command definitions and changed implementation claims. Documentation changes alone do not require new unit tests.

Consolidate repeated setup or equivalent cases when it improves clarity. Split large test files by coherent behavior when navigation becomes difficult; no file-length or test-count target is imposed. Keep fixtures readable, avoid assertions tied only to arbitrary sample counts, and preserve coverage of distinct failures.

The topic guides name the relevant tests beside the behavior they explain. Cross-feature coverage includes [tests/stores.test.ts](../tests/stores.test.ts), [tests/demo.test.ts](../tests/demo.test.ts), [tests/history.test.ts](../tests/history.test.ts), [tests/bulkRuns.test.ts](../tests/bulkRuns.test.ts), [tests/pricing.test.ts](../tests/pricing.test.ts) and [tests/usageLedger.test.ts](../tests/usageLedger.test.ts). The [demo walkthroughs](demo.md#things-to-try) are the manual testing entry point.

## Keeping documentation useful

Document stable behavior in its topic guide and ownership rules in the store guide. Keep the root README as the entry point. Add meaningful design rationale to the relevant topic; use [design history](design-history.md) for chronology and superseded approaches. Label future plans and simulated behavior explicitly, and update the existing explanation instead of appending another account of the same feature.

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
`UiSelect` (grouped items, colour dots, hints, a `null-value` option), `UiCombobox` (searchable, grouped, `action` mode for "merge into…"), `UiSlider`, `UiNumber`, `UiCheckbox` (tri-state), `UiSwitch`, `UiToggleGroup`, `UiTooltip`. Tabs, Popover, Dialog, Collapsible and TooltipProvider are used directly from reka-ui. Reka forbids `''` as a Select item value — the wrapper maps it to a sentinel.

`UiNumber` is every numeric field in the app (price, cap, gap, limit, year). It drops the native
spinner — at this size the arrows eat a third of the box and fire on a stray scroll — and keeps the
behaviour: `↑`/`↓` step (`shift` ×10), `Esc` reverts, `Enter`/blur commits, values are clamped to
`min`/`max` and float noise is rounded off. It holds a draft while you type, so a half-typed `0.` never
reaches the store, and an unreadable entry snaps back to what is actually set. `prefix` / `unit` sit
inside the box (`$ 12`, `0.35 s`), and `empty` lets a blank field mean something — "no cap".
