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

The app always runs in demo mode: seeded books, seeded cast and voices, and timer-driven fakes in place of the endpoints. Nothing is fetched, nothing is billed, and **every cost, duration and file size on screen is invented**. The sidebar says so under the app name, and the **Demo** chip in the header opens the panel.

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
| One speaker mis-attributed all through         | An alias scattered through the book, with Search open on the matches — the bulk corrections flow.                                                                                                                                                                                                                                         |
| The five Export rows                           | A book ready to export, ready/missing/stale together, a 214-chapter serial, an export that needs updating, and running/failed/finished builds. Opens Export.                                                                                                                                                                              |

The **make the next build fail** switch is one-shot: the build stops part-way, the version already on disk is untouched, and the failure offers a retry.

Reset also covers what lives outside the stores: half-typed endpoint forms and page filters, the demo's own credentials, and any page open on a book the seeded world does not have — an EPUB you added during the session is dropped, so that page is sent back to the Library first.

Switching scenarios or resetting **abandons simulated work in flight**. Each run records which generation of the demo world it was started against, and every simulator checks that before it writes; a chapter, a clip or a build from the world you just left cannot land in the one you are looking at now. The Search page keeps a **Demo searches** chip of its own: those rows are queries against the seeded book — the mis-attributed alias, the same lines already settled, a term the book never uses — rather than situations, so they sit with the page that runs them.

## Pages

- **Library** → **Add EPUB** → **Contents** (what goes in the audiobook) → **Book overview** (volumes, per-stage progress, cast summary, "what next") → stages **Scripting / Narration / Export**.
- **Contents** (per book): every chapter in reading order, grouped by volume, with the notices the import found beside the titles; skip or restore chapters, singly, in ranges, by volume or by kind of notice. Reached from the import and again from the overview.
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
- Export: open the header's **Demo** chip and pick an Export scenario. _A long book_ opens **Thousand Gates of the Ninth Heaven** — 214 chapters over 6 volumes: filter to **Needs attention**, switch **Files** between one file / per volume / per chapter and watch the names and the count follow, then **See the chapter order**. _An export that needs updating_ shows v2 nine chapters behind with 191 carried over — press **Update to v3** and watch the Queue say `Encoding 50 of 204 · file 2 of 6`. On _Ashes of the Starforge_ chapter 1 is stale, so the build waits for you to choose. Open **Loudness** to see five voices 4.3 LU apart and what matching would do; open **Pauses** and nudge "after a line" — the running time, the size and the preview all move, and the finished export says it is behind the book. Turn on **make the next build fail** in the Demo panel and build: the previous version is untouched and Retry starts over.
- Review: _Starforge_ ch 1 has three flagged clips and one retake already waiting — play both takes and keep one. Flag another line yourself (⚑), then `↻ Retake flagged`.
- Pronunciation: Narration → **Pronunciation** on _Cliché_ — `Ji Ning → Jee Ning` and `Lan’er → Lahn-urr` are already in; click the count for a before/after on a real line, change one and watch the clips that used it go stale. In the reader those words are underlined; hover for the respelling.
- Pacing: _Starforge_ ch 1 holds 1.5s after the Captain's threat and runs straight on into the reply — the ledger's scrubber draws both gaps. Set your own in the reader under **Pause after**, or `[`/`]`.
- Endpoints: open **Endpoints** in the sidebar. _Antigravity (local)_ has never been used — it reads **Not tested**, not healthy. _Azure proxy_ is billed per audio minute at a rate nobody wrote down: its spend shows **unknown**, and the totals say how many rows they are missing. On the Overview tab switch to **Latency** and see queue wait stacked under provider response, then click a bar to filter the Activity list to those requests. Type `2500` into Concurrency on the Requests tab — the slider range follows. Start a narration run, then **Pause** _Local Kokoro_: the queue holds, the run doesn't fail, and **Resume** picks it up. **Cancel** says what it will do first.
- Boundaries: in the reader, open a line and press `s` — click a gap to cut it, then give the second half its own speaker. `m` joins a line with the next. Try it on the unverified chunk in _Cliché_ ch 7.
- Bulk corrections: on _Cliché_ open **Search**, hit **Demo searches** and pick _Mis-attributed “Ning”_. Tick a chapter, or **Select all matching results** (it takes the matches the page is not showing), then **Change speaker…** → _Ji Ning_: 46 will change, 21 already use it, 12 clips go stale. Apply, read the strip, **Undo this batch**. Pick _Ning_ instead to see the no-voice warning, try **Direction…** with an empty field, and _Lines already read by Ji Ning_ for a batch with nothing to do. **Add pronunciation…** with `Ji Ning` in the box finds the entry that already exists.

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
