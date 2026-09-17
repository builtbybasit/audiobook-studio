# Store ownership

This is a frontend prototype. Keep fixtures, scenarios and simulated endpoint work in `src/mock/`; stores own reactive state and user actions. No persistence or real provider integration is introduced here.

| Store          | Owns                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `library.ts`   | Books, chapters, volumes, book settings and library removal/undo                                            |
| `scripts.ts`   | Script segments, previous revisions, edits and bulk corrections                                             |
| `history.ts`   | A chapter's script versions, editing sessions, checkpoints and restoring one                                |
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
- A reset covers more than the stores: page state outside them registers with `onDemoReset` in `src/lib/pageState.ts`, demo credentials are re-seeded from `SEEDED_KEYS`, an open editing session's timer is dropped (`history.abandonSessions`), and anything pointed at a book the seeded world does not have (`survivesReset`) is cleared. A view open on such a book must navigate away _before_ the reset, not after.
- A snapshot restore puts a list back in the order it had. The Audiobooks shelf is read in list order, so a restore that regroups it is not the same state.
- Removing or renumbering book content must account for related script, cast, job and export state. Undo should restore the same affected data.
- A chapter's script history is preserved **before** the script changes, never after: `history.ts` is told what is about to happen (`noteEdit`, `noteBulk`, `noteScripted`) while the old script is still there. A scripting run reaches it through its one write path — `setSegments` in the run's simulator context — so a run that failed, was cancelled or ran out of budget cannot push a good script into the list. Ordinary edits are grouped into one entry per editing session, and an action that drives the per-line actions itself (a bulk correction, a restore) wraps them in `history.silence()` so a batch is one entry rather than one per line. A version is script content only (`snapshotScript`): the cast, the dictionary, the pacing and the endpoints belong to the book, and the audio is carried across a restore clip by clip instead of being stored twice. An edit and the entry it opens are **one transaction**: `scripts._editSnapshot` takes both owners' snapshots before the edit, so the undo the toast offers puts the script and the history back together — an edit that was taken back never leaves the list claiming it happened. What a version identifies by is lossless (`lineSignature`), so a script that differs from its replacement only in its spacing is still preserved; normalising belongs to `compareScripts`, which has to align lines, not to deciding what is worth keeping. The chapter numbers a history is keyed by are the library's: `remapBook`, `clearBook` and `_bookSnapshot` are how a renumbering, a removal and its undo reach it, in the same transaction as the scripts and jobs beside it.
- A bulk run is planned before it is started, and the plan is the only account of it: `lib/runPlan.ts`
  works out what a selection contains, which clips a narration scope would send, what the run replaces
  and why a selected chapter is left out — and the picker's summary, the run button's label, the
  estimate and the work the store queues all read that one calculation. A stage that grows a new way of
  choosing work adds it there, not in a view.
- **A replacement keeps what it replaces until the replacement lands.** A re-script writes nothing
  until it has a script to write, so a run that failed, was cancelled, ran out of budget or was
  overtaken leaves the chapter's script alone — and `settleWithoutWriting` puts the chapter's _status_
  back too, because a finished chapter left reading as `failed` is one that can no longer be narrated
  or exported. `Chapter.rescript` carries the status to go back to and the job allowed to write the
  result; a callback from any other run is discarded. A clip is the same rule one level down: a line
  being re-narrated that already has playable audio renders into `candidate`, exactly as a retake
  does, and the run accepts its own replacements (`_acceptReplacement`) so a bulk run does not ask for
  a verdict per line. The displaced clip joins `takes`; a failed replacement changes nothing and stays
  visible for `retryFailed`. A retake a person is still judging is never deleted to make room: a run
  told to replace one moves it into `takes` marked `rejected`, the way `rejectTake` does, so
  `_queueRender` can never leave a line with neither its clip nor its retake. Take numbers come from
  `nextTakeNumber`, which reads the take list and not only the clip in the book.
- One definition per question, shared by every caller: `narrationTargets` decides which lines a scope
  runs (the estimate, the plan and the run all call it), and `chapterNarration` decides what a chapter's
  narration reads as once nothing is in flight (a finished run, a cancelled one, and a cancelled queued
  job all call it). A second copy of either is how a panel starts quoting numbers the run does not honour.
- Jobs of one bulk run share `Job.bulk.id`, which is what makes "cancel the rest of this run" and "retry
  this run's failures" possible without the queue guessing. Cancelling keeps what finished; a retry uses
  the narrowest scope that covers the failure, so it never re-renders work that succeeded, and it is
  submitted as **one** run rather than one run per chapter. A seeded run holds its id too — `_addHistory`
  pushes `jobs._nextRun` past anything a scenario laid down, or a run started by hand would be filed
  under history it has nothing to do with. **Whether a chapter still needs the work is asked of the work,
  not of the chapter's label**: a failed replacement leaves the chapter reading as narrated and a failed
  re-script puts its status back, so retry eligibility comes from the clips (`candidate.status`) and from
  the queue (`_supersededBy`) instead.
- **One rule for danger: if it can be undone, it happens at once and offers Undo; if it cannot, it asks first.** Deleting a speaker, removing a voice, an endpoint or a volume, removing a novel and deleting an audiobook all snapshot and toast with Undo (`⌘Z` afterwards, ten deep), so none of them asks. Discarding an import and cancelling runs in flight are not undoable, so those two — and only those two — ask. A new destructive action belongs on one side or the other: give it an undo and let it act, or make it ask. What a confirmation step would have explained goes on the control that starts it (label and `title`) and in the toast's description, including anything Undo cannot bring back — see `_lostNote` in `library.ts`, which names the runs a removal cancelled.

Run `bun test tests`, the existing lint command and the production build after changes. `tests/stores.test.ts` covers initialization order, instance isolation, async callbacks, job IDs and removal/undo; feature tests cover the user workflows, and `tests/bulkRuns.test.ts` covers running a stage again over chapters that are already finished.

## Future backend integration

Keep the seeded demo and scenario controls as a permanent way to test these same screens without paid AI calls. Add backend services alongside the demo implementation rather than replacing `src/mock/`. Select the implementation at startup and isolate demo data, timers and credentials from real sessions. See the root README for the retained demo requirements.
