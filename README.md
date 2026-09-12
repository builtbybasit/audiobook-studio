# audiobook-ui — PROTOTYPE

Throwaway Vue 3 prototype answering **"what should the audiobook pipeline UI look like?"**
Front-end only. All data is mocked in `src/mock/data.js`; jobs are simulated with timers in `src/stores/app.js`. Nothing persists except reader typography preferences (localStorage).

```bash
pnpm install
pnpm prototype        # opens http://localhost:5173
```

## Pages

- **Library** → **Book overview** (volumes, per-stage progress, cast summary, "what next") → stages **Scripting / Narration / Export**.
- **Cast** (per book): every speaker across all chapters, line counts, first appearance, merge suggestions for near-duplicate names, bulk merge.
- **Queue**: all jobs across books with cancel / retry / remove, endpoint pool utilisation.

## Stages

Library → Scripting → Narration → Export. Pick a book in Library; the other stages unlock for it.
A novel may span several EPUB files: each file is a **volume**, chapters number continuously across volumes, and the cast is shared. Add a volume from a book card or from the Add EPUB dialog.

## Decisions taken (2026-09-12)

Six structural variants were prototyped (three per screen) and compared via a `?variant=` switcher. The winners are folded in here; the full set lives on the `prototype/all-variants` branch.

| Screen | Winner | Why |
|---|---|---|
| Scripting review | **Reader** — prose + dialogue cards, toggleable in-chapter cast rail, `Aa` typography menu | reads like the book; the grid and cast-first layouts were better for bulk fixes but worse for judging the script |
| Narration job | **Ledger** — filterable per-segment log with sticky player | failures and playback are the everyday task; the timeline and per-endpoint lanes were prettier but less useful |

Ideas borrowed from the older narrata web UI: major/minor cast split with Narrator-voice fallback, auto-assign by gender, spoiler-hidden descriptions, a "This run" cost estimate with blockers, endpoint price / no-key badges, per-chapter segment counts, reader filters.

## States worth knowing

- Scripting: `done`, `fallback` (a chunk didn't verify → kept whole as narration, retry per chunk from the reader), `failed` (nothing kept; try smaller chunks).
- Narration: `done`, `stale` (script edited after narration → "Re-narrate changed" renders only those segments), `failed` (per-segment retry).
- Endpoints back off for a few seconds on a simulated rate limit; health strip shows latency sparkline, ok rate, failures, 429s.
- **Voices belong to endpoints.** Each endpoint card lists its voices (fetch from the server, add by id, remove); character pickers are grouped by endpoint, and a paused endpoint's voices are listed but disabled. A character's voice is a ref `endpointId/voiceId`, so every segment is rendered by the endpoint that owns its speaker's voice (unvoiced speakers borrow the Narrator's). Removing a voice or pausing its endpoint shows up as a blocker on the voice card and in "This run"; segments that can't be routed fail with a reason instead of hanging.
- **Per-request character limit** per endpoint (`maxChars`, 0 = whole segments). Longer segments are sent as several requests and joined; the endpoint card says how many segments of the open book would split, the run estimate counts requests and splits, and the ledger marks rows "N parts · M ch" (click to see the exact cuts). **Cut at** chooses the boundary: sentence end, clause (`, ; : —`), word, or hard cut; when the preferred boundary doesn't occur inside the window it falls back to the next finer one and the part is flagged. The endpoint card previews how the longest routed segment of the open book would be cut (`src/lib/split.js`).
- **Volumes can be renamed and removed** from the book overview (wrong EPUB added). Removing one deletes its chapters, segments, jobs and export entries, renumbers the remaining chapters so numbering stays continuous, and removing the only volume removes the novel.
- Reader keyboard: `j`/`k` move, `↵` edit, `1–9` assign speaker, `c` toggle cast.

## UI primitives

Form controls are built on [reka-ui](https://reka-ui.com) (headless, accessible) with thin styled wrappers in `src/ui/`:
`UiSelect` (grouped items, colour dots, hints, a `null-value` option), `UiCombobox` (searchable, grouped, `action` mode for "merge into…"), `UiSlider`, `UiCheckbox` (tri-state), `UiSwitch`, `UiToggleGroup`, `UiTooltip`. Tabs, Popover, Dialog, Collapsible and TooltipProvider are used directly from reka-ui. Reka forbids `''` as a Select item value — the wrapper maps it to a sentinel.

## Things to try

- Scripting: *The Cliché Cultivation World* has three volumes — collapse them in the chapter list. Tick unscripted chapters on *Letters from the Drowned City* and run; new chapters sometimes surface an alias (dashed "new") to merge. Hide the cast with the Cast button, change type with `Aa`.
- Narration: *Cliché* ch 4 is partly failed — retry from the ledger. The Narrator sits on the free local Kokoro (limit 500 chars) and dialogue on OpenAI; narrate ch 7 and watch rows split into parts. On *Drowned City*, Old Tobiah's voice lives on the paused Azure proxy — resume it or repick. In Endpoints, add an endpoint and “Fetch from server” to pull its voice list.
- Export: *Ashes of the Starforge* is fully narrated — build an M4B.
