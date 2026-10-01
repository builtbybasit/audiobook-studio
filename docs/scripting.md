# Script corrections, history and bulk reruns

[Back to README](../README.md) · [Endpoint setup](endpoints.md#scripting-endpoints) · [Audio review](audio.md)

## Bulk corrections in Search

When a model mis-attributes forty lines, Search carries the whole correction — **find → select → choose → preview → apply → undo** — without opening each line in the reader.

- **Selection is a set of lines, not a slice of the page.** Results show 40 lines at a time; the counts and every "select all" speak for the whole match set (`12 selected · 46 matching lines in 8 chapters`), and **Select all matching results** takes the matches below the fold too, with the footer saying how many. Select per line, per chapter (tri-state) or everything.
- **Selecting is not opening.** The checkbox and the row's link are separate targets; ticking never navigates. Changing the query or a filter **drops the selection** and says so, in a toast and an `aria-live` line, because a hidden selection is a correction waiting to go wrong.
- **One panel, opened inside the bar**, not a modal or a chain of confirmations ([src/views/search/BulkPanel.vue](../src/views/search/BulkPanel.vue)). It expands the bar downward so the results stay on screen; pressing the action again closes it and returns focus to the button. A strip of labelled facts (_selected · will change · unchanged · clips going stale_) and tinted callouts for what costs something come from `bulkPreview`, a pure store getter that also supplies before/after rows with chapter and speaker context; **Inspect all N** lists every affected line with a reason beside each skipped one. The final button names the work — **Change 39 lines** — and is dead when there is none. Opening, configuring and closing change nothing. If a selected line is edited elsewhere while the panel is open, the numbers are marked out of date and apply waits for a fresh preview; a clip finishing in the background is not such an edit (`scriptFingerprint` vs `segmentFingerprint` in [src/lib/bulk.ts](../src/lib/bulk.ts)).
- **Change speaker** picks from the book's cast only: no character is created, merged or given a fallback voice behind your back. It names the voice that will read the lines, and when the character has none it says so and links to Cast.
- **Direction** is an explicit _set_ or _clear_. An empty field clears nothing, and setting one says how many lines already carry a direction it would replace. Directions are not expression tags; the prose and its annotations are never touched.
- **Flag for review** reuses the ledger's categories and notes, keeps existing flags by default, and makes replacing them a switch you have to find. Flagging stales no audio, and says so.
- **Apply and undo.** Every line goes through `setSpeaker` / `updateSegment` / `flagSegment`, the actions a single edit uses, so `edited`, clip staleness and annotations end up exactly where they would by hand, and each chapter is written to the server once under the batch's name. Audio is never regenerated automatically; the old clips stay for comparison. One undo covers the batch, shared by the toast, `⌘Z` and the result strip, so it can only be taken once, and a line edited after the batch is left alone rather than overwritten.
- **Add pronunciation…** sits beside the search term, not in the bulk bar, because a dictionary entry applies to the whole book rather than the selected lines ([src/views/search/PronunciationDialog.vue](../src/views/search/PronunciationDialog.vue)). It previews across the book, edits an existing entry instead of adding a second, and prefills only a word-sized term, never a whole search phrase.

In the demo, **One speaker mis-attributed all through** opens Search on an alias scattered through _The Cliché Cultivation World_, with mixed speakers and directions, clips rendered, stale and not yet rendered, and some lines already flagged ([things to try](demo.md#things-to-try)). [tests/bulk.test.ts](../tests/bulk.test.ts) guards that previewing changes nothing, applying touches exactly the lines the preview counted, and one undo puts the batch back without stepping on later edits.

## Chapter script history

A chapter keeps the scripts it has been through, so trying another model on a chapter, or an afternoon of edits, is an experiment you can look at and go back from rather than a bet.

**History** sits in the reader header beside Re-script, with the number of saved versions on it ([src/views/scripting/ScriptHistory.vue](../src/views/scripting/ScriptHistory.vue)). It takes over the reader's body rather than opening beside it, so there is never a question of which script is on screen. It has three states and the strip across the top always says which: **the list**, a read-only **preview** of one version, or a **comparison** of one against the current script. `?history=1` opens it.

**What makes an entry.** The server preserves the working script _before_ anything replaces it, inside the transaction that writes the new one, labelled by what produced it: a re-script (with the endpoint and model), a bulk correction (with the batch's name and the lines it changed), a restore, or a run of manual edits. Ordinary editing is grouped into **editing sessions**: edits less than ten seconds apart (`SESSION_IDLE_MS`) are one entry, so an hour's work reads as "9 manual edits", not ninety rows. The rule is deliberately simple to predict: the first edit after a quiet spell preserves the script and opens the session, every edit after it joins that entry, and the script the session produced is what the _next_ replacement preserves. Speaker, type, direction, words, expressions, pauses, splits, joins and deletions all count as edits; a clip finishing in the background does not, because a version holds the script and never the audio.

An operation that changes nothing adds nothing: a re-script with the same attribution, a bulk batch that matched nothing, an edit that set a value to what it already was. A run that **failed, was cancelled or hit the budget** never writes a script, so it cannot push a good one into the list — the entry is taken at the run's one write, against the revision it read, not when the run starts. "Changes nothing" is judged losslessly: two scripts with the same words spaced differently are two scripts, and the comparison names that difference in words.

**An edit and its entry are one thing.** Undoing an edit writes the previous script back as an edit of its own, so the history records what happened rather than losing the entry; undoing one edit of a session leaves the rest of the session standing.

**Save a checkpoint** names the script as it stands — _Dialogue reviewed_, _Before trying DeepSeek_ — without changing a word, and the entry still says how that state was reached ("saved by hand · 6 manual edits").

**What changed.** A comparison leads with the summary — _6 lines differ · 1 line rewritten · 1 speaker change · 3 direction changes · 2 line splits_ — then lists only the lines that moved, filtered by kind (words, speakers, directions, types, expressions, pauses, structure) and paged, so a 600-line chapter stays readable. Lines are matched on their words first, so a line that only changed speaker, pacing or expressions is recognised as the same line; what is left is checked for a line cut in two or two lines run into one before anything is called new or gone. A rewritten line is shown as two rows, the removed words struck out of the first and the added words underlined in the second, marked `−` / `+` and badged in words, so nothing is told by colour alone. Every change on the current side opens the line in the reader.

**Restoring** says what it will do first, in counts: lines that change, clips that still match, clips that carry over but go stale, clips dropped with lines this version does not have, restored lines with no audio, and what the chapter's narration becomes. Then it happens at once with Undo (`⌘Z`). That Undo is as narrow as the restore: this chapter's script, the chapter's own status, and any speakers the restore had to put back into the cast — not a chapter edited or a voice changed while the toast was up.

**The audio is not thrown away.** A clip belongs to a restored line when that line reads as the clip's own text does — because the script says so, or because the clip was rendered from those exact words, which is how a line since joined into its neighbour finds its own clip again. Carried clips are re-judged against the restored line by the same `clipDrift` the ledger uses: current, or stale because the speaker, direction, expressions or dictionary have moved on. Takes and a retake waiting for a verdict travel with their clip. The chapter's narration status, running time and the export's "needs an update" follow, so a restore can take a chapter from stale back to done.

**A version is the chapter's script, not the book.** The cast, voices, dictionary, pacing and endpoint settings belong to the book and are never rolled back with a chapter, and the panel says so. When a version uses a speaker the cast no longer has (an alias merged away since), the restore block names it and counts its lines, and restoring puts it back as an unreviewed speaker for the Cast page's merge and rename.

**A run in flight is not raced.** A scripting or narration job on this chapter would write a script, clip or status belonging to the version you just left, so restoring waits: the block names the run and offers Cancel, which asks because it cannot be undone, and Restore enables itself when the queue settles.

A chapter's history belongs to the chapter, not its number: removing or reordering a volume renumbers the chapters after it, and the histories move with the scripts, jobs and export entries in the same transaction.

The server records history; [src/lib/scriptHistory.ts](../src/lib/scriptHistory.ts) is the pure part both sides share (what a version preserves, what two versions disagree on, what a restore would do), and `history.ts` in the stores reads it and applies restores ([store invariants](../src/stores/README.md)). [tests/history.test.ts](../tests/history.test.ts) covers comparisons, restoring with its audio and the narrow undo, the missing speaker, the run in flight and renumbering; [tests/server/scriptEdit.test.ts](../tests/server/scriptEdit.test.ts) covers what makes an entry.

## Starting a scripting run

**Which endpoint a run goes to** is one setting for the library, kept by the server under the `script` settings key. It travels in the endpoint configuration the Endpoints page saves (`GET`/`PUT /api/endpoints`), so the endpoints store writes it behind like the rest and a reload, or another tab, finds it where it was left. The server refuses one that names a profile it was not saved with. A fresh library has none picked; the demo is seeded with its first profile.

Every part of the Scripting page names the same endpoint, `scripting.runProfile`: the one picked while it exists — paused or not, since the blockers then say so — or else the first enabled profile whose settings are valid, or none. Removing the picked profile leaves none picked, and its Undo picks it again. The run settings, the endpoint panel and the reader's Re-script popover pick it with one control ([ScriptProfileSelect.vue](../src/views/scripting/ScriptProfileSelect.vue)) that lists every profile, says which are paused, need a key or need their settings checked, and never shows an id that names nothing. The endpoint panel shows how that endpoint is doing and how it would cut the chapter about to run; its connection, limits and pricing are edited on the Endpoints page, where the link opens its Connection tab, and so is the settings file.

**No button starts a run the estimate would not.** Run, the empty states' Script and Re-run buttons, the reader's Re-script, Re-split this chunk and the palette's _Script all pending chapters_ all go through `scripting.startRun`, which reads the chapters' text, prices them and refuses with a toast naming each blocker. A run first sends any endpoint edit still waiting in the write-behind, since the server reads the profile from its own database: **Smaller chunks + re-run** cuts the endpoint's chunk size by 2,000 characters — for every book that endpoint scripts, which its toast says — and the run goes out at the new size.

**What is not read yet is not zero.** The plan and the estimate count each chapter's plain text, and the page reads the text of every chapter ticked or open (`useChapterTexts`); until it is in, the estimate says it is reading and Run waits, rather than pricing the chapter at no requests and $0. The same goes for the book's spending under a cap, the corrected lines a re-script would carry, the opened chapter's script, the chapter's history, the rest of the cast's line counts and the endpoint's recent requests: each says it is being read until it is. Whether a chapter has a script to replace is the chapter's own status, which the server keeps as scripted when a re-script fails. The budget a run is checked against is the lower of the book's scripting budget and its overall cap, and the run settings show that one figure.

## What a run remembers

A model reads one chunk at a time, and a web novel's chapter often opens in the middle of a
conversation — "Then we go tonight." — without saying who speaks. So each request is sent what came
before it, and each answer says what the next request will need:

- **The cast, with what tells its members apart.** `{{cast}}` names every speaker the book has with
  their gender and other names ("Havoc (male; also called the mercenary)"), so a "she said" can be
  narrowed down and "the Captain" is given the name the book already uses rather than becoming a new
  speaker. Descriptions go only with `{{cast.details}}`: a web novel's cast runs to hundreds, and
  every character of the prompt is sent, and billed, with every request.
- **What the model learnt of them.** An answer's `cast` gives the gender, other names and a
  one-sentence description of the speakers the excerpt says something new about. The run fills in
  only what the cast leaves blank — a gender or description set by hand, or by an earlier chapter,
  stands, and other names are only added — so a speaker arrives on the Cast page ready to give a
  voice to. A name mentioned but never given a line is not added.
- **Where the chapter before left off.** An answer's `recap` says who is present (the silent ones
  too), where, who spoke last and to whom, and what is still unanswered. The chapter keeps its last
  request's recap, and the next chapter's requests send it as `{{previous.recap}}`. The nearest
  chapter before that is not skipped is the one asked; if it has no recap — never scripted, or
  scripted before recaps — nothing is sent, rather than an older scene. A re-script replaces the
  recap, and one with none clears it.
- **The prose before the chunk.** Inside a chapter the chunks are sent side by side, so a chunk
  cannot wait for the one before it to come back. It is sent that chunk's last paragraphs instead,
  as `{{excerpt.before}}`, marked as context and not part of the excerpt.

Neither `cast` nor `recap` can change a word of the script, so the word-for-word check still guards
the text; a wrong one misleads who a line is given to, which is seen and corrected like any other
attribution. The job's log shows the recap it kept and the speakers it filled in.

## Site text and translator's notes

Web-novel chapters carry words that are not the story. A site's boilerplate ("Read the latest chapters at novelbin.com", "This chapter was stolen from …", a bare web address, a request to vote or to support a Patreon) sits between paragraphs, and anti-scraping lines are dropped into the middle of a sentence. Translators and authors add notes of their own: "(TL note: …)", "A/N: …". None of it is the story the audiobook is for.

**Marked, never stripped.** Deleting it is the obvious fix, and the one the app cannot make. Every scripting answer is checked word for word against the prose it was sent (`fidelity` in [server/providers/chatScripting.ts](../server/providers/chatScripting.ts)), and that check is the only guarantee that a model did not quietly drop a sentence of story. A model allowed to leave out "text that is not the story" is a model allowed to leave out story, and the check could no longer tell the two apart. So the model keeps every word and puts such text on lines of its own, with two types beside narration, dialogue and thought:

- **`watermark`**: the site's text. It is never read aloud.
- **`note`**: a translator's or author's note. It is read only when the book says so, with **Read translator's notes aloud** under the overview's **Reading** card (`Book.readNotes`). It is off by default. Most listeners want the story alone, and a note that explains a pun is sometimes worth hearing, so each book decides.

What is read aloud is decided in one place, `isSpoken` in [src/lib/siteText.ts](../src/lib/siteText.ts). Everything that renders, times, counts, bills or exports audio asks it, on the server and in the page alike, so no two places can disagree about whether a line is heard.

**What the model is told.** The locked output format (`OUTPUT_FORMAT` in [src/lib/prompt.ts](../src/lib/prompt.ts)) names both types and their rules. Site text goes on lines of its own, word for word, even inside a sentence, which then becomes a narration line, a watermark line and a narration line. A note keeps its label and its brackets. And "when unsure whether something is the story, it is the story", because a line wrongly marked is silently missing from the audiobook, while a line wrongly left in is heard and fixed. A model that spells a type its own way ("site text", "TL note") is read as the type it means. A watermark or note line is always the Narrator's, whoever the model named, so a watermark never adds a speaker to the cast.

**The detector beside the model.** A model misses some site text and mistakes some story for it, so a deterministic detector reads each line after a run and only ever suggests. Its signals (`siteTextSignals`) are phrases rather than words, for the reason the import's notice detection gives: a story says "read", "site", "vote" and "chapter" freely. It looks for:

- **a web address**, including the spellings scrapers use to get past a filter: `novelbin . com`, `novelbin[dot]com`, `novelbin dot com`. A full stop followed by a new sentence is not one: "look at me. Me?" names no site;
- **words that tell the reader where to read**, pointing at a site, an address or a name: "Read the latest chapters at Webnovel", but not "read the next chapter of the manual at dawn";
- **words that say the text was taken**: "This chapter was stolen from …", "If you're reading this on a site other than …", but not "the pill was stolen from the furnace";
- **a line that opens as a note**: "(TL note:", "A/N:", "T/N -", "Translator's note:". The abbreviations count only in capitals, so "An—" stays a stammer and "Ed—" a name;
- **a request for support**: Patreon, Ko-fi, "vote for this novel", power stones asked for with a vote.

A line's own words cannot show one more signal: **repetition across chapters**. The same line, word for word (case and spacing aside), in three or more of the book's other chapters is boilerplate however ordinary it reads, and the suggestion says so ("repeated in 14 chapters"). A line needs five words before its repeating counts, so "Yes." and "He nodded." are left alone.

**Suggestions, accepted or dismissed.** A line typed as story that trips a signal carries `siteCheck { suggest: "watermark", why }`. A line marked as site text that trips none and runs past forty words carries `{ suggest: "narration", why: "reads like story" }`. The reader shows the suggestion under its line with what gave it away. **Accept** gives the line the suggested type. **Dismiss** keeps the type and drops the suggestion, so it does not come back on the next read. Changing the line's type by hand clears it too. The reader's **Site text** filter lists every marked line and every suggestion together. A marked line stays where it is in the script, shown for what it is, with **Not site text** one click away. A line left out of the audio leaves no gap anyone would hear, so every change that moves a line into or out of what is read says so in a toast with Undo.

**Too much marked is a warning.** When more than 15% of a chapter's words are on lines that will not be read (`UNREAD_SHARE_WARNING`, counted by `unreadShare`), the scripting job's log warns and the review inbox lists the chapter first under **Site text to check** — one figure, counted one way, in both places. A note the book reads is not left out, so it does not count. Real boilerplate is a line or two a chapter, and a model that marks that much is more likely to be hiding story than finding boilerplate.

**Skipped lines are counted, not hidden.** Narration renders, times and bills only the lines that are read, and a run says how many it passed over ([audio](audio.md#what-is-read-aloud)). The export leaves them out of the stitch ([export](exports.md#building-and-maintaining-an-audiobook)), and the run plan, the cast's line counts and the reader's header count them as they are read. A rendered line later marked as site text keeps its clip without being heard, so marking it back as story plays the same clip again with no new render. Turning **Read translator's notes aloud** on makes every note a line to narrate, and the narration estimate counts them from then on.

In the demo, chapter 8 of _The Cliché Cultivation World_ carries every case: the boilerplate between paragraphs, a sentence cut in three around an anti-scraping line, a translator's note, and one suggestion each way. The same boilerplate recurs in chapters 9 to 11. **Site text and a translator's note** under Review and retakes opens it ([things to try](demo.md#things-to-try)). The simulated scripter marks site text by the same signals a sentence at a time, so a demo re-script marks the boilerplate again and still holds every word; boilerplate dropped inside a sentence takes that sentence with it there, which a real model does not have to. [tests/siteText.test.ts](../tests/siteText.test.ts) holds the detector to its signals and to a list of story sentences that must not trip them, `isSpoken` to the book's choice, and the demo chapter's script to its prose, word for word.

## Bulk re-scripting and re-narration

Running a stage again over finished chapters is something the app explains before it does it, and it keeps what it is replacing until the replacement lands.

**One plan behind everything.** [src/lib/runPlan.ts](../src/lib/runPlan.ts) works out what a selection contains and what pressing the button would do to it, without touching anything. The picker's summary line, the button's label, the estimate and the work the server queues all come from that one calculation, so they cannot disagree. A chapter is _new work_, a _replacement_ of something finished, or a _retry_ of something that failed; anything left out is left out for a named reason.

**Selecting.** The picker has checkboxes, volume headers and shift-click ranges, and a Select row — Pending, Completed, Stale, Failed — where each shortcut appears only when it would pick something. Shortcuts read the whole book, never the search; while a search is on, the header says **All 12 results** beside **Whole book (40)**. Under it, one sentence says what is ticked: _8 chapters selected: 3 new, 5 already scripted._

**The button says the operation.** _Script 3 chapters_, _Re-script 5 chapters_, _Script 2 · re-script 3_ — counting the chapters that will actually run, not the number ticked. Under it: what the run does, then what it leaves out and why (_2 chapters left out: 1 already running or queued, 1 skipped from the audiobook_).

**Bulk re-scripting.** The Scripting page shows the endpoint, model and cost, and what the book's scripting budget has left. A re-script does not carry the corrections made by hand: the new script replaces the old one outright, and the run settings and the reader's Re-script popover say how many corrected lines that is before you press it. Every replaced script goes into the chapter's [history](#chapter-script-history) first, corrections and all, so **Restore** is always the way back. The page once had **Preserve manual corrections** and **Strip site boilerplate** switches. Nothing ever acted on them, so they are gone: history is how corrections are kept, and site text is [marked by the model](#site-text-and-translators-notes) rather than stripped.

**A replacement that produces nothing changes nothing.** A re-script that failed verification, was cancelled, ran out of budget or was overtaken by a newer run leaves the previous script as the chapter's script, and the chapter still reads as _scripted_. That matters beyond the label: a chapter that reads as failed is neither narratable nor exportable. The server writes a run's script once, against the revision it read, so a result the chapter has moved on from is discarded with a line in the log.

**Bulk re-narration has a scope**, and the estimate counts that scope rather than every line in the chapter:

- **Missing & changed** — lines with no usable clip (never rendered, or the request failed) and lines whose clip no longer matches the script.
- **Failed only** — the lines whose last request failed. Finished clips are not touched.
- **Everything** — every line in the selected chapters.

**Current audio stays playable until its replacement succeeds.** A line that already has a clip renders its replacement _beside_ it, in the `candidate` slot retakes use, so the clip in the book keeps playing, timing the chapter and going into the export. Unlike a retake, a bulk replacement is accepted by the run that asked for it, so 300 lines do not become 300 verdicts, and the displaced clip joins that line's take list. A replacement that fails leaves the book's clip as it was and stays visible as a failed take, which **Retry failed** picks up.

**A retake waiting for a verdict is not spare capacity.** A bulk run leaves those lines alone and says how many; the switch beside the scope tells it otherwise. Nothing is silently deleted either way: told to go ahead, the run puts the waiting retake in the line's take list marked _not kept_, as rejecting it by hand would, and renders the line again. The switch counts only lines this scope would have rendered, and stays on screen in both positions, because the question is about the lines.

**Running and recovering.** Every chapter of one press shares a run id (`Job.bulk.id`), so the Queue shows `3/8` on the row and the job's details show the operation, _chapter 3 of 4_, the scope and the run's own done / failed / to-go counts, with the two actions that make sense for a run rather than a row ([src/views/queue/JobDetails.vue](../src/views/queue/JobDetails.vue)). **Cancel the rest** keeps every chapter the run finished and starts none it had not; it cannot be undone, so it asks first, naming what stops and what is kept. **Retry N failed** re-runs only the failures, as one run again, at the narrowest scope that covers them: _Failed only_ where requests failed, _Missing & changed_ where a run was stopped before it sent them. A failed replacement fails the run even though the chapter still reads as narrated, and a failed re-script leaves the chapter reading as scripted, so **Retry failed** and **Retry all failed** find failures on the work itself rather than on the chapter's label. The activity log carries the operation, the scope, what was skipped and why, what each replacement displaced, and — for a run that produced nothing — that the previous script is unchanged.

In the demo, the **Re-doing finished chapters** group has **A book with everything a bulk run has to tell apart** (new, finished, hand-corrected, stale and failed chapters side by side, with a retake waiting on one line) and **Replacements that failed, and a run that was cancelled** (a four-chapter re-script where two chapters kept nothing and a cancelled one stopped the rest, plus failed narration replacements, with every earlier script and clip still usable). A situation or reset drops bulk work in flight, so no half-finished replacement lands in the state you are looking at ([demo tools](demo.md#demo-tools)).

`scripting.ts` and `narration.ts` queue their runs on the server, whose jobs ([server/jobs/scripting.ts](../server/jobs/scripting.ts), [server/jobs/narration.ts](../server/jobs/narration.ts)) enforce the keep-until-replaced rules; `jobs.ts` owns cancelling a run and retrying its failures. [tests/bulkRuns.test.ts](../tests/bulkRuns.test.ts) covers the selection summary and skip reasons, each scope's lines and estimate, pending retakes, cancelling and retrying a run; what a run does to a chapter is tested under [tests/server/](../tests/server/).
