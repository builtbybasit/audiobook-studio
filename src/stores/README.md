# Store ownership

This is a frontend prototype. Keep fixtures, scenarios and simulated endpoint work in `src/mock/`; stores own reactive state and user actions. No persistence or real provider integration is introduced here.

| Store          | Owns                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `library.ts`   | Books, chapters, volumes, book settings and library removal/undo                                            |
| `scripts.ts`   | Script segments, previous revisions, edits and bulk corrections                                             |
| `history.ts`   | A chapter's script versions, editing sessions, checkpoints and restoring one                                |
| `cast.ts`      | Characters, dictionary, voice routing and pronunciation actions                                             |
| `endpoints.ts` | TTS endpoints, scripting profiles, their rate cards and endpoint configuration                              |
| `jobs.ts`      | Queue/history, telemetry, budget reservations and shared job lifecycle                                      |
| `usage.ts`     | The append-only ledger of every request this session settled, and what each one cost                        |
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
- `seed.ts` provides independent slices of one pristine fixture world per Pinia instance. Live state is never shared between instances. `$reset()` resets one store; coordinated demo resets belong in `demo.ts`. Anything dated belongs in that world rather than being built fresh in a store's `state()` — the scripting profiles carry promotions with start and end dates, so a `$reset()` that rebuilt them against a newer clock would hand back a world subtly unlike the one it was restoring.
- The fixture endpoint service caches the week of traffic it invents, and prices it from the seeded rate cards. That cache belongs to the world that produced it: `services/endpoints.ts` registers `reset()` with `onDemoReset`, and the Endpoints page reloads when `demo._epoch` changes. Dropping those rows is right only because nothing this session produced lives in them.
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
- **A cost is worked out once and then it is a receipt.** `lib/pricing.ts` is the only place that
  decides what a request of either kind costs, and it is pure: a rate card plus an instant always give the same
  answer. Every completed scripting request stores the `PricedRequest` it was charged from — the
  normalized usage, the rates in force at that instant, and the reasoning that produced them — and
  the ledger it lives in is append-only, so editing a rate or letting a promotion expire cannot move
  spending that has already happened. A view that re-derives a past cost from the endpoint's current
  card is how that guarantee gets lost; read the receipt instead. Rates are read **per request, at
  the moment it completed** (`PRICING_RULE`) rather than once per batch, so a run that crosses an
  off-peak boundary or a promotion expiry charges its requests differently either side of it — and
  the rule travels on the receipt so a future provider integration can adopt a different one.
- **Cached tokens are a slice of the input, never an addition to it.** `TokenUsage.inputTokens` is
  the total and `cachedInput`/`cacheWrite` are parts of it, so the charge lines always add back up to
  what the provider reported. Providers disagree about this — OpenAI's `prompt_tokens` includes the
  cached tokens, Anthropic's `input_tokens` excludes them — so nothing reads a payload directly:
  `normalizeUsage` is the one way in, and `mock/simulators/usage.ts` builds provider-shaped payloads
  that go through it exactly as a real response would. `cachedInput: null` means the provider did not
  say and is never treated as zero: those requests are charged conservatively at the ordinary rate
  and their cost is labelled `estimated`, never presented as a reported cache miss. A cost the
  provider reported itself is kept distinct from ours (`CostBasis`), and both figures survive on the
  receipt.
- **Both kinds of endpoint share one pricing engine.** A speech rate goes on discount exactly the
  way a token rate does: the same `PricingConfig`, the same windows, the same promotions and the
  same precedence. What differs is which components a card prices — `TOKEN_COMPONENTS` against
  `SPEECH_COMPONENTS` — and that a speech rate is written in whatever unit its endpoint bills in, so
  that unit travels with the rate (`rateSuffix`, `rateWithUnit`) everywhere it is shown. The panels
  take the components and the unit as props rather than inferring them. The receipts differ because
  the two kinds measure different things — `PricedRequest` holds tokens with the cache split,
  `SpeechCharge` holds characters, audio seconds and request count — and they meet in `ChargeLine`,
  which is what lets one table in the Activity list render both. A rendered clip carries its
  `SpeechCharge` (`SegmentAudio.charge`), so `jobs.spent` adds up prices that were actually charged;
  a clip is priced when it **lands**, never when it is dispatched, because a per-minute endpoint has
  no audio to bill for until then.
