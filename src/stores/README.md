# Store ownership

[Back to README](../../README.md) · [Development and checks](../../docs/development.md) · [Backend](../../docs/backend.md) · [Demo](../../docs/demo.md)

Stores own reactive state and user actions. Every store reads and writes through the services in [src/services/](../services/), which ask the library this tab is on: yours at `/api`, or the demo's at `/demo/api` ([mode.ts](../services/mode.ts), `API_BASE`). A demo tab runs these same stores against that second library, so no store has a demo branch of its own and nothing in the browser simulates anything. The world, fixtures and situations the server seeds the demo with are the server's own, in [server/demo/seed/](../../server/demo/seed/); no store imports them.

| Store               | Owns                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `library.ts`        | Books, chapters, volumes, book settings, contents-review decisions and removal; chapter counts a shelf reads before a book is opened     |
| `scripts.ts`        | Script segments, the script a re-script replaced, edits, segment boundaries and bulk corrections, and writing each chapter's script back |
| `history.ts`        | A chapter's script versions as the server recorded them, checkpoints and restoring one                                                   |
| `transfer.ts`       | A script file read in: the plan the server answered with, applying it and the report of what it did                                      |
| `speakerSamples.ts` | Voice samples a script file brought, waiting with a speaker: discarding them, and giving the voice cloned from them to the speaker       |
| `cast.ts`           | Characters, dictionary, pacing, voice routing and pronunciation actions                                                                  |
| `endpoints.ts`      | Speech endpoints, scripting profiles, their rate cards and the credential registry; what the server's speech gate has seen of each       |
| `jobs.ts`           | The job actions; the queue and each book's spending are the queries' reads, which its getters answer from                                |
| `scripting.ts`      | Scripting settings, the scripting plan and estimate, and queuing a run                                                                   |
| `narration.ts`      | Expressions, the narration plan and estimate, flags, retakes and their verdicts, and queuing a run                                       |
| `exports.ts`        | Export drafts, the plan and readiness review, the cover, and builds the server runs                                                      |
| `ui.ts`             | Current book and chapter, theme, sidebar, notifications and undo                                                                         |
| `demo.ts`           | The Demo drawer: the demo library's situations, applying one or resetting it, and its speed                                              |
| `reader.ts`         | Reader preferences, kept in the browser                                                                                                  |

## Adding or changing behaviour

- Give each state collection one owner. Consumers import only the stores they use; there is no aggregate application store.
- Read other stores inside actions and getters, not at module scope or during state initialisation. Capture dependencies before an `await` or before returning a callback — an undo, a `.then` — so they stay attached to the same Pinia instance.
- Cross-feature actions can coordinate owners directly. Keep that coordination with the initiating feature instead of adding a generic service layer.
- A store changes only its own state. When one feature moves another's — a rename moving script lines, a restore replacing a script and restaling its chapter, a removal letting a book go — it calls the owner's method (`scripts._applyLines`, `scripts._replace`, `library._patchChapter`, `cast._dropBook`) rather than writing into that store's state, so each rule about a collection lives beside it.
- Keep pure calculations in [src/lib/](../lib/). The server imports the same modules — the run plans, the pricing engine, the history rule, the narration cost, the take rules, a line's reading — so a rule both sides apply lives there once, and a store that worked it out a second way would be quoting figures the server does not honour.
- A change the server refused changes nothing here. `toastFailure` ([toastFailure.ts](toastFailure.ts)) says so in a toast, the same way for every store, and where the store had already moved (an input written behind) it reads the server's state back. Applying the change locally anyway would show a library the server does not have.
- Removing or renumbering book content is the server's to do first, and it cancels the jobs and drops the audiobooks that went with it. The library store then moves what each store holds by chapter number (`_renumber`, through `scripts._remapBook` and `history.remapBook`) and `_forgetBook` invalidates every query filed under the book, the queue with it, so what is still on screen is read again. A book removed is let go (`_dropBook`): each store drops what it held of it and the book's query entries are removed, since a read of a book the server no longer has would only fail.
- An Undo puts a list back in the order it had. A removed voice, endpoint or profile goes back at its old index, because a page that reads the list in order would otherwise show a different state.

