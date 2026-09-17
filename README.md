# audiobook-ui — PROTOTYPE

Throwaway Vue 3 prototype answering **"what should the audiobook pipeline UI look like?"**
Front-end only. Everything mocked lives under `src/mock/`: hand-authored fixtures in `fixtures/`, the world they are expanded into in `world/`, the seeded demo situations in `scenarios/`, and the timer-driven fakes that stand in for the endpoints in `simulators/`. `src/stores/` contains focused Pinia stores for library, scripts, cast, endpoints, jobs, scripting, narration, exports and UI state; `demo.ts` coordinates the seeded scenarios. See [store ownership](src/stores/README.md) before adding state or cross-feature actions. The domain types are split by feature under `src/types/` and imported through `@/types`. Nothing persists except reader typography preferences (localStorage).

```bash
pnpm install
pnpm prototype        # opens http://localhost:5173
```

## Keep the seeded demo after backend integration

The seeded demo is a permanent UI testing tool, even after the application gets a real backend. Preserve `src/mock/` fixtures, scenarios and simulators, along with the demo controls. The frontend currently runs entirely in this mode; backend mode is not implemented yet.

When integrating the backend:

- Keep an explicit **Demo** mode that runs the same screens with seeded books, scripts, cast, endpoints and simulated jobs. It must work without a backend, provider credentials or paid AI requests. Label costs as simulated and show a clear Demo indicator.
- Select demo or backend services at application startup. Keep the choice at the service boundary so views do not grow their own mock-versus-real branches. Never silently fall back between modes.
- Keep demo state separate from real library data and credentials. A demo reset restores fixtures and cancels its simulated work; it must never modify the real library.
- Preserve repeatable scenarios for success, partial failure, rate limits, missing voices, budget limits, stale audio and export retries. These let us test difficult UX states without generating a book each time.
- For backend integration tests, use a separate test library and fake AI providers. This exercises the real queue, storage and API while returning fixture scripts and reusable local audio instead of calling paid endpoints. Real provider checks remain an explicit, small test.

These are integration requirements, not a second backend or new runtime mode added to the current prototype. Keep the existing demo working while implementing backend features incrementally.

## Demo tools

The app always runs in demo mode: seeded books, seeded cast and voices, and timer-driven fakes in place of the endpoints. Nothing is fetched, nothing is billed, and **every cost, duration and file size on screen is invented**. The sidebar says so under the app name, and the **Demo** chip in the header opens the demo drawer: a non-modal panel down the right of the page that stays open while the page reacts. Top to bottom it shows the situation the world is in now — what applying it did, in counts, and the steps worth trying — the seeded rows that belong to the page that is open, every situation grouped, and the simulation controls: a speed for simulated jobs (1×, 4×, 16× — every simulated wait is shortened, while the latency and cost a request records stay nominal, see `src/mock/simulators/clock.ts`), the one-shot failed build, and Reset, which says what it will drop before it is pressed. The chip carries the name of the applied situation, so it can be read with the drawer closed.

Each scenario puts the book, its script, its cast, the queue and its exports into one situation together and opens the page it is about. A scenario is always applied to the seeded world rather than on top of the last one, so picking the same row twice — or three others in between — gives the same situation. **Reset the demo data** puts everything back.

| Scenario                                       | What you get                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importing an EPUB (seven rows)                 | The contents review on a file just read: a clean novel, a 212-chapter serial with updates scattered through, three volumes with notices between, one announcement repeated a dozen times, titles that only look like notices, chapters that mix a note with story, and a file of nothing but notices. Nothing is added until you confirm. |
| A new book, nothing scripted                   | _Letters from the Drowned City_ straight after import: chapters to pick over, no script, no jobs, and the Narrator alone in the cast. Opens Scripting.                                                                                                                                                                                    |
| A book part-way through                        | _The Cliché Cultivation World_: 12 chapters scripted, 3 narrated, one stale, one failed, one unverified chunk — and three chapters scripting as you arrive. Opens the book overview.                                                                                                                                                      |
| Scripting that failed and was rate-limited     | Two chapters that kept nothing, the scripting endpoint inside a 429 cooldown, and the rows to retry. Opens the Queue.                                                                                                                                                                                                                     |
| Narration that failed and was rate-limited     | One chapter failed outright, one with failed clips among finished ones, and the speech endpoint backing off. Opens Narration.                                                                                                                                                                                                             |
| Speakers with no voice                         | The Narrator and a speaker unassigned, one pointing at a voice that no longer exists and one at the paused Azure proxy — lines that cannot be routed, and issues to fix. Opens Cast.                                                                                                                                                      |
| The budget is spent                            | The book's cap and its scripting budget used up, so every estimate reports a blocker instead of starting. Opens Narration.                                                                                                                                                                                                                |
| Edited script, stale audio, retakes to compare | Lines edited after narration and the clips that no longer match them, flagged audio, a second take waiting beside the first and one already rejected. Opens the ledger.                                                                                                                                                                   |
| A chapter with a script history                | _Cliché_ chapter 1 through four versions: OpenAI’s first pass, the corrections a person made to it, the checkpoint saved before trying another model, and the DeepSeek re-script that is the current script — with clips that no longer match it. Opens the reader with History open.                                                     |
| One speaker mis-attributed all through         | An alias scattered through the book, with Search open on the matches — the bulk corrections flow.                                                                                                                                                                                                                                         |
| The five Export rows                           | A book ready to export, ready/missing/stale together, a 214-chapter serial, an export that needs updating, and running/failed/finished builds. Opens Export.                                                                                                                                                                              |

The **make the next build fail** switch is one-shot: the build stops part-way, the version already on disk is untouched, and the failure offers a retry.

Reset also covers what lives outside the stores: half-typed endpoint forms and page filters, the demo's own credentials, and any page open on a book the seeded world does not have — an EPUB you added during the session is dropped, so that page is sent back to the Library first.

Switching scenarios or resetting **abandons simulated work in flight**. Each run records which generation of the demo world it was started against, and every simulator checks that before it writes; a chapter, a clip or a build from the world you just left cannot land in the one you are looking at now. The seeded searches — the mis-attributed alias, the same lines already settled, a term the book never uses — are queries against the seeded book rather than situations, so the drawer lists them under **On this page** while Search is open, with **Put the book back** beside them once one has been seeded.

## Pages

