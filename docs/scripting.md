# Script corrections, history and bulk reruns

[Back to README](../README.md) · [Endpoint setup](endpoints.md#scripting-endpoints) · [Audio review](audio.md)

## Bulk corrections in Search

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
  [src/lib/bulk.ts](../src/lib/bulk.ts)). A tall panel scrolls inside the bar instead of eating the viewport.
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

## Chapter script history

Before script history, re-scripting threw the old script away. Bulk corrections and an afternoon
of editing could also leave no useful checkpoint to return to. The reader could undo the last
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

Store ownership: `history.ts` owns the versions, the editing sessions and restoring; [lib/scriptHistory.ts](../src/lib/scriptHistory.ts)
is the pure part (what a version preserves, what two of them disagree on, what a restore would do), and
the panel renders exactly what the plan counted. [tests/history.test.ts](../tests/history.test.ts) covers snapshot independence,
session grouping, the runs that must leave no entry, comparison accuracy including splits and joins,
restoring with its audio consequences and the narrow undo, the missing speaker, the run in flight,
renumbering a book, and a demo reset while an editing session is still collecting.

## Bulk re-scripting and re-narration

Completed chapters could always be ticked and run again — nothing stopped you — but the app never
said what that would do. "Run scripting (8)" on a selection of three new chapters and five finished
ones read the same as "Run scripting (8)" on eight new ones, bulk re-scripting quietly defaulted to
throwing away every manual correction in those chapters, and a full re-narration requeued clips that
were perfectly good and deleted the retakes waiting beside them. Re-doing work is now a thing the app
explains before it does it, and one that keeps what it is replacing until the replacement actually
lands.

**One plan behind everything.** [lib/runPlan.ts](../src/lib/runPlan.ts) works out what a selection contains and what pressing
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
same `noteScripted` path described in [script history](scripting.md#chapter-script-history), so **Restore** is always the way back.

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

Store ownership: [lib/runPlan.ts](../src/lib/runPlan.ts) is the pure part (what a selection contains, which clips a scope runs,
what a plan reads as); `scripting.ts` and `narration.ts` own their runs and hand the simulators exactly
the slice they need; `jobs.ts` owns the run ids, cancelling a run and retrying its failures.
[tests/bulkRuns.test.ts](../tests/bulkRuns.test.ts) covers the selection summary and the plan's skip reasons, preservation and the
corrections that could not be re-applied, a failed and a cancelled replacement, an overtaken result, each
scope's estimate, a clip kept playable through its replacement, a failed replacement and its narrow
retry, pending retakes, cancellation, and both seeded rows.