## Script history invariants

- A chapter's script history is the server's, and it is preserved **before** the script changes, never after: the server applies `planCapture` from [lib/scriptHistory.ts](../lib/scriptHistory.ts) inside the transaction that writes the script, so a version and the script it preceded cannot disagree about which came first. `history.ts` captures nothing itself; an edit's answer carries the history it added to (`_install`), and `useChapterHistory` reads it on opening a chapter, so the list can never claim something the server did not record.
- A scripting run reaches the script through one write on the server, against the revision it read, so a run that failed, was cancelled, ran out of budget or was overtaken cannot push its script into the list ([server/jobs/scripting.ts](../../server/jobs/scripting.ts)).
- A write says what produced the script when it was not an ordinary edit. Ordinary edits are grouped into one entry per editing session (`SESSION_IDLE_MS`); a bulk correction drives the per-line actions inside `scripts.silence()` and commits each chapter once under its own name, and a restore commits under a `restored` origin. A flag batch changes nothing a version keeps, so it writes no script at all: each flag goes to its line alone, as a single flag does.
- A version is script content only (`snapshotScript`): the cast, the dictionary, the pacing and the endpoints belong to the book, and a restore carries the audio across clip by clip (`planRestore`) instead of storing it twice. What a version identifies by is lossless (`lineSignature`), so a script that differs from its replacement only in its spacing is still preserved; normalising belongs to `compareScripts`, which has to align lines, not to deciding what is worth keeping.
- Undoing an edit, a bulk correction or a restore writes the previous script back as an edit of its own (`scripts._editSnapshot`), so the history says an edit happened rather than forgetting the entry. An undo of a restore waits for its script write to land before it takes the speakers the restore added off the cast.
- The chapter numbers a history is keyed by are the library's: `remapBook` and `clearBook` are how a renumbering and a removal reach it, in the same pass as the scripts beside it.

## Bulk run invariants

- A bulk run is planned before it is started, and the plan is the only account of it: [lib/runPlan.ts](../lib/runPlan.ts)
  works out what a selection contains, which clips a narration scope would send, what the run replaces
  and why a selected chapter is left out — and the picker's summary, the run button's label and the
  estimate all read that one calculation. The server queues a narration run by the same
  `narrationTargets`. A stage that grows a new way of choosing work adds it there, not in a view.
- **A replacement keeps what it replaces until the replacement lands.** Both rules are the server's
  now, and the stores mark nothing before it answers. A re-script writes nothing until it has a
  script to write, and one that failed puts the chapter's scripting status back, so a finished
  chapter still reads as done. A line being re-narrated that
  already has playable audio renders into `candidate`, exactly as a retake does, and takes over only
  when it lands; the displaced clip joins `takes`, and a failed replacement changes nothing and stays
  visible for `retryFailed`. A retake a person is still judging is never deleted to make room: a run
  told to replace one moves it into `takes` marked rejected. Take numbers come from `nextTakeNumber`
  in [lib/takes.ts](../lib/takes.ts), which reads the take list and not only the clip in the book. See
  [server/jobs/narration.ts](../../server/jobs/narration.ts).
- One definition per question, shared by every caller: `narrationTargets` decides which lines a scope
  runs, `segmentFailed` decides whether a line still carries a failed request, and `chapterNarration`
  decides what a chapter's narration reads as once nothing is in flight — the server's narration job
  when a run finishes or is cancelled, a restore (`planRestore`) and a script import all call it,
  because one that answered differently would simply be overwritten by the next thing that happened
  to the chapter. A chapter that is only part rendered reads as `failed`, which is what turns into
  the export's "Partly narrated" blocker (`readinessOf`): a line with no clip is a gap in the
  audiobook, and reading it as `stale` instead would demote that hard blocker to a warning the build
  can be told to ignore. `changedSegments` is the one definition of "lines the script has moved past"
  (stale clips, plus unrendered ones once the chapter has been narrated at all), shared by the job ledger's
  "Re-narrate changed (N)" and the lexicon panel. A second copy of any of these is how a panel starts
  quoting numbers the run does not honour.
