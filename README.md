# audiobook-ui — PROTOTYPE

Throwaway Vue 3 prototype answering **"what should the audiobook pipeline UI look like?"**
Front-end only. All data is mocked in `src/mock/data.js`; jobs are simulated with timers in `src/stores/app.js`. Nothing persists.

```bash
pnpm install
pnpm prototype        # opens http://localhost:5173
```

## Stages

Library → Scripting → Narration → Export. Pick a book in Library; the other stages unlock for it.

## Variants (the actual prototype question)

Two screens have several *structurally different* designs. Flip with the amber bar at the bottom of the screen, or press ← / →. The choice is in the URL (`?variant=A|B|C`) so links are shareable.

| Screen | A | B | C |
|---|---|---|---|
| Scripting review (`/book/:id/scripting`) | **Reader** – prose + dialogue cards, in-chapter cast rail | **Grid** – dense table, keyboard + bulk reassignment | **Cast-first** – one character at a time, reattribute per line |
| Narration job (`/book/:id/narration`) | **Timeline** – proportional strip + scrubber | **Lanes** – kanban by endpoint, watch the pool | **Ledger** – filterable log + sticky player |

The switcher is hidden in production builds.

## Things to try

- Scripting: tick a few unscripted chapters on *Letters from the Drowned City* and run. New chapters sometimes surface an alias (dashed "new") to merge.
- Narration: *The Cliché Cultivation World* ch 4 is partly failed – retry from any job view. Toggle endpoints / concurrency and re-narrate to watch the lanes.
- Export: *Ashes of the Starforge* is fully narrated – build an M4B.
