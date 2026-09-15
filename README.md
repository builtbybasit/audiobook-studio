# audiobook-ui — PROTOTYPE

Throwaway Vue 3 prototype answering **"what should the audiobook pipeline UI look like?"**
Front-end only. All data is mocked in `src/mock/data.ts`; jobs are simulated with timers in `src/stores/app.ts`. Nothing persists except reader typography preferences (localStorage).

```bash
pnpm install
pnpm prototype        # opens http://localhost:5173
```

## Pages

- **Library** → **Book overview** (volumes, per-stage progress, cast summary, "what next") → stages **Scripting / Narration / Export**.
- **Cast** (per book): every speaker across all chapters, line counts, first appearance, merge suggestions for near-duplicate names, bulk merge.
- **Queue**: all jobs across books with cancel / retry / remove, endpoint pool utilisation. Click a job to open its activity log and run details.
- **Endpoints**: every scripting and speech endpoint in one place — health, throughput, spend, request history, connection, limits and budgets.

## Stages

Library → Scripting → Narration → Export. Pick a book in Library; the other stages unlock for it.
A novel may span several EPUB files: each file is a **volume**, chapters number continuously across volumes, and the cast is shared. Add a volume from a book card or from the Add EPUB dialog.

## Decisions taken (2026-09-12)

Six structural variants were prototyped (three per screen) and compared via a `?variant=` switcher. The winners are folded in here; the full set lives on the `prototype/all-variants` branch.

| Screen           | Winner                                                                                     | Why                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Scripting review | **Reader** — prose + dialogue cards, toggleable in-chapter cast rail, `Aa` typography menu | reads like the book; the grid and cast-first layouts were better for bulk fixes but worse for judging the script |
| Narration job    | **Ledger** — filterable per-segment log with sticky player                                 | failures and playback are the everyday task; the timeline and per-endpoint lanes were prettier but less useful   |

Ideas borrowed from the older narrata web UI: major/minor cast split with Narrator-voice fallback, auto-assign by gender, spoiler-hidden descriptions, a "This run" cost estimate with blockers, endpoint price / no-key badges, per-chapter segment counts, reader filters.

## States worth knowing