- **Library** → **Add EPUB** → **Contents** (what goes in the audiobook) → **Book overview** (volumes, per-stage progress, cast summary, "what next", and what else is waiting) → stages **Scripting / Narration / Export**.
- **Contents** (per book): every chapter in reading order, grouped by volume, with the notices the import found beside the titles; skip or restore chapters, singly, in ranges, by volume or by kind of notice. Reached from the import and again from the overview.
- **Review** (per book): every decision the book is waiting on, in one list — retakes waiting for a verdict, flagged clips, speakers a re-script brought in, merge suggestions, expressions the text moved under, chunks that didn't verify, chapters the import wasn't sure about, and runs that failed. Grouped by where each is settled, with a link that lands on the row itself rather than the top of its page; a batch of chapters carrying the same notice is one row, because one verdict settles them all. It decides nothing itself, and a decision settled anywhere leaves the list. Reached from the overview strip under "what next", from the sidebar, from the palette, and from Export's unfinished-review block.
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
- Export: an **export** is one deliverable in one or more files, versioned by name + format + layout. It stores a fingerprint of every chapter it was built from, so "needs an update" is a comparison against the book rather than a date; a failed or cancelled build never replaces the version already on disk.
- Endpoints back off for a few seconds on a simulated rate limit; health strip shows latency sparkline, ok rate, failures, 429s.
- **Voices belong to endpoints.** Each endpoint card lists its voices (fetch from the server, add by id, remove); character pickers are grouped by endpoint, and a paused endpoint's voices are listed but disabled. A character's voice is a ref `endpointId/voiceId`, so every segment is rendered by the endpoint that owns its speaker's voice (unvoiced speakers borrow the Narrator's). Removing a voice or pausing its endpoint shows up as a blocker on the voice card and in "This run"; segments that can't be routed fail with a reason instead of hanging.
- **Per-request character limit** per endpoint (`maxChars`, 0 = whole segments). Longer segments are sent as several requests and joined; the endpoint card says how many segments of the open book would split, the run estimate counts requests and splits, and the ledger marks rows "N parts · M ch" (click to see the exact cuts). **Cut at** chooses the boundary: sentence end, clause (`, ; : —`), word, or hard cut; when the preferred boundary doesn't occur inside the window it falls back to the next finer one and the part is flagged. The endpoint card previews how the longest routed segment of the open book would be cut (`src/lib/split.js`).
- **Command palette** — `⌘K` / `Ctrl+K` (or the header button): reka Dialog + Listbox with `useFilter`. Jump to any page, novel, chapter (opens it at the stage it's at via `?ch=`), speaker or endpoint, or run actions: script pending, narrate scripted, re-narrate changed, retry/cancel jobs, auto-assign voices, pause/resume an endpoint, toggle theme. Enter with nothing highlighted runs the first match.
- **Volumes are sortable** (drag the handle or ▲▼) and can be **renamed and removed** from the book overview (wrong EPUB added). Reordering renumbers chapters so they follow the volume order. Removing one deletes its chapters, segments, jobs and export entries, renumbers the remaining chapters so numbering stays continuous, and removing the only volume removes the novel.
- A chapter keeps the **scripts it has been through**: a re-script, a bulk correction, a restore and each run of manual edits preserve the script they replace, and **History** in the reader previews, compares and restores one. A version is the chapter's script only — never the audio, never the book's cast, dictionary or endpoints — and restoring carries the clips that still match the restored lines.
- Reader keyboard: `j`/`k` move, `↵` edit, `1–9` assign speaker, `s` split, `m` join next, `[`/`]` pause, `c` toggle cast.

## Round three (2026-09-14): gaps, friction, responsive, backend-shaped

- **Chapter peek & skip** — every picker row has a ⌕ popover with the raw text and word count and a "Skip this chapter" toggle; skipped chapters leave every stage, the run totals and the audiobook.
- **Re-script** from the reader header: profile + chunk size, "keep my N manual edits" (re-applied where the text still matches), then a "what changed" panel (speaker / direction changes, new / gone segments, click to jump). Edited segments carry `edited: true`.
- **Undo** — merge, rename, delete speaker, remove volume / novel / endpoint / voice, delete export all toast with Undo; `⌘Z`/`Ctrl+Z` outside a field undoes the latest. Snapshots in `_castSnapshot` / `_bookSnapshot`. This is the app's one rule for danger: **undoable actions happen at once and offer Undo, and only what cannot be undone asks first** — discarding an import, and cancelling runs in flight. Nothing asks _and_ offers Undo, which is what removing a novel and removing a volume used to do; what their confirmation step explained now sits on the control (its label and `title`) and in the toast, which also names the runs the removal cancelled, since those are the one thing Undo does not bring back.
- **Export**: custom cover, chapter markers with a title pattern and preview, listen / download / on-disk path per finished file. (Rebuilt in round eight — see below.)
- **Script search** (`/book/:id/search`, or type ≥2 chars in the palette): text, speaker, direction across every scripted chapter; results deep-link to the segment (`?ch=&seg=`), and can be selected for a bulk correction (see round seven).
- **Audit trail**: each rendered clip records voice, model, direction, style, type, time, cost. Clicking a ledger row (or `i`) shows it and spells out what differs from the script now (why a row is stale). Failures carry HTTP status + body and a "copy request".
- **Voice picker** popover (search, gender filter, grouped by endpoint, "N using", inline demo) replaces the flat select on Voices and Cast.
- **Direction** is a combobox: presets + directions already used in the book, free text allowed, and "→ all <speaker>" applies it to every line of that speaker in the chapter.
- **Stale nudge** in the reader header and the sidebar count; endpoint pool is now a master/detail list; queue shows an ETA and can notify when a book's run finishes; keyboard on picker / ledger / cast (`?` lists everything).
- **Responsive**: sidebar becomes a drawer under `lg`, stage layouts stack, tables scroll inside their cards.
- **Backend-shaped**: API keys live in `src/lib/keyring.js` (reactive, in-memory, never in the store or the settings file); settings export/import as JSON; per-book budget cap + "pause everything on this book"; `spent()` from the append-only usage ledger (`src/stores/usage.js`), not from whatever clip each line is holding now. Persistence and resume are left to the real backend on purpose.

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
The flag popover and the row's details link to the line in the reader (`e` on a focused row does
the same), because a wrong speaker, direction or word is fixed in the script, and a retake would
only read the same request again.
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
on the endpoints page — and here a wrapper would be in the way, because this component _draws_ and
does not _play_. The app has one playback engine, so the element stays out of wavesurfer's hands:
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

## Round seven: bulk corrections in Search (2026-09-15)

Search could find the forty lines the model mis-attributed and could open each one in the reader. Fixing
them was forty round trips. The page now carries the whole correction: **find → select → choose →
preview → apply → undo**, without leaving Search.

- **Selection is a set of segments, not a slice of the page.** Results are shown 40 lines at a time;
  the counts and every "select all" speak for the whole match set (`12 selected · 46 matching lines in
8 chapters`), and **Select all matching results** takes the matches below the fold with it — the
  footer says how many those are. Per-line, per-chapter (tri-state) and everything.
- **Selecting is not opening.** The checkbox and the row's link are separate targets; ticking never
  navigates. Changing the query or a filter **drops the selection** and says so, in a toast and in an
  `aria-live` line — a hidden selection is a correction waiting to go wrong.
- **One panel, opened inside the bar** — not a modal, and not a chain of confirmations. Pressing an
  action expands the bar downward, above the lines it is about, so the results stay on screen and the
  player stays clear; pressing it again closes it, and closing returns the focus to the button. It reads
  like the ledger's row detail rather than a paragraph: a violet rail, a strip of tiny labelled facts
  (_selected · will change · unchanged · clips going stale_), and tinted callouts for the things that
  cost something. `bulkPreview` (store getter, pure) supplies those counts plus before/after rows with
  chapter and speaker context, and **Inspect all N** expands to every affected line with a reason beside
  each skipped one. The final button names the work — **Change 39 lines** — and is dead when there is
  none. Opening, configuring and closing mutate nothing; if a selected line is edited elsewhere while the
  panel is open, the numbers are marked out of date and apply waits for a refreshed preview. A clip
  finishing in the background is not such an edit (`scriptFingerprint` vs `segmentFingerprint` in
  `src/lib/bulk.ts`). A tall panel scrolls inside the bar instead of eating the viewport.
- **Change speaker** picks from the book's cast only — no character is created, merged, or given a
  fallback voice behind your back. It names the voice that will read the lines, and when the character
  has none it says so and links to Cast: the script correction is fine, the narration needs an assignment.
- **Direction** is an explicit _set_ or _clear_. An empty field clears nothing, and setting one says how
  many lines already carry a direction that would be replaced. Directions are not expression tags: the
  prose and its annotations are never touched.
- **Flag for review** reuses the ledger's own categories and notes, keeps existing flags by default, and
  makes replacing them a switch you have to find. Flagging stales no audio, and says so.
- **Apply and undo.** Every line goes through `setSpeaker` / `updateSegment` / `flagSegment` — the same
  actions a single edit uses — so `edited`, clip staleness and annotations end up exactly where they
  would by hand. Audio is never regenerated automatically; the old clips stay for comparison. One undo
  covers the batch, shared by the toast, `⌘Z` and the result strip in Search, so it can only be taken
  once — and a line someone edited after the batch is left alone rather than silently overwritten.
- **Add pronunciation…** sits beside the search term, not in the bulk bar: a dictionary entry is not a
  mass replacement of the selected text. It previews across the whole book, says so, detects an existing
  entry and edits that one instead of adding a second, and refuses to turn a search _phrase_ into a term.
- **Seeded scenarios** (the **Demo** chip, prototype only): matches in every chapter with more than a
  page of them, mixed speakers and directions, clips rendered / stale / not yet rendered, already-flagged
  lines, a character with no voice, a search with no results, and one where every selected line already
  has the requested value. Reset restores the book from an in-memory snapshot; nothing persists.

## Round eight: Export, at the size of a real book (2026-09-15)

Export was built for the small case — one M4B, a chapter list in a 300px rail, a gap control that
quietly disagreed with the book's own pacing, and "rebuild" as the only word for keeping a finished
audiobook current. A 200-chapter serial breaks all four. The page is now two jobs on two tabs:
**Build** (what goes in, what comes out) and **Audiobooks** (what you have made, and whether it still
matches the book).

**One plan, one truth.** `src/lib/exports.ts` is pure: given the selected chapters, the volumes and
the settings, `planOf` returns every output file with its chapters, running time, size and marker
count. The file count, the example names, the chapter order, the duration and the size are all read
off that one structure, so they cannot drift apart from each other or from the selection. The store
builds exactly the plan the page drew.