- **A settled request is a fact about the past, and it is kept as one.** `usage.ts` holds one
  `RequestRecord` per request this session settled — of either kind, successful or not — with the
  receipt it was priced from, and nothing moves, re-prices or removes one afterwards. Spending is
  derived from it (`jobs.spent`), and so is the Endpoints page's account of this session's own work.
  Both used to be read off whatever the app happened to be holding at the time, and both lost real
  requests for it: totalling the clip currently on each line meant a failed render cost nothing and
  accepting a retake made the money spent on the clip it displaced **disappear**, while reading the
  Activity list out of the running job simulator made a request vanish the moment it finished. A new
  simulated transport records what it settles here; it does not leave the record on the artefact,
  because the artefact moves. `snapshotTake` carries a clip's `SpeechCharge` into the take list for
  the same reason. The seeded world's own narration predates all of this and is an opening balance
  taken once from the pristine world (`seedRead`), so the two halves cannot overlap and nothing a
  session does to a clip can change what was spent before it started.
- **A rate that is not known stays unknown through every discount.** `speechRates` puts `null` in
  the card — for an unknown rate _and_ for every component this model does not price, so nothing can
  invent a charge for something the endpoint does not bill for — and `resolveComponent` leaves a
  null component alone, so a window or promotion over an unknown rate changes nothing and the page
  says so rather than inventing a number. A two-rate card with one rate missing prices **nothing**
  rather than half of each request (`speechRateKnown`). The narration estimate counts those requests
  in `unpriced` and calls its total a floor. Zero is a different thing entirely and reads as "free".
- **An estimate's two halves are reported separately, and reconciled separately.**
  `SpeechEstimate` returns `inputCost` and `audioCost` beside the total because they are worked out
  from different things: the input side from the text that will be submitted, the audio side from
  the audio's expected length and the endpoint's tokens-per-second setting. `_plannedCost` records
  both on the job (`Job.narrationRun.estimated{,Input,Audio}`) from the same lines and the same
  instant the chapter is dispatched at, and the simulator's `reconcile` compares each against what
  was actually charged. It counts **billable attempts** rather than surviving clips: a failed render
  still sent its text and a per-character, per-byte or per-request provider still charged for it.
  Generated audio is the clip's own duration; silence stitched between clips is never rendered and
  is never billed.
- **A budget is checked against the price with no discount and no cache saving.** A promotion can
  expire and an off-peak window can close while a run is still going, so a cap that only holds while
  a discount lasts is not a cap: `tokenEstimate().reserve` and the blockers in `scriptEstimate` use
  the undiscounted rates and the full output ceiling. The discounted figure and any cache-adjusted
  figure are shown beside the conservative one, labelled, and used for neither. The input side is
  reserved at the **dearest** rate any input token could be charged at (`dearestInput`), not at the
  ordinary input rate: cached and cache-write tokens are slices of the input and a cache write
  usually costs more than it, so reserving at the ordinary rate lets the first request exceed its own
  reservation. Narration does the same, and enforces it in the store rather than in whichever panel
  happens to have an estimate: `NarrationEstimate.withoutPromotions` is what the cap is compared
  against, `_budgetBlocked` gates every entry point — a bulk run, "re-narrate stale", a retry, a
  retake, "retake everything flagged" — and `_reserveQueued` holds each job's undiscounted price
  (`Job.narrationRun.reserved`) until it lands, so two runs that each fit cannot both start and
  overshoot together. `jobs.reserved` is what unfinished work of either stage is holding.
- **One rule for danger: if it can be undone, it happens at once and offers Undo; if it cannot, it asks first.** Deleting a speaker, removing a voice, an endpoint or a volume, removing a novel and deleting an audiobook all snapshot and toast with Undo (`⌘Z` afterwards, ten deep), so none of them asks. Discarding an import and cancelling runs in flight are not undoable, so those two — and only those two — ask. A new destructive action belongs on one side or the other: give it an undo and let it act, or make it ask. What a confirmation step would have explained goes on the control that starts it (label and `title`) and in the toast's description, including anything Undo cannot bring back — see `_lostNote` in `library.ts`, which names the runs a removal cancelled.

Run `bun test tests`, the existing lint command and the production build after changes. `tests/stores.test.ts` covers initialization order, instance isolation, async callbacks, job IDs and removal/undo; feature tests cover the user workflows, `tests/bulkRuns.test.ts` covers running a stage again over chapters that are already finished, and `tests/pricing.test.ts` covers token accounting, discount precedence, schedule boundaries, promotion expiry and contradictory usage counts — with the end-to-end half (per-request pricing across a boundary, budget reconciliation, preserved historical costs) in `tests/scripting.test.ts`, and `tests/usageLedger.test.ts` covers the ledger itself: spending that only ever goes up, settled requests keeping their place in an endpoint's activity, and the book's cap holding whichever way narration is started.

## Future backend integration

Keep the seeded demo and scenario controls as a permanent way to test these same screens without paid AI calls. Add backend services alongside the demo implementation rather than replacing `src/mock/`. Select the implementation at startup and isolate demo data, timers and credentials from real sessions. See the root README for the retained demo requirements.