- Scripting: `done`, `fallback` (a chunk didn't verify → kept whole as narration, retry per chunk from the reader), `failed` (nothing kept; try smaller chunks).
- Narration: `done`, `stale` (script edited after narration → "Re-narrate changed" renders only those segments, including halves of a hand-split line that were never rendered), `failed` (per-segment retry).
- A segment can hold several **takes**. `segment.audio` is always the clip in the book; a retake renders into `segment.candidate` and replaces nothing — not the player, not the chapter length, not the export — until it is accepted. Rejected takes stay in the row's details.
- Narration is also `stale` when the **pronunciation dictionary** changes under a clip that used the old spelling. A **pause** never makes anything stale: it is stitched, not rendered.
- Endpoints back off for a few seconds on a simulated rate limit; health strip shows latency sparkline, ok rate, failures, 429s.
- **Voices belong to endpoints.** Each endpoint card lists its voices (fetch from the server, add by id, remove); character pickers are grouped by endpoint, and a paused endpoint's voices are listed but disabled. A character's voice is a ref `endpointId/voiceId`, so every segment is rendered by the endpoint that owns its speaker's voice (unvoiced speakers borrow the Narrator's). Removing a voice or pausing its endpoint shows up as a blocker on the voice card and in "This run"; segments that can't be routed fail with a reason instead of hanging.
- **Per-request character limit** per endpoint (`maxChars`, 0 = whole segments). Longer segments are sent as several requests and joined; the endpoint card says how many segments of the open book would split, the run estimate counts requests and splits, and the ledger marks rows "N parts · M ch" (click to see the exact cuts). **Cut at** chooses the boundary: sentence end, clause (`, ; : —`), word, or hard cut; when the preferred boundary doesn't occur inside the window it falls back to the next finer one and the part is flagged. The endpoint card previews how the longest routed segment of the open book would be cut (`src/lib/split.js`).
- **Command palette** — `⌘K` / `Ctrl+K` (or the header button): reka Dialog + Listbox with `useFilter`. Jump to any page, novel, chapter (opens it at the stage it's at via `?ch=`), speaker or endpoint, or run actions: script pending, narrate scripted, re-narrate changed, retry/cancel jobs, auto-assign voices, pause/resume an endpoint, toggle theme. Enter with nothing highlighted runs the first match.
- **Volumes are sortable** (drag the handle or ▲▼) and can be **renamed and removed** from the book overview (wrong EPUB added). Reordering renumbers chapters so they follow the volume order. Removing one deletes its chapters, segments, jobs and export entries, renumbers the remaining chapters so numbering stays continuous, and removing the only volume removes the novel.
- Reader keyboard: `j`/`k` move, `↵` edit, `1–9` assign speaker, `s` split, `m` join next, `[`/`]` pause, `c` toggle cast.

## Round three (2026-09-14): gaps, friction, responsive, backend-shaped

- **Chapter peek & skip** — every picker row has a ⌕ popover with the raw text and word count and a "Skip this chapter" toggle; skipped chapters leave every stage, the run totals and the audiobook.
- **Re-script** from the reader header: profile + chunk size, "keep my N manual edits" (re-applied where the text still matches), then a "what changed" panel (speaker / direction changes, new / gone segments, click to jump). Edited segments carry `edited: true`.
- **Undo** — merge, rename, delete speaker, remove volume / novel / endpoint / voice, delete export all toast with Undo; `⌘Z`/`Ctrl+Z` outside a field undoes the latest. Snapshots in `_castSnapshot` / `_bookSnapshot`.
- **Export**: custom cover, chapter markers with a title pattern and preview, listen / download / on-disk path per finished file.
- **Script search** (`/book/:id/search`, or type ≥2 chars in the palette): text, speaker, direction across every scripted chapter; results deep-link to the segment (`?ch=&seg=`).
- **Audit trail**: each rendered clip records voice, model, direction, style, type, time, cost. Clicking a ledger row (or `i`) shows it and spells out what differs from the script now (why a row is stale). Failures carry HTTP status + body and a "copy request".
- **Voice picker** popover (search, gender filter, grouped by endpoint, "N using", inline demo) replaces the flat select on Voices and Cast.
- **Direction** is a combobox: presets + directions already used in the book, free text allowed, and "→ all <speaker>" applies it to every line of that speaker in the chapter.
- **Stale nudge** in the reader header and the sidebar count; endpoint pool is now a master/detail list; queue shows an ETA and can notify when a book's run finishes; keyboard on picker / ledger / cast (`?` lists everything).
- **Responsive**: sidebar becomes a drawer under `lg`, stage layouts stack, tables scroll inside their cards.
- **Backend-shaped**: API keys live in `src/lib/keyring.js` (reactive, in-memory, never in the store or the settings file); settings export/import as JSON; per-book budget cap + "pause everything on this book"; `spent()` from recorded clip costs. Persistence and resume are left to the real backend on purpose.

## Round four (2026-09-14): audio review and segment boundaries

The two things a listener cannot do without once the pipeline runs end to end. A request that succeeds
can still produce bad audio, and the model's idea of where one segment ends is not always right.

**Audio review and retakes** (narration ledger). Any rendered row can be flagged — _wrong
pronunciation_, _bad delivery_, _awkward pause_, _something else_ — with a note (`f`, or the ⚑ button;
`⚑ Retake flagged (n)` does the whole chapter at once). `↻` (or `t`) queues a **retake**, which renders
into `segment.candidate` — a clip of its own, standing _beside_ the one in the book. Nothing else in the
app reads it: while it renders and while it waits, the chapter still plays, still times and still exports
the accepted clip, so **nothing is applied until you choose**. The row opens a compare panel with both —
play either, see what differs (direction, voice, style, pronunciation, or the line itself) — and
`Keep take 2` / `Keep take 1` (`a` / `x`) decides. Keeping the new one moves it into `segment.audio` and
pushes the old clip into the take list; keeping the old one drops the candidate, marks it rejected in the
list, and leaves the flag up, because the complaint is still true. A kept clip is then re-checked against
the script: if it went out of date while the retake rendered, it says so instead of passing as current.
Every take stays in the row's details panel with its own play button. Flags also show on the line in the
script reader — a mispronunciation is usually fixed there, not by rendering again.

The ledger row was compacted to make room for all this: the line itself gets the space, speaker / voice
/ endpoint share one column, and every action is one icon size in a fixed slot — ▶ stays, `⇥ ↻ ⚑`
appear on hover or keyboard focus (always on touch), so a raised flag is the only standing mark.
Clicking a row (no `i` button) opens its details: one strip of labelled facts — voice, endpoint, model,
type, time, latency, cost, then style and direction last, where a whole-phrase direction can run as long
as it needs to — then, only when they apply, an amber line saying how the
script has moved since the clip with `Render it again` next to it, the failure with its response body,
every take as a play chip with the one in the book marked, and the per-request cuts folded away.

**Segment boundary corrections** (script reader). Open any line and use **Boundaries**: `⁄ Split…`
(`s`) turns the text into clickable word gaps — sentence ends are marked `⁄`, click a gap to cut there
— and `⌃ Join up` / `⌄ Join next` (`m`) fold a line into its neighbour, the tooltip naming the
neighbour and warning when the speakers differ. A split keeps speaker, type and direction on both
halves and opens the second one, which is usually the half that needs a different speaker; a join keeps
the first line's attributes and carries over any flag. An unverified chunk can be split by hand as well
as re-split by the model — doing so drops the "unverified" mark, since the boundaries are yours now.
Both actions are undoable (toast, `⌘Z`) and both invalidate the audio they touch: the line that changed
goes stale, a new half has no audio at all, and `↻ Re-narrate changed` covers both. The whitespace a cut
falls in is prose, not padding: a split records it on the first half (`segment.sep`) and the join that
undoes it puts it back, so a paragraph break survives the round trip character for character.

`pnpm test` covers the store side of all of this in `tests/segments.test.ts`: the prose survives a
split (paragraph break included, and the join restores it), halves and joins carry the right state, a
retake leaves the book's clip and the chapter's length alone while it renders and after it lands, and
dropping one leaves the kept clip exactly as it was — with its audit trail, and marked stale if the
script moved under it meanwhile.

## Round five (2026-09-14): pronunciation and pacing

Both change how the book _sounds_ without changing a word of it, and they sit next to the voices they
affect — Narration → **Pronunciation**.

**Per-book dictionary.** `term → say it as`, applied to every request on its way out; the reader, the
export and the script files keep the author's spelling. Longest term wins (`Ji Ning` over `Ning`),
matching is whole-word and case-insensitive unless you tick _match capitals exactly_ (for `Qi` vs
`qi`), a replacement is never itself re-matched, and an entry can be switched off without losing it.
Each row shows how many times it occurs in the scripted chapters and opens a preview of a real line,
before and after. Words the dictionary rewrites are underlined in the reader (hover for the
respelling); a rendered clip records what was actually sent (`said`), so the ledger can show `sent …`
in its details and tell "the script changed" apart from "the dictionary changed". Because a clip
rendered with the old spelling is now wrong, editing an entry marks exactly those lines stale (one
undoable toast, with `↻ Re-narrate them` for the whole book) — including a request that was still in
flight when it was edited, which lands stale instead of passing as current. Every render is checked
against the script the moment it comes back (`clipDrift` in the store is the single definition of "this
clip no longer matches", shared by the ledger's amber line, a finished render and a rejected retake).

Reach it from where the problem is heard: flag a clip as _wrong pronunciation_ and the popover offers
the likely word with **Add to dictionary**, which opens the tab with it already in the box. A retake
alone would read the same spelling again.

**Pacing.** Silence is stitched between clips, not rendered, so it costs nothing and invalidates
nothing. The book has two defaults — after a line, and when the speaker changes — and any single line
can override them from the reader's **Pause after** row (`book · 0.7s`, `run on`, `0.25s` … , or
`[` / `]` to nudge). A line that holds shows the gap where it falls in the prose, the chapter's length
includes it everywhere it is quoted, and the ledger's scrubber draws the silence between clips.

`tests/speech.test.ts` covers the matcher (whole words, longest first, match case, no cascade), the
gap rules, and the store: the endpoint gets the respelling while the script does not, a term change
stales only the clips that used it and undo puts them back, and a pause re-times a chapter without
touching a single clip.

## Round six: one player, app-wide (2026-09-15)

The player was a per-view timer: `usePlayer()` returned fresh state to every component that called
it, so leaving the narration page stopped the audio, and a chapter was one undifferentiated block of
`total` seconds. Reviewing a book is the opposite of that — you listen _while_ fixing the script, the
cast or the dictionary, and you listen for hours.

`src/composables/usePlayer.ts` is now a **singleton sequencer**. Its unit is not a file but a
**queue**: clips with the stitched silence between them (`pauseAfter`), the same timeline the ledger
already drew. It owns the layout, the gaps and the playhead; an `<audio>` element is only the sound
source, and the reactive media state around it (`currentTime`, `rate`, `waiting`, `ended`) comes from
VueUse's `useMediaControls`, which was already a dependency. No player library models a timeline of
many short clips with computed silence, so none was added.

- **It survives navigation.** The state is module-scope, and `components/MiniPlayer.vue` follows you
  off the page that started it — transport, speed, elapsed, and a link back to where it came from. It
  hides on that page, which has the better player of its own.
- **Listening controls.** Playback speed to 2×, ±10 s, previous / next _line_ (prev restarts the line
  unless you only just started it, as every media player does), `space` to play or pause anywhere
  except while a button or link has focus, and OS media keys / lock-screen metadata through the
  MediaSession API.
- **A chapter boundary is not a stop.** A queue carries a `next()`; the ledger's continues into the
  following narrated chapter and moves `?ch=` with it, so the ledger follows the player.
- **Clips carry a `url`.** `SegmentAudio.url` and `Take.url` are the seam: with a file the element
  plays it, without one the clip is _timed_ rather than heard — same timeline, same scrubber, same
  gaps, silent. The prototype renders no files, so the bar says "timed, not heard" rather than
  pretending. Give the clips urls and the same code path plays them.

**Waveforms in the retake compare panel** (`components/Waveform.vue`, [wavesurfer.js](https://wavesurfer.xyz)
v7). Judging two takes of a line is partly a thing you see: dead air, a clipped ending, a flatter
read. wavesurfer is used **directly**, not through a community Vue wrapper, for the reason Unovis is
on the endpoints page — and here a wrapper would be in the way, because this component *draws* and
does not *play*. The app has one playback engine, so the element stays out of wavesurfer's hands:
`interact` reports clicks as seek requests and the playhead is pushed in from outside with
`setTime`, which works with no media attached because `getDuration()` falls back to the decoded
peaks. `usePlayer().clipProgress(id)` answers "how far through this clip is the playhead", so a view
can ask about any clip it drew without knowing where in the queue it sits.

With a `url` wavesurfer decodes the real file. Without one there is nothing to decode, so
`lib/peaks.ts` invents a speech envelope — syllables about four a second, a breath or two, seeded by
the clip's identity so a take's shape is stable across redraws and two takes look related but not
identical — and the panel says **waveform illustrative** next to what differs. Invented, and marked
as invented, like every row `FixtureEndpointService` produces. The library is a lazy chunk
(12 kB gzip) fetched the first time a compare panel opens, not part of the entry bundle.

`tests/player.test.ts` fakes the clock and `setInterval` and covers the sequencer: the gap is part of
the queue but is no clip, the playhead runs through it into the next line, speed scales the timed
clock, a queue that runs out continues into the next one (and stops when there isn't one), and
scrubbing a chapter that isn't loaded parks the playhead without starting it.

## Toasts (Toastflow, 2026-09-14)

Toasts run on [vue-toastflow](https://www.toastflow.top) for the runtime only — queue, timers, pause on hover, swipe to dismiss, Escape, focus handling, live regions, the promise `loading` helper. The plugin is created with `{ css: false }`, so none of its stylesheet loads: stack layout, motion and the time-left bar are in `src/toasts.css`, and the card is our own Tailwind markup in `components/Toasts.vue` through the headless slot (`ui.getRootProps / getCloseProps / getButtonProps / progress.*` keep the a11y and behaviour wiring). The app only ever calls `app.toast(msg, { kind, description, undo, action, timeout })` and `app.toastLoading(promise, { loading, success, error })`.

UX rules: undoable toasts get ↻, an Undo button first, a `⌘Z` hint on the newest one, 10 s with a visible time-left bar that pauses on hover; warnings/errors are `role="alert"` with a stronger left accent, never a full-colour background; close only shows on hover/focus on pointer devices and always on touch; four visible, the rest queue; duplicates are suppressed.

## Icons

Icons are [Lucide](https://lucide.dev) SVGs from `@lucide/vue`, imported where they are used and
aliased to the job they do (`import { RotateCcw as RetryIcon } from "@lucide/vue"`). Size them with
the `icon` / `icon-sm` / `icon-lg` classes in `src/style.css` (14 / 12 / 16 px, aligned to the text
they sit in); `icon-fill` fills the play and pause triangles, which read better solid at that size.
Keyboard legends (`⌘`, `↵`, `↑↓`) and prose arrows ("teasing, light → cold, deliberate") stay as text,
and so does the `⁄` caret marking a cut point inside a line in split mode.

## UI primitives

Form controls are built on [reka-ui](https://reka-ui.com) (headless, accessible) with thin styled wrappers in `src/ui/`:
`UiSelect` (grouped items, colour dots, hints, a `null-value` option), `UiCombobox` (searchable, grouped, `action` mode for "merge into…"), `UiSlider`, `UiNumber`, `UiCheckbox` (tri-state), `UiSwitch`, `UiToggleGroup`, `UiTooltip`. Tabs, Popover, Dialog, Collapsible and TooltipProvider are used directly from reka-ui. Reka forbids `''` as a Select item value — the wrapper maps it to a sentinel.

`UiNumber` is every numeric field in the app (price, cap, gap, limit, year). It drops the native
spinner — at this size the arrows eat a third of the box and fire on a stray scroll — and keeps the
behaviour: `↑`/`↓` step (`shift` ×10), `Esc` reverts, `Enter`/blur commits, values are clamped to
`min`/`max` and float noise is rounded off. It holds a draft while you type, so a half-typed `0.` never
reaches the store, and an unreadable entry snaps back to what is actually set. `prefix` / `unit` sit
inside the box (`$ 12`, `0.35 s`), and `empty` lets a blank field mean something — "no cap".

## Things to try

- Scripting: _The Cliché Cultivation World_ has three volumes — collapse them in the chapter list. Tick unscripted chapters on _Letters from the Drowned City_ and run; new chapters sometimes surface an alias (dashed "new") — the chip opens the Cast page, where merging lives. The cast rail sets each speaker's voice where you are reading them; hide it with its own button, the Cast button or `c`, and change type with `Aa`.
- Narration: _Cliché_ ch 4 is partly failed — retry from the ledger. The Narrator sits on the free local Kokoro (limit 500 chars) and dialogue on OpenAI; narrate ch 7 and watch rows split into parts. On _Drowned City_, Old Tobiah's voice lives on the paused Azure proxy — resume it or repick. In Endpoints, add an endpoint and “Fetch from server” to pull its voice list.
- Export: _Ashes of the Starforge_ is fully narrated — build an M4B.
- Review: _Starforge_ ch 1 has three flagged clips and one retake already waiting — play both takes and keep one. Flag another line yourself (⚑), then `↻ Retake flagged`.
- Pronunciation: Narration → **Pronunciation** on _Cliché_ — `Ji Ning → Jee Ning` and `Lan’er → Lahn-urr` are already in; click the count for a before/after on a real line, change one and watch the clips that used it go stale. In the reader those words are underlined; hover for the respelling.
- Pacing: _Starforge_ ch 1 holds 1.5s after the Captain's threat and runs straight on into the reply — the ledger's scrubber draws both gaps. Set your own in the reader under **Pause after**, or `[`/`]`.
- Endpoints: open **Endpoints** in the sidebar. _Antigravity (local)_ has never been used — it reads **Not tested**, not healthy. _Azure proxy_ is billed per audio minute at a rate nobody wrote down: its spend shows **unknown**, and the totals say how many rows they are missing. On the Overview tab switch to **Latency** and see queue wait stacked under provider response, then click a bar to filter the Activity list to those requests. Type `2500` into Concurrency on the Requests tab — the slider range follows. Start a narration run, then **Pause** _Local Kokoro_: the queue holds, the run doesn't fail, and **Resume** picks it up. **Cancel** says what it will do first.
- Boundaries: in the reader, open a line and press `s` — click a gap to cut it, then give the second half its own speaker. `m` joins a line with the next. Try it on the unverified chunk in _Cliché_ ch 7.

## Queue job activity (2026-09-14)

Running, queued, and historical jobs open a right-side detail panel (full-width on mobile). Activity
is recorded by the simulator when jobs queue, start, wait, dispatch, complete, fail, or cancel.
Scripting events include request numbers, retry attempts, token usage, and simulated costs; narration
events include segment/retake identity, endpoint, model, split count, response time, and errors.
Export events record progress milestones and the completed artifact. Waiting reasons are logged only
when they change, so a paused endpoint does not fill the log with duplicate messages.

The panel separates queue time from run time, offers search and a warnings/errors filter, and expands
each event's diagnostic fields. Run details preserve timestamps and scripting usage independently of
later chapter changes. Copy diagnostics uses an explicit field allowlist, omits connection snapshots,
and uses sanitized event data. Old seeded jobs explicitly have no detailed activity rather than
inventing a request history. The latest 1,000 events are kept per job with a visible dropped count;
removing a job or refreshing the prototype discards its log. No real provider calls or persistence.

## Scripting endpoints (2026-09-14)

Scripting now has its own endpoint manager above the reader. Add named OpenAI-compatible base URLs and model IDs, choose an endpoint explicitly for each run, and edit Connection, Requests & chunking, or Token pricing in separate tabs. Each endpoint owns input/output USD-per-million-token rates, concurrency, maximum characters, cut boundary, and maximum output tokens. Numeric fields accept exact integers (including 2,500 concurrency); slider ranges expand when a typed value exceeds the displayed range. Zero maximum characters means a whole chapter. The chunk preview preserves source whitespace and shows estimated input/output tokens and cost.

“This run” shows chapter/request counts, separate input/output costs, an approximate duration, and a per-book scripting budget. Blank budget means no cap; zero blocks paid requests. Prompt/context overhead is estimated, and seeded rates are illustrative, not current provider quotes. Simulated requests reserve input cost plus the maximum output allowance before dispatch, then settle to simulated usage. Spend survives removing completed jobs and is included in the overview’s total book spend. The overall book cap is also checked by the scripting scheduler.

Concurrent chunk requests share a limit across books on the same endpoint. Chapters remain ordered within each book. Queued jobs keep a snapshot of their endpoint, model, chunking, and prices; changing concurrency or pausing an endpoint affects dispatch immediately. In-flight requests drain while paused. New jobs never silently switch providers. The same budget and scheduling path handles fallback chunk retries. Endpoint removal has Undo, and settings import/export excludes API keys. As elsewhere in this prototype, settings, budgets, jobs, and usage are in memory; no network requests or paid provider calls occur.

Validation: `pnpm test` runs the scripting behavior tests with the installed Bun test runner. `pnpm build`, `pnpm lint`, and `pnpm fmt:check` check the application.

## Endpoints page (2026-09-14)

`/endpoints` is app-wide: both kinds of OpenAI-compatible server in one list, across every book.
Scripting profiles and TTS endpoints were configured in two different places, each buried inside a
book's stage, which left "what is running, what is broken, what am I spending" unanswerable. The
per-stage panels are still there for the routing work that belongs beside a book; each now links up
to this page, and `⌘K` reaches it and can pause or resume either kind from anywhere.

A compact strip answers the four questions at a glance — active requests, waiting requests, spend
today, endpoints needing attention (the last is a button that opens the first one). Searchable cards
on the left filter by All / Scripting / TTS and carry name, model, enabled state, observed health,
active-over-configured concurrency and one line of pricing. The selected endpoint fills the right
side behind the tabs the scripting editor already used, now five:

- **Overview** — throughput, latency, spend and errors over 1h / 6h / 24h / 7d, drawn with
  [Unovis](https://unovis.dev) (`@unovis/vue`) along the lines of shadcn-vue's chart recipe: the Vis
  components are used directly rather than wrapped, and series colours come from `--chart-*` tokens
  in `style.css` so the SVG and the HTML legend beside it are painted from one source. Queue wait
  (our side, waiting for a slot) is drawn and totalled separately from provider response time; the
  latency chart stacks the two. Throughput is tokens/minute for scripting and generated audio
  minutes per minute for speech. Outcomes separate first-attempt success from eventual success and
  count rate limits, retries and failures. Clicking a bar filters the Activity tab to exactly the
  requests in that bucket — chart and list are folded from one array of records. SVG bars can't hold
  focus, so the plot is a keyboard control too: focus it and `←`/`→` walk the buckets, `Enter` picks
  one, `Esc` clears, and the readout under the chart is a live region that announces each one.
- **Connection** — keeps three things apart that usually get confused: the saved model
  configuration, the provider connection (base URL + credential, shareable between configurations)
  and the shared quota group. Named credentials can be used by several endpoints; the key itself
  stays in the in-memory keyring and never reaches an export. Edits are staged and applied
  deliberately: changing base URL, model or credential while jobs are unfinished asks first and says
  that queued jobs keep the connection they were created with. The connection test states its scope
  and cost before you press it.
- **Requests** — concurrency as an exact number with a slider whose range grows to fit what you
  type (2,500 is as easy to set as 4), and three separate readouts: configured, in flight now, and
  the effective limit actually in force (zero while paused, cooling down or missing a key).
  Timeouts, retry limit and rate-limit cooldown; maximum characters, cut boundary and the scripting
  output-token ceiling. The split preview runs the real splitter and asserts the pieces rejoin the
  source character for character. A footer says which settings apply immediately and which apply to
  the next job.
- **Pricing & budgets** — scripting keeps separate input/output prices per million tokens; speech
  carries an explicit billing unit (per 1M characters, per 1M tokens, per audio minute, per request)
  because not every provider bills per character. A blank rate means **unknown**, never $0: those
  requests are counted, never priced, and every total that excludes them says so. Estimated,
  reserved and recorded cost are defined side by side. The endpoint's daily limit (one endpoint,
  all books) sits beside book budgets (one book, all endpoints) with the scopes spelled out, and a
  paragraph says what happens when the remaining budget can't cover another request.
- **Activity** — filterable request history by status, book and free text, with book/chapter links,
  attempts, queue time, response time, usage and cost. Rows expand to a sanitised error body and
  copyable diagnostics (anything key-shaped is replaced with `[redacted]` before it is displayed or
  copied). Waiting requests say why in words: paused, concurrency full, rate-limit cooldown, no
  credential, budget exhausted, or waiting its turn behind an earlier chapter.

**Pause is not Cancel.** Pausing stops new dispatches and holds the queue: requests already in
flight land and are recorded, queued ones wait, and the run resumes where it left off. Cancel stops
the jobs, and says first how many it will hit, that in-flight work is kept with its recorded cost,
and that nothing already scripted or rendered is deleted. Removing an endpoint explains the same
ground. Tab selection, activity filters and unsaved connection edits survive leaving the page.

An unused endpoint is never called "Healthy": it reads **Not tested** until something answers and
**No recent activity** once it falls quiet. Rate-limit cooldown is a live setting — the simulated
transport uses the number on the Requests tab.

### What is real and what is not

Live activity comes from the job simulator already in the store. Everything historical — the
charts, totals, request rows and the connection test — comes through `EndpointService`
(`src/services/endpoints.ts`), whose only implementation here is `FixtureEndpointService`: a seeded
generator that invents a plausible week of traffic per endpoint. Every row it produces is marked
`simulated`, the page labels sample history against work this session produced, and no provider is
called, nothing is billed and nothing persists. Swapping in an HTTP implementation is the last line
of that file.

The route is lazy (`() => import("@/views/EndpointsView.vue")`): the charting library is only used
here, and keeping it out of the entry chunk leaves the main bundle smaller than it was before this
page existed.

## Model-specific expressions

TTS endpoints have an **Expressions** tab for explicitly configuring supported names, exact bracket
syntax, and whether each tag is a vocal sound or delivery instruction. Support starts unknown and is
bound to the configured model and base URL; changing either requires confirming support again.
No provider capabilities are assumed from its name.

Expanded script and narration lines offer a searchable expression picker, placement controls,
inline annotations, and an exact outgoing-text preview after pronunciation replacements. Annotations
are separate from prose: existing bracketed text is never automatically interpreted as a control.
Splitting, joining, and editing preserve annotation positions where possible and request review
when an edit affects an anchor. Request splitting keeps each expression token intact.

Narration and retakes check compatibility before queuing and again before dispatch. A review dialog
lets the user resolve unsupported annotations or explicitly omit them; omission is saved and
reversible, never silently applied. Changes invalidate affected audio, and take snapshots and job
events retain the expressions actually rendered. These workflows use the existing simulator; no
real speech or provider capability verification is performed. Book annotations remain in memory.