**An export is the deliverable, not a file.** Format (M4B / MP3) and layout (one file · one per
volume · one per chapter) are independent: layout decides how many files, nothing else changes. So
one export entry holds `files[]` — "one audiobook in 6 files" rather than six entries to keep in
sync. A set of files is named by its folder; a single file is named by itself. MP3 says plainly that
it has no chapter marks every player reads, and offers the two ways out (one file per chapter, or
M4B) instead of a disabled checkbox.

**Selection is the contract.** `ExportChapterList` lets you tick _any_ chapter, including ones that
cannot be exported, because a chapter silently left out is the failure mode this page exists to
avoid. Each row says what is wrong with it — `no audio`, `failed`, `partial`, `stale`, `running` —
and the plan panel turns the totals into things to do: **Narrate them**, **Leave them out**, **Use
the audio as it is**. "Leave them out" unticks them, so the list and the build stay the same set, and
`buildExport` refuses anything unusable rather than trimming it. At 214 chapters the list carries
search, per-volume select and collapse, a jump box, shift-range selection, `↑↓`/`space`/`/`, and a
**Needs attention** filter that doubles as navigation — with a warning in the footer when the current
filter is hiding ticked chapters.

**Using stale audio is a decision.** `useStale` starts false, so a build that contains clips the
script has moved under is always something someone chose: the blocker offers re-narrating, leaving
them out, or using them, and once accepted the plan says so in amber with a one-click undo of the
choice.

**Pacing had two owners; now it has one.** Export used to carry its own "gap between segments"
beside the book's `line` / `turn` pacing, so the same silence was configured twice and the export's
duration estimate counted neither. Gaps _inside_ a chapter now belong entirely to the book's pacing
and its per-line overrides — the numbers the reader, the ledger, `chapter.duration` and the player
already share — and are edited from Export through the same `setPacing` action, not copied. Export
owns exactly one gap, **between two chapters**, because that join does not exist until they are
stitched. `durationOf` is the only place chapter time is added up, so the plan, the size estimate and
the preview agree; the chapter fingerprint covers the stitched silence, so changing a pause marks a
finished export out of date even though it re-renders nothing.

**Loudness.** A book read by several voices from several providers arrives at several different
levels, and a listener reaches for the volume knob long before they notice the bitrate. The Loudness
section lists every voice in the selection with its integrated loudness, the spread between the
quietest and the loudest, and the gain matching would apply. All of it is **invented from each
voice's identity, not measured** — `measuredLoudness` is a hash, this prototype renders no audio and
applies no gain — and the panel says so in those words. The control is on by default at −18 LUFS,
with −23 (EBU R128) and −16 (podcast-loud) offered.

**Preview uses the app's own player.** The Preview button and each file's ▶ build a queue of the real
clips with the real silence between them — the book's pacing inside a chapter, the export's gap
between two. There is no rendered audio in the prototype, so the run is _timed rather than heard_ and
the player bar says exactly that, rather than pretending. Download says the same: nothing was
encoded, so there is nothing to download.

**Builds are jobs.** One build is one job, whatever it produces, so a 200-track export does not put
200 rows in the Queue. The job carries an `exportRun` — settings, chapters, which file is being
written, how many chapters were encoded and how many carried over — which the Queue's running row,
the job's Run details and Retry all read. Cancel removes the in-progress version and leaves the one
on disk alone; a failed build does the same and says so (`v3 is untouched and still the audiobook on
disk`), with Retry from Export, from the toast, or from the Queue.

