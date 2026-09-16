# Store ownership

This is a frontend prototype. Keep fixtures, scenarios and simulated endpoint work in `src/mock/`; stores own reactive state and user actions. No persistence or real provider integration is introduced here.

| Store          | Owns                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `library.ts`   | Books, chapters, volumes, book settings and library removal/undo                                            |
| `scripts.ts`   | Script segments, previous revisions, edits and bulk corrections                                             |
| `cast.ts`      | Characters, dictionary, voice routing and pronunciation actions                                             |
| `endpoints.ts` | TTS endpoints, scripting profiles and endpoint configuration                                                |
| `jobs.ts`      | Queue/history, usage, telemetry and shared job lifecycle                                                    |
| `scripting.ts` | Scripting settings and simulated scripting runs                                                             |
| `narration.ts` | Expression review, narration runs, flags and retakes                                                        |
| `exports.ts`   | Export drafts, deliverables and simulated builds                                                            |
| `ui.ts`        | Current book, theme, notifications and undo                                                                 |
| `demo.ts`      | Demo startup, the scenario catalogue, reset orchestration and the world generation simulated runs belong to |
| `reader.ts`    | Reader preferences                                                                                          |

## Adding or changing behavior

- Give each state collection one owner. Consumers import only the stores they use; there is no aggregate application store.
- Read other stores inside actions/getters, not at module scope or during state initialization. Capture dependencies before returning callbacks or starting timers so they remain attached to the same Pinia instance.
- Cross-feature actions can coordinate owners directly. Keep that coordination with the initiating feature instead of adding a generic service layer.
- Keep pure calculations in `src/lib/` and timer mechanics in `src/mock/simulators/`.
- `seed.ts` provides independent slices of one pristine fixture world per Pinia instance. Live state is never shared between instances. `$reset()` resets one store; coordinated demo resets belong in `demo.ts`.
- Applying a demo scenario restores every owned store from `seed.ts` first and then seeds the situation, so scenarios are repeatable and never compose. Keep the mutations in `src/mock/scenarios/`, reached through `ScenarioContext`; `demo.ts` supplies that context and owns nothing a store already owns.
- Simulated runs are abandoned rather than cancelled when the world is replaced: `demo.ts` holds `_epoch`, each simulator context captures it when the run starts, and `SimulatorContext.stale()` is checked before any write. A new timer-driven fake must check it too, or a late callback will write into the next scenario.
- A timer must also drop itself when its job is settled from outside it — a reset finishes running jobs, and a loop that only stops from inside its own step would tick forever against work nobody is watching.
- A reset covers more than the stores: page state outside them registers with `onDemoReset` in `src/lib/pageState.ts`, demo credentials are re-seeded from `SEEDED_KEYS`, and anything pointed at a book the seeded world does not have (`survivesReset`) is cleared. A view open on such a book must navigate away _before_ the reset, not after.
- A snapshot restore puts a list back in the order it had. The Audiobooks shelf is read in list order, so a restore that regroups it is not the same state.
- Removing or renumbering book content must account for related script, cast, job and export state. Undo should restore the same affected data.

Run `bun test tests`, the existing lint command and the production build after changes. `tests/stores.test.ts` covers initialization order, instance isolation, async callbacks, job IDs and removal/undo; feature tests cover the user workflows.

## Future backend integration

Keep the seeded demo and scenario controls as a permanent way to test these same screens without paid AI calls. Add backend services alongside the demo implementation rather than replacing `src/mock/`. Select the implementation at startup and isolate demo data, timers and credentials from real sessions. See the root README for the retained demo requirements.