- **The plan is the account of the run, including the estimate.** `narrationRunPlan` and
  `scriptPlan` decide which chapters are in and which are left out; `narration.estimate` and
  `scriptEstimate` price exactly what they chose rather than re-deriving the excluded, unscripted
  and running cascade. `plan.pending` counts the retakes a selection is waiting on across _every_
  eligible chapter, including one that is skipped precisely because everything in it is waiting on a
  retake. For scripting, "is there a script to replace" is asked of the chapter's status
  (`isScripted`), which the server keeps and a failed re-script puts back — so a chapter whose script
  no page has read yet is still counted as a replacement.
- Jobs of one bulk run share `Job.bulk.id`, which the server assigns, and that is what makes "cancel the
  rest of this run" (`cancelRun`) and "retry this run's failures" (`retryRunFailures`) possible without
  the queue guessing. Cancelling keeps what finished; a retry uses the narrowest scope that covers the
  failure, so it never re-renders work that succeeded, and it is submitted as **one** run rather than one
  run per chapter, held to the same blockers as the run button (`startRun`). **Whether a chapter still needs the work is asked of the work, not of the chapter's
  label**: a failed replacement leaves the chapter reading as narrated and a failed re-script leaves it
  reading as scripted, so retry eligibility comes from the clips (`segmentFailed`) and from the queue
  (`_supersededBy`) instead. `retryableFailures` is the one list — one job per chapter, its newest
  failure — `retryAllFailed` iterates it, and the queue's "Retry failed (N)" button reads it too, so the
  count it offers and the work it does cannot disagree.

## Pricing and usage invariants

- **A cost is worked out once and then it is a receipt.** [lib/pricing/](../lib/pricing/) is the only place that
  decides what a request of either kind costs, and it is pure: a rate card plus an instant always give the same
  answer. The browser's estimates and the server's ledger price through it alike. It is also the only place those
  symbols are imported from: [lib/endpoints.ts](../lib/endpoints.ts) adapts an `Endpoint` onto them (`billingOf`,
  `speechPricing`, `pricingLabel`) and does no pricing arithmetic of its own. What a rate card costs and what time
  it is in Tokyo are two subjects, not one: a schedule is written in the endpoint's own timezone, so
  [lib/wallClock.ts](../lib/wallClock.ts) owns zones, offsets, day boundaries and the phrases that say when
  something changes, and knows nothing about rates. The pricing rules read the clock; the clock never reads a rate
  card. `crossesMidnight` and `windowCovers` stay with pricing, because a window's past-midnight
  rule is a pricing rule rather than a fact about time.
- **The ledger is the server's, and it is append-only.** Every request that settles — of either kind, successful
  or not — is one row in the server's `requests` table with the receipt it was priced from (`PricedRequest` for
  tokens, `SpeechCharge` for a clip), and nothing moves, re-prices or removes one afterwards
  ([server/usage/ledger.ts](../../server/usage/ledger.ts)). Rates are read **per request, at the moment it
  completed** (`PRICING_RULE`), so a run that crosses an off-peak boundary or a promotion expiry charges its
  requests differently either side of it, and editing a rate or letting a promotion expire cannot move spending
  that has already happened. A view that re-derives a past cost from the endpoint's current card is how that
  guarantee gets lost; read the receipt instead. Spending was once totalled from the clip currently on each line,
  which lost real requests: a failed render cost nothing, and accepting a retake made the money spent on the clip
  it displaced **disappear**. The record does not live on the artefact, because the artefact moves; a clip
  carries its `SpeechCharge` (`SegmentAudio.charge`) and `snapshotTake` keeps it when the clip joins the take list,
  so a superseded recording still says what it cost.
