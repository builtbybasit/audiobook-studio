# audiobook-ui — PROTOTYPE

Throwaway Vue 3 prototype answering **"what should the audiobook pipeline UI look like?"**
Front-end only. All data is mocked in `src/mock/data.js`; jobs are simulated with timers in `src/stores/app.js`. Nothing persists except reader typography preferences (localStorage).

```bash
pnpm install
pnpm prototype        # opens http://localhost:5173
```

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

## Things to try

- Scripting: *The Cliché Cultivation World* has three volumes — collapse them in the chapter list. Tick unscripted chapters on *Letters from the Drowned City* and run; new chapters sometimes surface an alias (dashed "new") to merge. Hide the cast with the Cast button, change type with `Aa`.
- Narration: *Cliché* ch 4 is partly failed — retry from the ledger. Toggle endpoints / concurrency and re-narrate. Watch the run estimate update with the selection.
- Export: *Ashes of the Starforge* is fully narrated — build an M4B.
