# Library, contents and everyday workflow

[Back to README](../README.md) · [Demo walkthroughs](demo.md#things-to-try)

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

## States worth knowing

- Scripting: `done`, `fallback` (a chunk didn't verify → kept whole as narration, retry per chunk from the reader), `failed` (nothing kept; try smaller chunks).
- Narration: `done`, `stale` (script edited after narration → "Re-narrate changed" renders only those segments, including halves of a hand-split line that were never rendered), `failed` (per-segment retry).
- A segment can hold several **takes**. `segment.audio` is always the clip in the book; a retake renders into `segment.candidate` and replaces nothing — not the player, not the chapter length, not the export — until it is accepted. Rejected takes stay in the row's details.
- Narration is also `stale` when the **pronunciation dictionary** changes under a clip that used the old spelling. A **pause** never makes anything stale: it is stitched, not rendered.
- Export: an **export** is one deliverable in one or more files, versioned by name + format + layout. It stores a fingerprint of every chapter it was built from, so "needs an update" is a comparison against the book rather than a date; a failed or cancelled build never replaces the version already on disk.
- Endpoints back off for a few seconds on a simulated rate limit; health strip shows latency sparkline, ok rate, failures, 429s.
- **Voices belong to endpoints.** Each endpoint card lists its voices (fetch from the server, add by id, remove); character pickers are grouped by endpoint, and a paused endpoint's voices are listed but disabled. A character's voice is a ref `endpointId/voiceId`, so every segment is rendered by the endpoint that owns its speaker's voice (unvoiced speakers borrow the Narrator's). Removing a voice or pausing its endpoint shows up as a blocker on the voice card and in "This run"; segments that can't be routed fail with a reason instead of hanging.
- **Per-request character limit** per endpoint (`maxChars`, 0 = whole segments). Longer segments are sent as several requests and joined; the endpoint card says how many segments of the open book would split, the run estimate counts requests and splits, and the ledger marks rows "N parts · M ch" (click to see the exact cuts). **Cut at** chooses the boundary: sentence end, clause (`, ; : —`), word, or hard cut; when the preferred boundary doesn't occur inside the window it falls back to the next finer one and the part is flagged. The endpoint card previews how the longest routed segment of the open book would be cut ([src/lib/split.ts](../src/lib/split.ts)).
- **Command palette** — `⌘K` / `Ctrl+K` (or the header button): reka Dialog + Listbox with `useFilter`. Jump to any page, novel, chapter (opens it at the stage it's at via `?ch=`), speaker or endpoint, or run actions: script pending, narrate scripted, re-narrate changed, retry/cancel jobs, auto-assign voices, pause/resume an endpoint, toggle theme. Enter with nothing highlighted runs the first match.
- **Volumes are sortable** (drag the handle or ▲▼) and can be **renamed and removed** from the book overview (wrong EPUB added). Reordering renumbers chapters so they follow the volume order. Removing one deletes its chapters, segments, jobs and export entries, renumbers the remaining chapters so numbering stays continuous, and removing the only volume removes the novel.
- A chapter keeps the **scripts it has been through**: a re-script, a bulk correction, a restore and each run of manual edits preserve the script they replace, and **History** in the reader previews, compares and restores one. A version is the chapter's script only — never the audio, never the book's cast, dictionary or endpoints — and restoring carries the clips that still match the restored lines.
- Reader keyboard: `j`/`k` move, `↵` edit, `1–9` assign speaker, `s` split, `m` join next, `[`/`]` pause, `c` toggle cast.

## Shared editing and navigation

- **Chapter peek & skip** — every picker row has a ⌕ popover with the raw text and word count and a "Skip this chapter" toggle; skipped chapters leave every stage, the run totals and the audiobook.
- **Re-script** from the reader header: profile + chunk size, "keep my N manual edits" (re-applied where the text still matches), then a "what changed" panel (speaker / direction changes, new / gone segments, click to jump). Edited segments carry `edited: true`.
- **Undo** — merge, rename, delete speaker, remove volume / novel / endpoint / voice, delete export all toast with Undo; `⌘Z`/`Ctrl+Z` outside a field undoes the latest. Snapshots in `_castSnapshot` / `_bookSnapshot`. This is the app's one rule for danger: **undoable actions happen at once and offer Undo, and only what cannot be undone asks first** — discarding an import, and cancelling runs in flight. Nothing asks _and_ offers Undo, which is what removing a novel and removing a volume used to do; what their confirmation step explained now sits on the control (its label and `title`) and in the toast, which also names the runs the removal cancelled, since those are the one thing Undo does not bring back.
- **Export**: custom cover, chapter markers with a title pattern and preview, listen / download / on-disk path per finished file. (See [export planning and its simulation limits](exports.md).)
- **Script search** (`/book/:id/search`, or type ≥2 chars in the palette): text, speaker, direction across every scripted chapter; results deep-link to the segment (`?ch=&seg=`), and can be selected for a bulk correction (see [bulk corrections](scripting.md#bulk-corrections-in-search)).
- **Audit trail**: each rendered clip records voice, model, direction, style, type, time, cost. Clicking a ledger row (or `i`) shows it and spells out what differs from the script now (why a row is stale). Failures carry HTTP status + body and a "copy request".
- **Voice picker** popover (search, gender filter, grouped by endpoint, "N using", inline demo) replaces the flat select on Voices and Cast.
- **Direction** is a combobox: presets + directions already used in the book, free text allowed, and "→ all <speaker>" applies it to every line of that speaker in the chapter.
- **Stale nudge** in the reader header and the sidebar count; endpoint pool is now a master/detail list; queue shows an ETA and can notify when a book's run finishes; keyboard on picker / ledger / cast (`?` lists everything).
- **Responsive**: sidebar becomes a drawer under `lg`, stage layouts stack, tables scroll inside their cards.
- **Backend-shaped**: API keys live in [src/lib/keyring.ts](../src/lib/keyring.ts) (reactive, in-memory, never in the store or the settings file); settings export/import as JSON; per-book budget cap + "pause everything on this book"; `spent()` from the append-only usage ledger ([src/stores/usage.ts](../src/stores/usage.ts)), not from whatever clip each line is holding now. Persistence and resume are left to the real backend on purpose.

## Import, contents and the library shelf

A web-novel EPUB is not all story. Between the chapters sit hiatus notices, health updates, release
schedules, sponsor thanks, vote reminders, links — and an audiobook that reads them aloud is an
audiobook nobody finishes. Import used to drop a file straight onto the shelf; skipping was a toggle
buried in a peek popover, one chapter at a time. Now the file is **read, reviewed and then added**.

**Import → Contents → Add.** `Add EPUB` (or a sample from **Try a sample** beside it) opens the
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
answer is one of `IMPORT_SAMPLES` ([src/mock/fixtures/imports.ts](../src/mock/fixtures/imports.ts)): the sample fixes the chapters,
which of them carry a note, and where a mixed chapter's note sits; [src/mock/fixtures/notices.ts](../src/mock/fixtures/notices.ts)
supplies the reasons, the evidence and the bodies; [src/mock/world/text.ts](../src/mock/world/text.ts) composes a chapter's
text from its note, so the peek, the preview, the scripting estimate and the mock run all read the
same thing. The seeded books' two skipped chapters now carry the note that explains them. The Demo
chip has an **Importing an EPUB** group, one row per sample; a reset drops the imported book.

**The shelf, redone (2026-09-16).** The Library used to spend a third of the viewport on a drop
zone and a sample banner before a book appeared, and each card offered three bare numbers and a
badge over a gradient. Now the books come first. The drop target is a one-line hint, and grows into
a full-page target only while a file is over the window; the samples are a **Try a sample** menu
beside **Add EPUB**. Each card says the one next thing to do as a verb with a destination
(_Narrate 9 chapters_, _Retry 2 failed chapters_, _Update the audiobook_ — `nextStepOf` in
[src/views/library/shared.ts](../src/views/library/shared.ts)), draws progress as one segmented bar (narrated · scripted · not
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
covers and a table ([src/views/library/ShelfTable.vue](../src/views/library/ShelfTable.vue)) with one row per book and the pipeline as
columns — in the audiobook, scripted, narrated, audiobook, next — with progress per stage the way
the overview shows it, so the two pages agree. The choice sits in the URL as `?view=list` and is
remembered for the next visit. A third layout, lanes by what each book needs, was prototyped on
the same route and dropped: with a shelf this size every book landed in one lane.

**Finding a book on it (2026-09-16).** Four seeded books never made the shelf cope with twenty,
so the Demo tools gained **A full shelf**: eighteen more books ([src/mock/fixtures/shelf.ts](../src/mock/fixtures/shelf.ts)),
each left at one point in the pipeline — nothing run, part scripted, part narrated, failed
scripting, stale audio, everything narrated, an audiobook that matches, one the book has moved on
from — with their reviews already done. Against it the shelf has a search (title or author, every
word, accents ignored, `/` to focus), filter chips with counts (**Needs attention**, **Running**,
**Behind**, **Up to date** — the lanes of the dropped board, as filters), and an order (recently
added, title, author, most to do, least scripted, least narrated; the table's column headers order
it too). Search, filter, order and shape all sit in the URL (`?q=harbour&filter=attention&sort=todo&view=list`),
so a narrowed shelf can be linked to and survives a reload. A search that matches nothing says so
and offers **Show all books**, so a stale filter is never mistaken for an empty library. The `⋯`
menu is now on table rows as well as covers ([src/views/library/BookMenu.vue](../src/views/library/BookMenu.vue)); its popover
content is mounted only while open, because a closed one left inside a card that a search then
narrows away froze the renderer on unmount. [src/views/library/shelf.ts](../src/views/library/shelf.ts) holds the pure
filter and order logic, covered in [tests/library.test.ts](../tests/library.test.ts) along with the demo row itself.

[tests/contents.test.ts](../tests/contents.test.ts) covers the states and counts, every sample's shape (continuous numbering,
volumes that cover their chapters, nothing pre-skipped), the situations (clean, scattered, between
volumes, repeated, misleading, mixed, all-notices), text composition with the note marked, import →
confirm → cancel for a book and for a volume, batch skip with an Undo that restores `kept` too, and
that a skipped chapter leaves the scripting estimate and export readiness and comes back when
restored.