- **Every figure read from the ledger is the server's.** `jobs.spent`, `reserved`, `scriptSpent` and
  `scriptReserved` answer with the `BookSpend` that `useBookSpend` or `useLibrarySpend` read (`spendOf`), and with
  `undefined` until one of them has — not read is not the same as nothing spent, and a panel says it does not know
  yet rather than showing a budget untouched. The figures are the ledger's
  sums plus the book's opening balance, which only the seeded demo has (see
  [backend](../../docs/backend.md#what-a-request-costs-and-what-a-book-may-spend)). The Endpoints page's charts and
  totals are summed by the server over every row in the range (`useEndpointSummaries`) and its Activity list is
  read a page at a time (`useEndpointRequests`); the Scripting page's health dots, latency, last error and the
  estimate's observed cache rate read a profile's latest rows (`useEndpointHistory`, through `useScriptActivity`,
  worked out by [lib/scriptActivity.ts](../lib/scriptActivity.ts)), and its seven-day figures the server's sum over
  every request in them (`useScriptTotals`). No store keeps a counter of its own.
- **Cached tokens are a slice of the input, never an addition to it.** `TokenUsage.inputTokens` is
  the total and `cachedInput`/`cacheWrite` are parts of it, so the charge lines always add back up to
  what the provider reported. Providers disagree about this — OpenAI's `prompt_tokens` includes the
  cached tokens, Anthropic's `input_tokens` excludes them — so nothing reads a payload directly:
  `normalizeUsage` is the one way in, and the server's scripting providers, the simulated one included, go through it.
  `cachedInput: null` means the provider did not say and is never treated as zero: those requests are charged
  conservatively at the ordinary rate and their cost is labelled `estimated`, never presented as a reported cache
  miss. The observed cache rate leaves such requests out rather than counting them as misses. A cost the provider
  reported itself is kept distinct from ours (`CostBasis`), and both figures survive on the receipt.
- **Both kinds of endpoint share one pricing engine.** A speech rate goes on discount exactly the
  way a token rate does: the same `PricingConfig`, the same windows, the same promotions and the
  same precedence. What differs is which components a card prices — `TOKEN_COMPONENTS` against
  `SPEECH_COMPONENTS` — and that a speech rate is written in whatever unit its endpoint bills in, so
  that unit travels with the rate (`rateSuffix`, `rateWithUnit`) everywhere it is shown. The panels
  take the components and the unit as props rather than inferring them. The receipts differ because
  the two kinds measure different things — `PricedRequest` holds tokens with the cache split,
  `SpeechCharge` holds character and byte counts, text and audio tokens, audio seconds and request count — and they
  meet in `ChargeLine`, which is what lets one table in the Activity list render both. A clip is priced when it
  **lands**, never when it is dispatched, because a per-minute endpoint has no audio to bill for until then.
- **A rate that is not known stays unknown through every discount.** `speechRates` puts `null` in
  the card — for an unknown rate _and_ for every component this model does not price, so nothing can
  invent a charge for something the endpoint does not bill for — and `resolveComponent` leaves a
  null component alone, so a window or promotion over an unknown rate changes nothing and the page
  says so rather than inventing a number. A two-rate card with one rate missing prices **nothing**
  rather than half of each request (`speechRateKnown`). The narration estimate counts those requests
  in `unpriced` and calls its total a floor. Zero is a different thing entirely and reads as "free".
- **An estimate's two halves are reported separately.** `SpeechEstimate` returns `inputCost` and
  `audioCost` beside the total because they are worked out from different things: the input side from
  the text that will be submitted, the audio side from the audio's expected length and the endpoint's
  tokens-per-second setting. What a line will submit is measured by `plannedSpeechUnits` in
  [lib/narrationCost.ts](../lib/narrationCost.ts) on the line's reading (`narration.reading`, from
  `prepareReading` in [lib/reading.ts](../lib/reading.ts), taken on the endpoint the voice names even
  when it no longer lists the voice — `endpoints.endpointOf` — since that is where the server sends it) — after the dictionary and the expression tags,
  with the voice instructions beside it, in as many requests as the endpoint's limit cuts it into — the
  same reading and the same measurement the server takes when the request goes out. The
  server records both halves on the job when it dispatches a chapter (`Job.narrationRun.estimated{,Input,Audio}`),
  and the Queue's job details show them. Generated audio is the clip's own duration; silence stitched between
  clips is never rendered and is never billed.
