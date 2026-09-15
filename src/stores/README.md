# Store ownership

This is a frontend prototype. Keep fixtures, scenarios and simulated endpoint work in `src/mock/`; stores own reactive state and user actions. No persistence or real provider integration is introduced here.

| Store | Owns |
| --- | --- |
| `library.ts` | Books, chapters, volumes, book settings and library removal/undo |
| `scripts.ts` | Script segments, previous revisions, edits and bulk corrections |
| `cast.ts` | Characters, dictionary, voice routing and pronunciation actions |
| `endpoints.ts` | TTS endpoints, scripting profiles and endpoint configuration |
| `jobs.ts` | Queue/history, usage, telemetry and shared job lifecycle |
| `scripting.ts` | Scripting settings and simulated scripting runs |
| `narration.ts` | Expression review, narration runs, flags and retakes |
| `exports.ts` | Export drafts, deliverables and simulated builds |
| `ui.ts` | Current book, theme, notifications and undo |
| `demo.ts` | Demo startup, scenario controls and reset orchestration |
| `reader.ts` | Reader preferences |

## Adding or changing behavior

- Give each state collection one owner. Consumers import only the stores they use; there is no aggregate application store.
- Read other stores inside actions/getters, not at module scope or during state initialization. Capture dependencies before returning callbacks or starting timers so they remain attached to the same Pinia instance.
- Cross-feature actions can coordinate owners directly. Keep that coordination with the initiating feature instead of adding a generic service layer.
- Keep pure calculations in `src/lib/` and timer mechanics in `src/mock/simulators/`.
- `seed.ts` provides independent slices of one pristine fixture world per Pinia instance. Live state is never shared between instances. `$reset()` resets one store; coordinated demo resets belong in `demo.ts`.
- Removing or renumbering book content must account for related script, cast, job and export state. Undo should restore the same affected data.

Run `bun test tests`, the existing lint command and the production build after changes. `tests/stores.test.ts` covers initialization order, instance isolation, async callbacks, job IDs and removal/undo; feature tests cover the user workflows.