**Updating instead of rebuilding.** Every export stores a fingerprint per chapter
(`chapterSignature`: the clips, the stitched silence, and the chapter's narration state). "Needs an
update" is then a real comparison against the book as it stands, not a timestamp: _9 chapters
narrated since · 4 changed · 1 no longer has audio · 191 of its 196 chapters are unchanged and would
be carried over rather than encoded again._ An update encodes only what moved and copies the rest —
the simulated encoder weights the two differently, and the job log says which is which — and the
version already on disk stays current until the new one lands. Changing an output setting (bitrate,
layout, loudness target…) is a different file, so nothing is carried over, and the page says that
too.

Seeded scenarios live behind the **Demo** chip, as on Search: a book ready to export, ready/missing/
stale together, the 214-chapter serial, an export that needs updating, and running/failed/finished
builds — plus a one-shot **make the next build fail** switch for the failure path. Reset restores the
book from an in-memory snapshot.

`tests/exports.test.ts` covers the plan (grouping, names, track widths, MP3's missing marks, and that
the file totals equal the plan totals), the blockers (nothing dropped, stale accepted on purpose,
partial ≠ failed), loudness (deterministic, gain closes to target), and the store: a build refuses
what it cannot use, replaces the version it supersedes, keeps the finished version when the next one
fails or is cancelled, and reuses exactly the chapters whose fingerprints have not moved.

## Round nine: what goes in the audiobook (2026-09-16)

A web-novel EPUB is not all story. Between the chapters sit hiatus notices, health updates, release
schedules, sponsor thanks, vote reminders, links — and an audiobook that reads them aloud is an
audiobook nobody finishes. Import used to drop a file straight onto the shelf; skipping was a toggle
buried in a peek popover, one chapter at a time. Now the file is **read, reviewed and then added**.

**Import → Contents → Add.** `Add EPUB` (or a sample from the row under the drop zone) opens the
same dialog as before, and _Read the file_ lands on `/book/:id/contents` with the book marked
`importing`: off the shelf, not the open book, nothing running on it. **Add to library · 202
chapters** is the only way on, and it says what it adds; _Cancel import_ leaves no trace. The same
page is the book's **Contents** afterwards — overview card, sidebar chip, the picker's "skipped"
count — so a chapter skipped on import is restored in the same place with the same words, and every
change there applies at once to scripting, narration and export.

**A suggestion is a reason beside a title, not a removal.** The import attaches a `note` to a
chapter that did not look like story: a verdict (`skip` — a notice through and through; `review` —
story with something else around it), a kind, one line of reason (_Possible hiatus announcement_,
_Mostly promotional links_) and the evidence behind it. Every chapter arrives **included**;
`excluded` is the person's decision and stays the one flag every stage already reads, and a chapter
looked at and kept records `kept` so the suggestion stops asking. The row's checkbox _is_ the
decision — ticked means in the audiobook — so there is no second selection to lose track of.
Shift ticks a range of what is on screen; the volume header ticks a volume; the strip above the list
groups the notes by kind (_Sponsor thanks · 12_) with **Skip 12** beside each and **Skip all N
suggested** for the lot, each a toast with the count and Undo (`⌘Z`). Single ticks are quiet — the
click is its own undo. On a clean book the strip does not appear: one line says nothing was found,
and the button is one click away.

**Prologues, interludes and side stories are story.** Nothing is flagged for being short or oddly
titled. Two kinds are flagged for a _look_ rather than a skip: a chapter whose **title** reads like a
notice but whose text is story, and a chapter that **mixes** an author note with story. The preview
marks the note in amber, says how many words it is, and offers **Keep chapter** — the whole chapter
goes in, and the note can be trimmed in Scripting once it is scripted. Nothing is cut here and no
editor was built for it.

**Reading never changes a tick.** The right-hand pane (a bottom sheet under `lg`) shows the chapter
in full with its place in the book (_Vol. 2 · chapter 14 of 32 · #50 of 212_), and the list keeps
its scroll, its filter and its search. `↑↓` move, `space` ticks, `↵` reads, `n` jumps to the next
chapter still to decide, `/` searches. Filters — _Included · Suggested skips · Needs review ·
Skipped_ — and a search over title, number or reason live in the URL; the footer says when they hide
chapters, and the batch buttons say they act on the whole book.

**What is real.** Nothing parses a file. The dialog asks what the file turns out to contain, and the
answer is one of `IMPORT_SAMPLES` (`src/mock/fixtures/imports.ts`): the sample fixes the chapters,
which of them carry a note, and where a mixed chapter's note sits; `src/mock/fixtures/notices.ts`
supplies the reasons, the evidence and the bodies; `src/mock/world/text.ts` composes a chapter's
text from its note, so the peek, the preview, the scripting estimate and the mock run all read the
same thing. The seeded books' two skipped chapters now carry the note that explains them. The Demo
chip has an **Importing an EPUB** group, one row per sample; a reset drops the imported book.

**The shelf, redone (2026-09-16).** The Library used to spend a third of the viewport on a drop
zone and a sample banner before a book appeared, and each card offered three bare numbers and a
badge over a gradient. Now the books come first. The drop target is a one-line hint, and grows into
a full-page target only while a file is over the window; the samples are a **Try a sample** menu
beside **Add EPUB**. Each card says the one next thing to do as a verb with a destination
(_Narrate 9 chapters_, _Retry 2 failed chapters_, _Update the audiobook_ — `nextStepOf` in
`src/views/library/shared.ts`), draws progress as one segmented bar (narrated · scripted · not
started · skipped) and nothing else — the counts behind it, scripted, narrated, in the audiobook,
skipped, appear while the pointer or the keyboard focus is on the bar and not otherwise — shows
what is running or has failed on the book with a
link to the queue, and names the audiobook built from it — **Audiobook v2 · 6 min** — with what
has changed since, not "behind the book" but _1 chapter not in it yet_ or _2 chapters re-narrated
since_ (`updateReason`). The table reports the same book per stage instead, the way the overview
does. A
book still in its contents review is a strip above the shelf with **Resume review** and
**Discard**, not a book that went missing. The cover's `⋯` menu holds Overview, Contents, Cast, Add
a volume and Remove from library — one step, with what it takes written under it, then the usual
Undo. The numbers sit outside the
cover button so a screen reader hears them as text; arrow keys move between covers.

The shelf has a second shape. The two icons beside **Try a sample** switch between the grid of
covers and a table (`src/views/library/ShelfTable.vue`) with one row per book and the pipeline as
columns — in the audiobook, scripted, narrated, audiobook, next — with progress per stage the way
the overview shows it, so the two pages agree. The choice sits in the URL as `?view=list` and is
remembered for the next visit. A third layout, lanes by what each book needs, was prototyped on
the same route and dropped: with a shelf this size every book landed in one lane.

**Finding a book on it (2026-09-16).** Four seeded books never made the shelf cope with twenty,
so the Demo tools gained **A full shelf**: eighteen more books (`src/mock/fixtures/shelf.ts`),
each left at one point in the pipeline — nothing run, part scripted, part narrated, failed
scripting, stale audio, everything narrated, an audiobook that matches, one the book has moved on
from — with their reviews already done. Against it the shelf has a search (title or author, every
word, accents ignored, `/` to focus), filter chips with counts (**Needs attention**, **Running**,
**Behind**, **Up to date** — the lanes of the dropped board, as filters), and an order (recently
added, title, author, most to do, least scripted, least narrated; the table's column headers order
it too). Search, filter, order and shape all sit in the URL (`?q=harbour&filter=attention&sort=todo&view=list`),
so a narrowed shelf can be linked to and survives a reload. A search that matches nothing says so
and offers **Show all books**, so a stale filter is never mistaken for an empty library. The `⋯`
menu is now on table rows as well as covers (`src/views/library/BookMenu.vue`); its popover
content is mounted only while open, because a closed one left inside a card that a search then
narrows away froze the renderer on unmount. `src/views/library/shelf.ts` holds the pure
filter and order logic, covered in `tests/library.test.ts` along with the demo row itself.

**Editing a line where it is (2026-09-16).** Placing an expression used to mean a form: a tag
from one dropdown, a position from another whose options were fragments of the sentence, then
Insert; every placed expression was a card of its own, and on the seeded models the button led to
a grey box saying the model had no tags. Cutting a segment hid its cut points until hovered,
dropped the quotes and chips from the line while cutting, and lived outside the editor the joins
lived in. Both now use one gesture, the gaps between words (`src/lib/gaps.ts`,
`src/components/WordStrip.vue`): **Add expression** turns the line into a strip with its gaps
showing as ticks, darker where a sentence ends; click the gap and a picker opens under it with the
model's tags, searchable, sounds and delivery apart. The chips on the line are the controls —
click one to replace, move (back to the gaps), omit or remove it. **Split…** sits beside the
joins in the editor and shows the same strip, with the quotes and chips kept; hovering a gap shows
both halves as they would come out, and hovering a join shows the merged line and who would read
it, inline rather than in a tooltip. ← → walk the gaps, Enter cuts or places, Esc leaves; `s` and
`m` still split and join from the reader. When a model has no tags the button reads **Set up
expressions for gpt-4o-mini-tts** and opens the configuration in place. The main OpenAI model now
ships with a dozen tags (`EXPRESSION_TAGS` in `src/mock/fixtures/endpoints.ts`), and the Demo tools
row **Expressions placed in a line** opens the reader on a line that has some, one of which needs
its position chosen again. `tests/reader.test.ts` covers the gaps and the row.

`tests/contents.test.ts` covers the states and counts, every sample's shape (continuous numbering,
volumes that cover their chapters, nothing pre-skipped), the situations (clean, scattered, between
volumes, repeated, misleading, mixed, all-notices), text composition with the note marked, import →
confirm → cancel for a book and for a volume, batch skip with an Undo that restores `kept` too, and
that a skipped chapter leaves the scripting estimate and export readiness and comes back when
restored.

## Round ten: a chapter's script history (2026-09-17)

Re-scripting a chapter throws the old script away. So does a bulk correction, in its own smaller way,
and so does an afternoon of editing that went the wrong direction. The reader could undo the last
thing you did and nothing else, which made "try DeepSeek on this chapter and see" a bet rather than
an experiment. A chapter now keeps the scripts it has been through, and going back to one of them is
a thing you can look at before you do it.

**History** sits in the reader header beside Re-script, with the number of saved versions on it, and
takes over the reader's body rather than opening beside it: there is never a question of which script
is on screen. It has three states, and the strip across the top says which one you are in every time
— **the list**, a read-only **preview** of one version, or a **comparison** of one against the script
as it stands. `?history=1` opens it, which is how the seeded scenario lands on it.

**What makes an entry.** The working script is preserved _before_ anything replaces it, labelled by
whatever produced it: a re-script (with the endpoint and model that ran it), a bulk correction (with
the batch's own name and the lines it changed), a restore, or a run of manual edits. Ordinary editing
is grouped into **editing sessions** — a run of edits with less than ten seconds between them is one
entry, so a chapter you worked over for an hour reads as "9 manual edits", not ninety rows. The rule
is deliberately dumb and easy to predict: the first edit after a quiet spell preserves the script and
opens the session; every edit after it joins the same entry; the entry that session produces is what
the _next_ thing to replace it preserves. Speaker, type, direction, the words themselves, expression
annotations, pauses, splits, joins and deletions all count as edits; a clip finishing in the
background does not, because a version holds the script and never the audio.

An operation that changes nothing adds nothing: a re-script that comes back with the same attribution,
a bulk batch that matched nothing, an edit that set a value to what it already was, an expression
dragged back to where it already sat. A run that **failed, was cancelled or hit the budget** never gets
as far as writing a script, so it cannot push a good one into the list — history is taken at the run's
one write path, not when it starts. "Changes nothing" is judged losslessly, spacing and all: two
scripts with the same words laid out differently are two scripts, and the comparison names that
difference in words rather than drawing a diff with nothing marked in it.

**An edit and its entry are one thing.** Every edit that offers Undo snapshots both owners before it
runs, so `⌘Z` puts the script and the history back together: take a split back and the entry it opened
goes with it, rather than leaving the list insisting a manual edit happened. Undoing one edit of a
session leaves the rest of the session standing, still collecting.

**Save a checkpoint** names the script as it stands — _Dialogue reviewed_, _Before trying DeepSeek_ —
without changing a word of it, and the entry still says how that state was reached ("saved by hand ·
6 manual edits").

**What changed.** A comparison leads with the summary — _6 lines differ · 1 line rewritten · 1 speaker
change · 3 direction changes · 2 line splits_ — then lists only the lines that moved, filtered by kind
(words, speakers, directions, types, expressions, pauses, structure) and paged, so a 600-line chapter
stays readable. Lines are matched on their words first, so a line that only changed speaker, pacing or
expressions is recognised as the same line rather than as one gone and one new; what is left over is
checked for the two structural edits the reader can make — a line cut in two, two lines run into one —
before anything is called new or gone. A rewritten line is shown as the two lines it reads as, the
removed words struck out of the first and the added words underlined in the second, each row marked
`−` / `+` and badged in words: nothing here is told by colour alone. Every change on the current side
opens the line in the reader.

**Restoring** says what it will do before it does it, in counts: how many lines change, how many clips
still match and stay usable, how many carry over but go stale, how many belong to lines this version
does not have and are dropped, how many restored lines have no audio at all, what the chapter's
narration becomes. Then it happens at once and the toast carries Undo (`⌘Z`), like every other
undoable thing in the app. That Undo is as narrow as the restore was: this chapter's script and its
place in the history, the chapter's own status, and the speakers the restore had to put back into the
cast — a chapter edited or a voice changed while the toast was still up is not a restore's to take
back.

**The audio is not thrown away.** A clip belongs to a restored line when that line reads as the clip's
own text does — either because the script says so, or because the clip itself was rendered from those
exact words, which is how a line that has since been joined into its neighbour finds its own clip
again. Carried clips are then re-judged against the restored line by the same `clipDrift` the ledger
uses: still current, or stale because the speaker, direction, expressions or dictionary have moved on.
Takes and a retake waiting for a verdict travel with the clip they belong to. The chapter's narration
status, its running time and the export's "needs an update" all follow from that, so a restore can
take a chapter from stale back to done.

**A version is the chapter's script, not the book.** The cast, the voices, the pronunciation
dictionary, the pacing and the endpoint settings belong to the book and are never rolled back with a
chapter — the panel says so where it matters. When a version uses a speaker the cast no longer has
(an alias merged away since), the restore block names it, counts its lines, and restoring puts it back
as an unreviewed speaker, which is exactly what the Cast page's merge and rename exist for.

**A run in flight is not raced.** A scripting or narration job on this chapter would write a script, a
clip or a chapter status belonging to the version you just left, so restoring waits: the block names
the run, offers Cancel — the one thing here that cannot be undone, which is why it asks — and the
Restore button enables itself when the queue settles.

A chapter's history belongs to its chapter, not to its number: removing or reordering a volume
renumbers the chapters after it, and the histories move with the scripts, jobs and export entries in
the same transaction — with the same Undo.

Store ownership: `history.ts` owns the versions, the editing sessions and restoring; `lib/scriptHistory.ts`
is the pure part (what a version preserves, what two of them disagree on, what a restore would do), and
the panel renders exactly what the plan counted. `tests/history.test.ts` covers snapshot independence,
session grouping, the runs that must leave no entry, comparison accuracy including splits and joins,
restoring with its audio consequences and the narrow undo, the missing speaker, the run in flight,
renumbering a book, and a demo reset while an editing session is still collecting.

## Round eleven: re-doing chapters that are already finished (2026-09-17)

Completed chapters could always be ticked and run again — nothing stopped you — but the app never
said what that would do. "Run scripting (8)" on a selection of three new chapters and five finished
ones read the same as "Run scripting (8)" on eight new ones, bulk re-scripting quietly defaulted to
throwing away every manual correction in those chapters, and a full re-narration requeued clips that
were perfectly good and deleted the retakes waiting beside them. Re-doing work is now a thing the app
explains before it does it, and one that keeps what it is replacing until the replacement actually
lands.

**One plan behind everything.** `lib/runPlan.ts` works out what a selection contains and what pressing
the button would do to it, without touching anything. The picker's summary line, the button's own
label, the estimate and the work the store queues are that one calculation, so they cannot disagree.
A chapter is _new work_, a _replacement_ of something finished, or a _retry_ of something that failed;
anything left out is left out for a named reason.

**Selecting.** The picker keeps its checkboxes, its volume headers and its shift-click range, and gains
a Select row — Pending, Completed, Stale, Failed — where each shortcut only appears when it would pick
something, so the row stays short on a book that has nothing stale. Shortcuts read the whole book, never
the search; the filter is the one thing the header says out loud, with **All 12 results** beside
**Whole book (40)** while a search is on. Under it, one sentence says what is ticked:
_8 chapters selected: 3 new, 5 already scripted._

**The button says the operation.** _Script 3 chapters_, _Re-script 5 chapters_, _Script 2 · re-script 3_
— and its count is the chapters that will actually run, not the number ticked. Under it: what the run
does, then what it leaves out and why (_2 chapters left out: 1 already running or queued, 1 skipped from
the audiobook_).

**Bulk re-scripting.** The endpoint, the model and the cost were already on the Scripting page; the
budget line now also says what the run would leave. **Preserve manual corrections** is on by default and
says exactly what it can and cannot do: speaker, type, direction and expression annotations are
re-applied to the new script wherever it wrote the same line, and a correction whose line the new run
rewrote, split or dropped _cannot_ be carried across. Those are counted, named and listed in the reader
beside the re-script diff — the one thing preservation must never do is claim a correction survived when
it did not. Every replaced script is preserved in its chapter's history before it is replaced, by the
same `noteScripted` path Round ten built, so **Restore** is always the way back.

**A replacement that produces nothing changes nothing.** A re-script that failed verification, was
cancelled, ran out of budget or was overtaken by a newer run leaves the script it was replacing as the
chapter's script — and the chapter goes back to reading as _scripted_, not as a chapter nothing ever
produced a script for. That last part matters beyond the label: a chapter that reads as failed is not
narratable and not exportable, so a failed re-script used to take a finished chapter out of the book.
Each run carries a token; a result from a run the chapter has moved on from is discarded with a line in
the log rather than written over what replaced it.

**Bulk re-narration has a scope**, and the estimate counts _that_ rather than every line in the chapter:

- **Missing & changed** — lines with no usable clip (never rendered, or the request failed) and lines
  whose clip no longer matches the script.
- **Failed only** — the lines whose last request failed. Finished clips are not touched.
- **Everything** — every line in the selected chapters.

"Retry failed clips" over a finished book is a handful of requests and now says so; it used to quote the
whole book's characters and cost.

**Current audio stays playable until its replacement succeeds.** A line being re-narrated that already
has a clip renders its replacement _beside_ it, in the `candidate` slot retakes have always used: the
clip in the book keeps playing, timing the chapter and going into the export the whole time. The
difference from a retake is what happens when it lands — a bulk replacement is accepted by the run that
asked for it, so 300 lines do not become 300 verdicts, and the clip it displaces joins that line's take
list rather than disappearing. A replacement that fails leaves the book's own clip exactly as it was and
stays visible as a failed take, which **Retry failed** picks up and nothing else does.

**A retake waiting for a verdict is not spare capacity.** A bulk run leaves those lines alone and says
how many; the switch beside the scope is how you tell it otherwise. Nothing is silently deleted either
way: told to go ahead, the run puts the waiting retake in that line's take list marked _not kept_,
exactly where rejecting it by hand would have put it, and renders the line again. The count the switch
reports is only the lines this scope would actually have rendered, so it never offers to replace
retakes on lines it was never going to touch — and it stays on screen in both positions, because the
question is about the lines, not about the answer you gave last.

**Running and recovering.** Every chapter of one press shares a run id, so the queue shows `3/8` on the
row, the job panel says _Re-script 4 chapters · chapter 3 of 4 · preserving manual corrections_ with the
run's own done/failed/to-go counts, and offers the two things worth doing to a run rather than a row:
**Cancel the rest** and **Retry N failed**. Cancelling keeps every chapter the run finished and starts
none of the ones it had not, and — being the one step here Undo cannot take back — it asks first, naming
what stops and what is kept. Retrying a run's failures re-runs only those, as one run again rather than
N unrelated ones, at the narrowest scope that covers the failure: _Failed only_ where requests failed,
_Missing & changed_ where a run was stopped before it sent them. A failed replacement is a failure of
the run even though the chapter still reads as narrated, and a re-script that failed puts the chapter's
status back — so both are found on the work itself rather than on the chapter's label, which is what
**Retry failed** and **Retry all failed** now do. The activity log carries the operation,
the scope, what was skipped and why, what each replacement displaced, and — for a run that produced
nothing — the line saying the previous script is unchanged.

**Demo rows.** Two new ones under _Re-doing finished chapters_: **A book with everything a bulk run has
to tell apart** (new, finished, hand-corrected, stale and failed chapters side by side, with a retake
waiting on one line) and **Replacements that failed, and a run that was cancelled** (a four-chapter
re-script where two chapters kept nothing and a cancelled one stopped the rest, plus narration
replacements that failed — every earlier script and every clip still there and still usable). Both are
seeded, like everything else here; no request leaves the browser. A scenario switch or a Reset abandons
bulk work in flight the same way it abandons everything else, so no half-finished replacement can land
in the world you are looking at now.

Store ownership: `lib/runPlan.ts` is the pure part (what a selection contains, which clips a scope runs,
what a plan reads as); `scripting.ts` and `narration.ts` own their runs and hand the simulators exactly
the slice they need; `jobs.ts` owns the run ids, cancelling a run and retrying its failures.
`tests/bulkRuns.test.ts` covers the selection summary and the plan's skip reasons, preservation and the
corrections that could not be re-applied, a failed and a cancelled replacement, an overtaken result, each
scope's estimate, a clip kept playable through its replacement, a failed replacement and its narrow
retry, pending retakes, cancellation, and both seeded rows.

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

- Importing: on the Library page pick **A long serial with scattered updates** from the sample row and press _Read the file_. Skip the release schedules with the group's **Skip 2**, press **Skip all 10 suggested**, `⌘Z` it back; open **Needs review** and read _The Widow's Percentage, Revisited_ — the note at the end is marked — then **Keep chapter**. **Add to library · 202 chapters** lands on the overview, where Scripting counts 202 and the picker's "10 skipped" links back here. Try **An EPUB that is nothing but notices** for the all-skipped state, and **A clean novel** for the one-click add.
- Difficult states: open the header's **Demo** chip and pick a row — a new book with nothing scripted, a rate-limited scripting run, speakers with no voice, a spent budget, or a chapter edited after narration. Pick another straight after: whatever was running is abandoned, and the new one starts from the seeded data rather than on top of the last. **Reset the demo data** puts everything back.
- Scripting: _The Cliché Cultivation World_ has three volumes — collapse them in the chapter list. Tick unscripted chapters on _Letters from the Drowned City_ and run; new chapters sometimes surface an alias (dashed "new") — the chip opens the Cast page, where merging lives. The cast rail sets each speaker's voice where you are reading them; hide it with its own button, the Cast button or `c`, and change type with `Aa`.
- Narration: _Cliché_ ch 4 is partly failed — retry from the ledger. The Narrator sits on the free local Kokoro (limit 500 chars) and dialogue on OpenAI; narrate ch 7 and watch rows split into parts. On _Drowned City_, Old Tobiah's voice lives on the paused Azure proxy — resume it or repick. In Endpoints, add an endpoint and “Fetch from server” to pull its voice list.
- Export: open the header's **Demo** chip and pick an Export scenario. _A long book_ opens **Thousand Gates of the Ninth Heaven** — 214 chapters over 6 volumes: filter to **Needs attention**, switch **Files** between one file / per volume / per chapter and watch the names and the count follow, then **See the chapter order**. _An export that needs updating_ shows v2 nine chapters behind with 191 carried over — press **Update to v3** and watch the Queue say `Encoding 50 of 204 · file 2 of 6`. On _Ashes of the Starforge_ chapter 1 is stale, so the build waits for you to choose. Open **Loudness** to see five voices 4.3 LU apart and what matching would do; open **Pauses** and nudge "after a line" — the running time, the size and the preview all move, and the finished export says it is behind the book. Turn on **make the next build fail** in the Demo drawer and build: the previous version is untouched and Retry starts over.
- Script history: open the header’s **Demo** chip and pick _A chapter with a script history_. The reader opens on **History**: four entries, newest first. **Preview** “Before trying DeepSeek” — read-only, the current script untouched — then **Compare with current**: read the summary before the detail, filter to _Speakers_ or _Split, joined, new, gone_, and **Open the line** to land on it in the reader. **Restore…** counts what comes back before you press it — six clips match again, one of them recovered from the paragraph the re-script cut in two — and the chapter goes from stale to done; `⌘Z` puts the re-script back. Restore v1 instead to see the warning about a speaker the cast no longer has. Then edit a few lines yourself and watch them collect as one “N manual edits” entry.
- Review: _Starforge_ ch 1 has three flagged clips and one retake already waiting — play both takes and keep one. Flag another line yourself (⚑), then `↻ Retake flagged`.
- Pronunciation: Narration → **Pronunciation** on _Cliché_ — `Ji Ning → Jee Ning` and `Lan’er → Lahn-urr` are already in; click the count for a before/after on a real line, change one and watch the clips that used it go stale. In the reader those words are underlined; hover for the respelling.
- Pacing: _Starforge_ ch 1 holds 1.5s after the Captain's threat and runs straight on into the reply — the ledger's scrubber draws both gaps. Set your own in the reader under **Pause after**, or `[`/`]`.
- Endpoints: open **Endpoints** in the sidebar. _Antigravity (local)_ has never been used — it reads **Not tested**, not healthy. The five speech endpoints bill five different ways on purpose: _OpenAI (main)_ per 1M characters, _Fish Audio_ per 1M **UTF-8 bytes**, _Gemini 3.1 Flash TTS_ at separate rates for input text tokens and output audio tokens, _Local Kokoro_ at **zero** (free, which is not the same as unknown), and _Azure proxy_ per audio minute at a rate nobody wrote down: its spend shows **unknown**, and the totals say how many rows they are missing. On the Overview tab switch to **Latency** and see queue wait stacked under provider response, then click a bar to filter the Activity list to those requests. Type `2500` into Concurrency on the Requests tab — the slider range follows. Start a narration run, then **Pause** _Local Kokoro_: the queue holds, the run doesn't fail, and **Resume** picks it up. **Cancel** says what it will do first.
- Boundaries: in the reader, open a line and press `s` — click a gap to cut it, then give the second half its own speaker. `m` joins a line with the next. Try it on the unverified chunk in _Cliché_ ch 7.
- Bulk corrections: on _Cliché_ open **Search**, open the **Demo** drawer and under **On this page** pick _Mis-attributed “Ning”_. Tick a chapter, or **Select all matching results** (it takes the matches the page is not showing), then **Change speaker…** → _Ji Ning_: 46 will change, 21 already use it, 12 clips go stale. Apply, read the strip, **Undo this batch**. Pick _Ning_ instead to see the no-voice warning, try **Direction…** with an empty field, and _Lines already read by Ji Ning_ for a batch with nothing to do. **Add pronunciation…** with `Ji Ning` in the box finds the entry that already exists.

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
  and cost before you press it, and both that estimate and the figure the test reports afterwards go
  through the shared pricing engine at the rates in force now — so a probe inside an off-peak window
  or under a promotion is quoted at the price it will actually be charged, in both places.
- **Requests** — concurrency as an exact number with a slider whose range grows to fit what you
  type (2,500 is as easy to set as 4), and three separate readouts: configured, in flight now, and
  the effective limit actually in force (zero while paused, cooling down or missing a key).
  Timeouts, retry limit and rate-limit cooldown; maximum characters, cut boundary and the scripting
  output-token ceiling. The split preview runs the real splitter and asserts the pieces rejoin the
  source character for character. A footer says which settings apply immediately and which apply to
  the next job.
- **Pricing & budgets** — scripting keeps separate input/output prices per million tokens, with
  cached-input and cache-write rates; speech picks a **billing model**, because providers meter
  genuinely different things (per 1M characters, per 1M UTF-8 bytes, per 1M input text tokens,
  input text tokens **plus** output audio tokens at separate rates, per audio minute, per request).
  Only the fields that model uses are shown, each with its unit spelled out, and a worked example
  under them prices one line at the rates in force right now so you can see how the rates produce a
  total. Changing model never reinterprets a rate: $15 per million characters is not $15 per million
  audio tokens, so the old rates are **parked** rather than carried over, and switching back
  restores them. Both kinds then share a peak/off-peak schedule and temporary promotions, behind disclosures that
  stay shut on an endpoint that has neither. A blank rate means **unknown**, never $0: those requests are counted, never priced,
  and every total that excludes them says so. Estimated, reserved and recorded cost are defined side
  by side. The endpoint's daily limit (one endpoint, all books) sits beside book budgets (one book,
  all endpoints) with the scopes spelled out, and a paragraph says what happens when the remaining
  budget can't cover another request. See **Cached input, schedules and promotions** below.
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

Live activity comes from the job simulator already in the store, and everything this session has
settled comes from the usage ledger. The backstory — the invented week behind the charts, the totals
and the older request rows, and the connection test — comes through `EndpointService`
(`src/services/endpoints.ts`), whose only implementation here is `FixtureEndpointService`: a seeded
generator that invents a plausible week of traffic per endpoint. Every row it produces is marked
`simulated`, the page labels sample history against work this session produced, and no provider is
called, nothing is billed and nothing persists. Swapping in an HTTP implementation is the last line
of that file.

That invented week is generated **once** and then kept until an explicit reset. It is priced from
the rate cards the seeded world holds, so a demo reset or a scenario that changes a card drops it
and the next look regenerates it — but nothing else does, because regenerating it on a timer meant
revisiting the page after editing a rate quietly rewrote the previous week's receipts at the new
price, which is the one thing a receipt exists to prevent.

The route is lazy (`() => import("@/views/EndpointsView.vue")`): the charting library is only used
here, and keeping it out of the entry chunk leaves the main bundle smaller than it was before this
page existed.

## Cached input, schedules and promotions (2026-09-17)

Pricing is no longer a flat rate. An endpoint's **Pricing & budgets** tab still opens on the rates
that endpoint needs — input and output per million tokens for a chat model, one rate and its unit
for a speech model — and everything below is a disclosure that stays shut unless that endpoint uses
it. **Both kinds go through the same schedule and the same promotions**; what differs is which rates
they have and what unit those rates are written in.

**Cached input** (chat models only; a speech endpoint has no cache, so the switches are not
offered). A switch adds a separate cached-input rate, and a second one adds a cache-write
rate where the provider bills for that too. Off is not zero: it means "no separate line", and those
tokens are charged at the ordinary input rate. The distinction matters — some providers write the
cache for free, others charge more for it than for ordinary input.

**Peak / off-peak.** A schedule is an explicit IANA timezone (shown with its current local clock, so
you can see the window you are in) and a list of recurring windows. A window whose end is at or
before its start runs **past midnight**, says so, and its day buttons then name the day it _starts_
on — Fri 22:00–02:00 is Friday night and the first two hours of Saturday. A window with no days set
is "every day" and shows all seven buttons pressed, so clicking one of them **deselects** that day
and leaves the other six, rather than collapsing the window onto the day that was clicked. Windows never stack: the
first one in the list that covers the moment wins, the list is reorderable, and one that covers but
is outranked is labelled rather than hidden. Every rate a window or promotion names is quoted in the
unit that component is billed in — `/ 1M tokens` on a chat model, `/ audio min` or `/ request` on a
speech endpoint that bills that way.

**Promotions.** A start date, an end date, a scope (whole model, or input / cached input / cache
writes / output individually) and either a percentage or explicit replacement rates. The dates are
calendar days **in the endpoint's own timezone**, the one the schedule is read in and the one every
other date on the page is displayed in — editing a New York promotion from Karachi does not move its
start or end onto another day — and the field says which zone it is naming. They are
grouped **running now**, **scheduled** and **ended — kept as history**: an expired promotion stops
applying on its own date, is never deleted for you, and never re-prices a request it already priced.

**Precedence, in one sentence each:** base rates are what the endpoint charges; the schedule may
replace them, one window at most; a promotion may replace what the schedule left, one promotion at
most _per component_ — the one that makes that component cheapest, ties going to the one ending
soonest. Nothing compounds. **Effective price now** shows all three steps per component with the
base struck through, a chip per reason, the shadowed promotions named, and one line saying what
changes next and when, in the endpoint's own timezone.

**A rate nobody knows stays unknown through every discount.** The seeded Azure proxy bills per
audio minute at a rate that was never written down and has a nightly 30% window over it: the window
is in force, the effective price is still _unknown_, and the page says so instead of producing a
confident number. Requests through it are counted, never priced, and every total that leaves them
out calls itself a floor. A two-rate endpoint with only one of its rates filled in is the same case
rather than half of one: knowing what the text costs and not what the audio costs is no answer, so
nothing is priced until both are set.

### Billing models: four different things, never conversions of each other

A speech provider meters one of several quantities and they are **not** scalings of one another. A
line of Mandarin is 12 characters, 36 UTF-8 bytes and some number of text tokens that neither figure
predicts. So every request records all of them and only the one its endpoint bills on is charged:

| Model                                | Charged on                                | Seeded as                      |
| ------------------------------------ | ----------------------------------------- | ------------------------------ |
| per 1M characters                    | billable characters — Unicode code points | OpenAI (main), $12             |
| per 1M UTF-8 bytes                   | `TextEncoder` bytes of the same content   | Fish Audio, $15                |
| per 1M input text tokens             | the submitted text, tokenised             | —                              |
| input text **+** output audio tokens | two rates, priced separately and added    | Gemini 3.1 Flash TTS, $1 + $20 |
| per audio minute                     | the recording that came back              | Azure proxy, rate unknown      |
| per request                          | a flat fee per call                       | —                              |

**Characters are not `String.length`.** That counts UTF-16 code units — an emoji as two, a Han
character as one — and is neither what a provider billing "characters" means nor what one billing
bytes meters. `billableChars` counts code points and `utf8Bytes` counts bytes, and the Fish Audio
preset bills **bytes** on purpose: its price list says "$15 per million" over prose about characters,
but the quantity it meters is UTF-8 bytes, so a chapter of Mandarin costs roughly three times what
the character count suggests.

**What is counted is what was submitted**, not what the book says: the line after the pronunciation
dictionary has rewritten it, with the expression tags inserted and the voice instructions that
travel beside it (a switch on the tab, since a few providers ignore that field). It is a separate
question from how long the chapter **is** — which is what the reading-time estimate uses — and from
the endpoint's per-request character limit, which is about payload size and lives in `lib/split.ts`.
The seeded dictionary rewrites "outer sect" into `外门`, so the byte-billed speaker's requests are
measurably more bytes than characters and the difference is visible in the estimate and on the
receipt.

**Audio tokens do not follow from the text.** They follow the length of the recording, so an
estimate goes through the audio's expected duration and a tokens-per-second conversion — an
assumption about the provider's tokeniser rather than anything this app can measure. It is editable
per endpoint (`audioTokensPerSecond`, seeded at 25), recorded on every receipt priced under it, and
any estimate that leans on it says so. A text-token approximation is never used for the audio side:
that is a different quantity, not a cheaper way of getting the same one.

**Estimates split input from audio.** `inputCost + audioCost = cost`, on the Pricing tab's worked
example, in the run panel and in the queue's run details — because on a token-billed endpoint the
audio half usually dominates, and a single total hides which one is large. The reconciliation after
a run reports the two halves separately for the same reason: an input side that lands on the nose
and an audio side 19% out is a different story from both being 10% out, and only one of them is
fixed by changing a number on the Pricing tab.

### Cache usage comes from the API, not from an assumption

`TokenUsage.inputTokens` is the **total** input; `cachedInput` and `cacheWrite` are slices of it,
never additions. A response reporting 10,000 input tokens of which 8,000 were cached is charged
8,000 at the cached rate and 2,000 at the ordinary one, with output charged separately — and the
charge lines always add back up to what the provider reported.

Providers disagree about this, so nothing reads a payload directly. `normalizeUsage` in
`src/lib/pricing.ts` is the one way in and knows three shapes: OpenAI's `prompt_tokens` **includes**
`prompt_tokens_details.cached_tokens`, Anthropic's `input_tokens` **excludes**
`cache_read_input_tokens` and `cache_creation_input_tokens`, and a plain provider reports totals and
nothing else. `src/mock/simulators/usage.ts` builds payloads in those shapes and reads them back
through the same normalizer, so both the live simulator and the seeded week of history exercise the
rule rather than assert it.

- **Zero cached tokens and no cache report are different facts.** `cachedInput: 0` is a reported
  zero. `null` means the provider said nothing: the request is then charged with the whole input at
  the ordinary rate — the conservative reading — its cost is labelled **estimated** rather than
  calculated, and the row says _"How much of the input was cached was not reported. The whole input
  is charged at the ordinary rate, so the real cost is this figure or less."_ An assumed cache miss
  is never presented as a reported one.
- **Contradictory counts are caught before the arithmetic.** Cached plus cache-write tokens adding up
  to more than the total input, a negative count, a missing one — each is repaired so no line can go
  negative, flagged on the receipt, and drops the cost to an estimate.
- **A charge the provider reported is kept apart from one we worked out.** `CostBasis` is
  `calculated`, `provider-reported`, `estimated` or `unknown`, and where a provider reports its own
  figure the receipt shows both with a note that a provider's tokeniser and rounding are not ours.

### Estimates, and what they are allowed to assume

Before a run, cache use is unknowable, so the headline estimate assumes **none**: every input token
at the ordinary rate. Beside it, and only beside it, sit two labelled alternatives — the same work at
a recently _observed_ cache rate (drawn only from requests that actually reported cache detail, so a
silent provider produces no figure at all) and the same work **without today's discounts**.

Budget checks use that last one. A promotion can expire and an off-peak window can close while a run
is still going, so a cap that only holds while a discount lasts is not a cap: reservations are taken
at undiscounted rates with the full output ceiling, and a run blocked by that says so in those words.
"Why this is an estimate and not a price" lists what could move the figure — a boundary the batch may
cross, a promotion that may expire — and finishes by saying that each request is priced when it comes
back, not when the run starts.

**"No cache savings" is not automatically a ceiling.** Cached and cache-write tokens are slices of
the input, and neither is guaranteed to be cheaper than it — a cache write commonly costs _more_,
and the switch that adds one defaults it to 125% of the input rate. So the input side of a
reservation is taken at the **dearest** rate any input token could be charged at on that card, not
at the ordinary input rate, and the run estimate only claims "the real cost is this or less" on a
card where ordinary input really is the dearest. Where it is not, the caution names the ceiling
instead and says that is what the budget is checked against.

**Narration enforces its cap in the store, at every entry point.** A bulk run, "re-narrate stale", a
retry, a retake and "retake everything flagged" all check the undiscounted price against what has
been spent _and_ what unfinished work has already reserved, and each narration job holds its
chapter's price against the cap until it lands. A check that lives only in the run panel is a
warning on one screen; two runs that each fit on their own could otherwise start together and land
past the cap between them.

### Every request keeps its own receipt

A completed scripting request stores a `PricedRequest`: the normalized usage, the rates in force,
the reasoning behind each one, the instant they were read at and the rule that chose that instant
(`PRICING_RULE` — "priced at the rates in force when the request completed"). A rendered clip stores
the speech equivalent, a `SpeechCharge`: the billing model in force, one charged line per component
with its rate and what moved that rate off the card, everything that was measured — characters,
UTF-8 bytes, text tokens, audio seconds, audio tokens and how many requests a split line became —
and whatever the provider itself reported. Where the provider reports the quantity being billed, the
receipt uses **its** number and says so; where it reports nothing, the count taken on the way out is
used and the figure is labelled an estimate rather than presented as a reconciliation. A charge the
provider reported itself stays distinct from one worked out here from reported usage, which in turn
stays distinct from one worked out from our own counts. A clip is priced when it **lands**, never when it is dispatched: a per-minute endpoint
has no audio to bill for until then, and a failed clip therefore costs a per-minute endpoint nothing
while a per-character or per-request one still charges for what it sent. The rule travels with
either receipt so a provider that bills at dispatch, or per batch, can adopt a different one without
rewriting history.

Pricing is therefore evaluated **per request**, not once per run: a batch that straddles an off-peak
boundary is charged at two different prices, and the activity log records the rates each request
used. When a run finishes it reconciles itself — estimated against charged, how much of the input
turned out to be cached, and how many requests reported no cache detail and so have an upper bound
rather than a figure. Each chapter of a bulk run is reconciled against **its own** chunks, not
against the run's total divided by the number of chapters, so a short chapter and a long one do not
report an artificial underspend and overrun against each other.

### The ledger: what was spent is what was requested

Every request that settles — a scripting chunk, a rendered clip, a retake, one that failed, one the
provider refused — is appended to `src/stores/usage.js` with the receipt it was priced from, and
nothing afterwards moves it, re-prices it or takes it out. Spending is read from there.

That is a deliberate replacement for totalling the clip currently sitting on each line, which was
wrong in both directions at once: a paid request that failed was invisible, and accepting a retake
made the money already spent on the clip it displaced **disappear** — recorded spending went down
and the budget handed back capacity it had genuinely used. A take carries its `SpeechCharge` into
the take list with it, so a superseded recording still says what it cost, at what rate, and why.

The same ledger is what the Endpoints **Activity** list reads for this session's own work. Reading
it out of the running job simulator meant a request vanished from the page the moment it finished —
the one moment its receipt is worth opening — and the page fell back to unrelated sample history.
The list now shows in-flight requests, then this session's settled ones with their receipts, then
the fixture service's invented week, with a violet dot marking everything this session produced.

The seeded world's own narration predates the ledger, so it is an opening balance: totalled once
from the **pristine** world rather than from the clips a session can move, and recomputed only when
a reset restores that world. Every clip rendered here has a row of its own instead, so the two
halves cannot overlap and neither can be un-counted by a clip being retried, replaced or displaced.

The reported cache percentage divides like by like: cached tokens over the input of the requests
that **reported** a cache figure, with the traffic that said nothing left out of both halves and
counted separately. Dividing by every request's input silently read a silent provider as a run of
misses.

The **Activity** list stays a list: a row shows `1.6k in (1.3k cached) / 796 out`, which cannot be
misread as 2.9k tokens, and a request whose provider said nothing wears a small `cache ?` mark.
Opening the row gives the receipt — a sentence spelling out how the tokens divide, then a line per
component with tokens, rate, amount and _why that rate_, the total with its basis and pricing
instant, the provider's own figure where there is one, and anything unknown in amber.

### Trying it

Demo tools has a **Rates, cache and promotions** group: cache reported / partly reported / not
reported / contradictory side by side, off-peak rates in force, a promotion running with one
scheduled and one ended, every promotion expired, a four-chapter run crossing a pricing boundary,
speech rates on discount, and **every billing model in one chapter** — five speakers routed at five
models at once, so a single run produces character-billed, byte-billed, token-billed, free and
unpriced requests and the estimate has to add all of them into one figure. The seeded endpoints cover the configuration cases between them —
OpenAI with cached input, a midnight-crossing off-peak window, a peak surcharge and three
promotions; Anthropic with cache-write pricing and the payload shape that excludes cache tokens
from the input; DeepSeek reporting its own charge; a local chat model with no advanced pricing at
all; the OpenAI speech endpoint with a nightly off-peak window and a promotion on top; a free local
Kokoro with nothing scheduled at **zero**, which is "free" and not "unknown"; Fish Audio billing
UTF-8 bytes with a promotion scoped to the speech rate; Gemini billing input text and output audio
tokens with a promotion on the **audio half only**; and the Azure proxy with a window over a rate
nobody knows.

### Limitations

Cached-input and cache-write pricing apply to **chat endpoints only** — a speech endpoint has no
prompt cache, so those switches are not offered. Everything else is shared.

A speech endpoint's `price` field survives as the per-1M-characters fallback for an endpoint that
carries no `billing` block; nothing prices from it any more. It is kept in step only where a model
can honestly produce a per-character figure — a per-request fee has no character in it, and a byte
or audio-token rate over non-ASCII text is a different quantity rather than a different scale, so
`perMillionChars` returns `null` for those rather than quoting one as the other.

Input text tokens are estimated at four characters per token where the provider does not report a
count, which is a rule of thumb and not a tokeniser. The audio-token conversion is likewise a single
configurable number per endpoint rather than a model of how any particular provider tokenises audio;
both are labelled as estimates wherever they reach a figure. The expected **duration** an audio-side
estimate rests on is this app's own reading-speed model, so an endpoint billing on the audio carries
that uncertainty on top.

`nextChange` advances local minutes arithmetically from the instant it is given, which is exact
except across a daylight-saving transition — a boundary within a fortnight of a DST change can be
reported an hour out. Window edges are minute-granular. The timezone picker offers a short list of
common zones rather than the full IANA set; an unreadable zone falls back to UTC and says so rather
than pretending. A promotion with no end date never expires, which is a configuration choice the
panel names rather than prevents.

## Model-specific expressions

TTS endpoints have an **Expressions** tab for explicitly configuring supported names, exact bracket
syntax, and whether each tag is a vocal sound or delivery instruction. Support starts unknown and is
bound to the configured model and base URL; changing either requires confirming support again.
No provider capabilities are assumed from its name.

Expanded script lines offer a searchable expression picker, placement controls,
inline annotations, and an exact outgoing-text preview after pronunciation replacements. Annotations
are separate from prose: existing bracketed text is never automatically interpreted as a control.
Splitting, joining, and editing preserve annotation positions where possible and request review
when an edit affects an anchor. Request splitting keeps each expression token intact.

Narration and retakes check compatibility before queuing and again before dispatch. A review dialog
lets the user resolve unsupported annotations or explicitly omit them; omission is saved and
reversible, never silently applied. Changes invalidate affected audio, and take snapshots and job
events retain the expressions actually rendered. These workflows use the existing simulator; no
real speech or provider capability verification is performed. Book annotations remain in memory.