- **A budget is checked against the price with no discount and no cache saving.** A promotion can
  expire and an off-peak window can close while a run is still going, so a cap that only holds while
  a discount lasts is not a cap: `tokenEstimate().reserve` and the blockers in `scriptEstimate` use
  the dearest rates the card can reach (`ceilingRates`) and the full output ceiling. That is not the
  base card: a window can raise a rate too — DeepSeek's card is its off-peak price and its peak
  hours double it — so every window is tried, not just none. The discounted figure and any cache-adjusted
  figure are shown beside the conservative one, labelled, and used for neither. The input side is
  reserved at the **dearest** rate any input token could be charged at (`dearestInput`), not at the
  ordinary input rate: cached and cache-write tokens are slices of the input and a cache write
  usually costs more than it, so reserving at the ordinary rate lets the first request exceed its own
  reservation. Narration's figure is `worstCase`, a **per-endpoint sum** of undiscounted prices and never
  one maximum over the aggregate: two endpoints on different discounts do not add up the same way, and
  `Σ max(aᵢ,bᵢ) ≥ max(Σa, Σb)`.
- **The gate is the server's; the stores only say what it will say.** The server prices a run at its worst
  case before queuing anything and refuses one that does not fit with a 409, holds each job's share until it
  lands, and asks again before every request it sends, so two runs that each fit cannot both start and overshoot
  together ([server/usage/budget.ts](../../server/usage/budget.ts)). `runScripting`, `runNarration` and a retake
  mark nothing before it answers and show its refusal as it is. The sentences a run strip shows come from
  `narration.blockers` and `scriptEstimate`, built on the same figures the server reserves, because a panel that
  worked the figure out a second way is a panel that green-lights a run the server then refuses. A run is
  refused on them before it is asked for, too: `scripting.startRun` and `narration.startRun` read what the
  blockers are worked out from when no page has (the text or the scripts, the cast, the spending), and every
  run button and every retry from the Queue goes through one of them. `runScripting` and `runNarration`
  check nothing of their own.
- **One grouping, several readings.** `_pricedByEndpoint` is the only place in the browser that splits a run's
  lines by the endpoint that owns each speaker's voice and prices each share on its own card. The estimate panel
  keeps every column and `worstCase` keeps the undiscounted figure — reductions over one calculation, so the strip
  cannot quote a figure the panel never showed.

## Undo and irreversible actions

- **One rule for danger: if it can be undone, it happens at once and offers Undo; if it cannot, it asks first.** Deleting, renaming or merging a speaker, removing an alias, removing a voice, an endpoint or a scripting profile, skipping, including or keeping chapters, changing the dictionary, editing, splitting, joining or deleting lines, a bulk correction, a restore, a checkpoint, a script import and assigning voices by gender all act and toast with Undo (`⌘Z` afterwards, ten deep), so none of them asks. An undo that goes through the server is exact where the server can make it so: a rename renames back, a merge or a removal puts back exactly the lines that moved (`attribute`), a skip or keep puts back the recorded decisions (`_restoreDecisions`), and a dictionary change names back exactly the clips it staled.
- Removing a novel, removing a volume and deleting an audiobook cannot be undone — nothing puts a book, a volume or an audiobook back in the database — so the book menu, the volume row and the Audiobooks list ask with a second click, the control's `title` says what will go, and the toast says "This cannot be undone" rather than offering a button that would lie. Discarding an import in the contents review cancelling the rest of a run in the job details and cancelling a chapter's run from the script history ask the same way. A retake's verdict neither asks nor offers Undo: the displaced clip stays in the take list, where the comparison can be made again.
- Undoing an endpoint's removal puts its configuration back, but not a key the server dropped with the row once the removal was written ([backend](../../docs/backend.md#known-gaps)).
- A new destructive action belongs on one side or the other: give it an undo and let it act, or make it ask. What a confirmation step would have explained goes on the control that starts it (label and `title`) and in the toast's description, including anything Undo cannot bring back.

## Verification

For store behaviour changes, run `bun test tests`, the existing lint command and the production build. See the [verification guidance](../../docs/development.md#verification-and-test-maintenance) for other changes. The stores are tested against the HTTP services on a private library or a seeded demo library in-process ([tests/support/demoServer.ts](../../tests/support/demoServer.ts)). [tests/danger.test.ts](../../tests/danger.test.ts) covers the undo rule on both sides, [tests/demoStore.test.ts](../../tests/demoStore.test.ts) the Demo drawer's store, and [tests/jobsBackend.test.ts](../../tests/jobsBackend.test.ts) the queue and script writes; [tests/bulkRuns.test.ts](../../tests/bulkRuns.test.ts) covers running a stage again over chapters that are already finished, and pricing is covered three ways: [tests/pricing.rates.test.ts](../../tests/pricing.rates.test.ts) for what rate is in force at a given instant — schedule boundaries, discount precedence and promotion expiry — [tests/pricing.tokens.test.ts](../../tests/pricing.tokens.test.ts) for token accounting, contradictory usage counts and reservations against a budget, and [tests/pricing.speech.test.ts](../../tests/pricing.speech.test.ts) for speech rates, billing models and what each provider reports. [tests/scripting.test.ts](../../tests/scripting.test.ts) covers the scripting estimate's blockers, and [tests/server/usage.test.ts](../../tests/server/usage.test.ts) the ledger itself: receipts priced at the card a request completed under, a book's spending, and the budget gate.

## How stores reach the server

Each service is a function that always answers — `libraryService()`, `jobsService()`, `usageService()`, `endpointSettingsService()`, `demoService()` — with the HTTP implementation for this tab's `API_BASE`, unless a test set another. A store keeps the requests in its own actions rather than in the views, so no page has to know how a change reaches the server, and a view reads the store or a query, never a service. The shelf, the book a page opens and the endpoint configuration are read when the router resolves (`library.load` and `loadBook`, which read through `fetchShelf` and `fetchBook`, and `endpoints.load`); everything else is read by the queries below as pages open.

Changes take one of two shapes, chosen by how the control is used.

- **Ask first, then install the answer.** Anything that moves more than the value on screen: importing and confirming a book, skip, include and keep, removing or moving a volume, removing a book, a rename, merge or removal of a speaker, a retake and its verdict, queuing a run, a build, a cover. Moving a volume asks the server first, since it renumbers everything filed under a chapter number and the server refuses it while a build or a volume's review is open; only then does `_renumber` move this side by the same rule, and the book and chapters the server answered with are installed over the result.
- **Change at once, write behind.** Inputs a person types into or toggles: a book's budget cap, pause, scripting budget and pacing and a volume's name (`library._writeSettings`, last one wins, so a late answer never puts back a value already typed past; a refused write reads the book back), a speaker's own fields (`cast._push`), the dictionary written whole (`_pushLexicon`), a script edit (`scripts._commit`, below), and the endpoint configuration. Changing the pacing re-times here only the chapters whose clips have been read, and takes every narrated chapter's length from the server's answer.

The endpoint configuration is written behind as one document. The page binds its fields straight onto the endpoint objects, so rather than a request per action the store watches one serialised projection — the endpoints without their telemetry (`ENDPOINT_TELEMETRY`) and their key, the profiles and the credential registry (`credentials`, names only) — and sends the whole of it `WRITE_DELAY_MS` after it last changed. One writer (`_save`) sends it, and only one write is ever out: two whole documents out at once could land in either order and leave the server on the older one, so a change made while a write is out goes in the one write owed after it, which takes the configuration as it stands when it is sent — coalesced, never a queue of old copies. An installed answer is not sent back, only the answer to the latest change is installed, and a refused write is said and the configuration read back. A key is the exception: the server keeps it and never sends it back, so `saveKey` puts it beside the configuration for the next write through the same writer, with `apiKey` on that one entry of that one write; no store object ever holds a key, and `hasKey` from the answer is what the page shows (`keyInPlace`). `saveKey` resolves true once its key has landed. `flushWrites` sends any write still waiting and resolves once every edit made so far is on the server — a write already out, and the one owed for what was typed while it was out, included — with how the last of those writes went (`SaveOutcome`: `landed` or `refused`), which is what `testSaved`, a voice fetch and a scripting run wait on before asking the server to act on what it saved. The watch and its bookkeeping are module state, so the store that loads is the one watched: a second Pinia's store takes them over rather than leaving the first one's watch sending. What the server's speech gate has seen of each endpoint — lines out and held, rate limits, the end of a cooldown — is read by `useEndpointLive` while narration is live and once after; `_installLive` puts the rate limits and cooldown on the endpoints, and the counts stay in the query, where `live` and `serverLoad` read them for the Endpoints and Queue pages. The same read counts the clips each endpoint rendered that the library plays, done and failed, from what the server stores, so the Queue's pool is not limited to the chapters this tab has read. All of it is telemetry, so none of it is ever sent back. Every endpoint and profile the store takes on — read, added or imported — has its operational defaults and its pricing block filled in there (`ensureOps`, `ensurePricing`), and filling them in is not an edit to send.

The queue is the server's, and nothing in the browser edits it. `useBookJobs` reads it, polling while anything is live, and the jobs store's `jobs` is that read as the query cache holds it; a run is queued by a request whose answer carries the chapters as the server marked them, and cancel, remove and clear are requests too, never local marks — a cancel that did not reach the server must not look like one that worked. The budget is the server's as well (see the pricing invariants above).

The demo is a second library on the same server, chosen per tab when the page loads ([mode.ts](../services/mode.ts)) and never as a fallback from yours. `demo.ts` lists the server's situations, applies one or resets the demo through [server/routes/demo.ts](../../server/routes/demo.ts) and then loads the page again, so every store, query and piece of page state reads the new world from scratch and nothing from the old one is left to reconcile. The server does not remember which situation it was put into, so the store keeps the one it applied in the tab's `sessionStorage` for the chip and the drawer to show; a reset clears it. The speed of the demo's simulated work is the demo library's, read from it and set on it. See [the demo](../../docs/demo.md#how-the-demo-is-built).

## Reads are queries

**A store owns state and every change to it; a query is how a page asks for what a store holds, and how that state is read from the server and kept fresh.** [src/queries/](../queries/) holds one composable per resource, on [Pinia Colada](https://pinia-colada.esm.dev): `useShelf`, `useBook` and `useBooks`, `useChapterText`, `useChapterScript` and `useChapterScripts`, `useChapterHistory`, `useCast`, `useBookExports`, `useBookJobs`, `useBookSpend`, `useLibrarySpend`, `useEndpointHistory`, `useEndpointSummaries`, `useEndpointRequests`, `useEndpointLive`, `useScriptActivity` and `useScriptTotals`. What a person edits is installed into the store that owns it (`_install`), so the store stays the working copy every page reads and every edit acts on: the books and chapters, the scripts, the histories, the cast. What nobody edits in the browser — the queue, the spending, a book's audiobooks, the speech gate's counts — is not copied: it stays in the query cache and the owning store's getters read it there (`jobs.jobs`, `jobs.spendOf`, `exports.exports`, `endpoints.live`). A query function installs only while its read has not been overtaken — a later read aborts an earlier one — so two reads of one thing cannot land out of order. A store that needs the server's answer now, whether or not a page is reading it, goes through the same entry: `fetchShelf`, `fetchBook`, `fetchScript`, `fetchHistory`, `fetchCast` and `fetchSpend` make the entry when nothing holds it (an invalidation only reaches entries that exist) and read it afresh. A store that needs a read synchronously takes whatever the query cache already holds (`chapterTextNow`, `scriptActivityNow`) and treats nothing read yet as nothing; a script is here or not (`scripts.held`), which is not the same as a chapter with no lines. A read that fails stays in its entry's error state rather than reading as nothing: `useChapterScripts` says which chapters failed and reads them again on `retry`. A page that shows a chapter's figures without its script reads the line counts the server lists each chapter with (`Chapter.lines`), through `scripts.lineCountsOf`, which counts the script instead once it is here. Keys are filed under the book ([keys.ts](../queries/keys.ts)), and a store that changes something a query reads invalidates it by key through `invalidate` — a renumbering or a removal invalidates everything under the book (`library._forgetBook`), a queued or cancelled job invalidates the queue (`jobs._changed`), a build invalidates the book's exports, and a budget written invalidates the spending (`library._budgetMoved`). The queue's poll does the rest ([jobs.ts](../queries/jobs.ts)): a job that moved has its book read again (`fetchBook`), its spending and the endpoints' requests invalidated; a finished scripting job invalidates the chapter's script and history and the book's cast; a narration job that moved invalidates the chapter's script, so clips appear as they land; an export job invalidates the book's exports, which is also how a cancel — the server deletes the row it was writing — reaches the page; and while narration is live the speech gate is read again. A new read belongs in `src/queries/`, not in a store.

**Writes are the store's, and they are write-behind.** An edit in `scripts.ts` acts on the store at once and ends with `_commit`, which writes the chapter's script as it now stands with the revision it was read at (`_revision`); writes for one chapter are serialised and coalesced, and a batch driving the per-line actions inside `silence()` commits once under its own name. A refused write — the server's script moved — reads the server's script and history back over the local ones (`fetchScript`, `fetchHistory`), and says so. A read of a chapter that arrives while an edit of it is on its way or waiting to go — the queue's poll reads a chapter again as each clip lands — is put off rather than installed, since it would put back what was just typed and the waiting write would then send it; the chapter is read again once its writes have landed. An expression, a pause and a clip's status live on the script's lines, so `narration.ts` and `cast.ts` commit them the same way. A flag is the exception: it changes nothing a version keeps, so `flagSegment` writes that line's flag alone (`_writeFlag`), naming no revision a run landing clips could have moved on, and a flag batch does the same a line at a time. The server still moves the revision on for it, so it takes its turn among the chapter's writes (`scripts._writeLine`): an edit already on its way goes first, and one made while the flag is out waits and names the revision the flag answered with. The revision is never written backwards, whichever answer lands last, and `_settled` resolves once a chapter has nothing on its way. A caller that reports or undoes only what persisted saves through `_save` instead of `_commit`: it resolves true once the write carrying the script as it then stood has landed, and false when that write was refused (and read back over). An import and a restore write a chapter through one helper, `history._rewrite`, which replaces the script, sets the chapter's status, absorbs and re-times, saves, and hands back whether it landed and an undo that touches nothing when it did not. The cast store's changes are requests too, and every one of a book's — a speaker's own fields, a rename, a merge, a removal, the dictionary — goes through one writer for the book (`cast._write`), one at a time in the order made, a second push of a speaker still waiting joining the first. What each answers is put in place in one place (`_answered`), and only for the half — the speakers or the dictionary — that no later write waits to send, so an older answer never puts back a newer edit; a read of the cast arriving while a write is out or waiting — or one a write was answered under, arriving after they have all landed (`_readAt`) — is put off and made again once they have landed, as a refused write's read back is, and `_castSettled` resolves once the book has nothing on its way. A change made for another store writes itself in the same step (`_addSpeaker`, `_patchSpeaker`, `_addTerms`), so no answer can land between the two, and a speaker a rewrite absorbs waits for its chapter's write: one only a refused chapter named is taken off again unwritten. A rename, a merge or a removal that moves lines on the server applies what moved here (`_moved`, through `scripts._applyLines`) — only in the chapters whose scripts are here: one not read yet reads the moved lines, and its revision, with its script. The dictionary is exact the same way: the server stales every clip whose recorded pronunciation the new list no longer sends, by the rule `_lexRestale` applies here (`pronunciationMoved` in [lib/reading.ts](../lib/reading.ts), which the dictionary dialog's count and the drift rule use too), and answers with those lines and each chapter's new revision, which `_pushLexicon` adopts; the Undo waits for that answer, reverts, and sends the old list naming exactly those lines, and the server puts back to done the ones that read it again. Building an audiobook sends the selection and the settings, marks nothing of its own, and adds the entry the server answers with to the book's list — the refusals are the server's, in the same words the page's blocker panel uses. A build names its cover by a url the server gave for the book, never by the image itself, so `chooseCover` uploads a picked JPEG or PNG through `uploadCover` and puts the url it answers with in the settings; a refusal, the server's or the up-front check on the file's type, leaves the cover as it was.
