# Backend

[Back to README](../README.md) · [Development](development.md) · [Seeded demo](demo.md)

The server in [server/](../server/) is where the app stops pretending. It reads real EPUB files and
stores real books. **The first slice is the library: import, the contents review, and removal. The
second is the queue: scripting a chapter is a job the server runs, and the Queue page shows it. The
third is what a scripted chapter owns: its script can be edited over HTTP, its history and the
book's cast are written by the run that made them, and the frontend reads all of it through
queries. The fourth is narration: rendering a chapter is a job the server runs against a fake
speech model, the clips are files the server keeps and serves, the player hears them, and a
retake is judged and kept or discarded. The fifth is export: building an audiobook is a job too,
and what it writes is a file on disk that can be downloaded and played.** The endpoints are
saved on the server too, and narration reads its expression tags, its sample rate and its
per-request limit from them;
pricing is still the seeded demo's and is untouched by all of it.

Nothing in the server contacts a provider or spends money. The only scripting model it can be
started with is the fake one ([the queue](#the-queue) says what it does), there are no credentials
in its configuration, and there is no code path from an import to a paid request.

## Run it

```sh
pnpm dev:server   # the API on :8787
pnpm dev          # the frontend on :5173, proxying /api to it
```

Both are needed only for backend mode. `pnpm dev` on its own is the seeded demo, which is still the
default and still needs no server. Settings and their defaults are in
[.env.example](../.env.example); every one has a working default, so no `.env` is also fine.

| Command            | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `pnpm dev:server`  | Start the API, applying migrations first            |
| `pnpm db:generate` | Generate SQL in `drizzle/` after editing the schema |
| `pnpm db:migrate`  | Apply migrations without starting the server        |
| `pnpm db:studio`   | Browse the database with Drizzle Studio             |

## Demo or backend, chosen once

`VITE_MODE` selects which of the two the frontend runs, and
[src/services/mode.ts](../src/services/mode.ts) reads it once at startup. Demo is the default and
stays the default: it is the mode with no backend, no credentials and no paid requests, which is
what makes it the safe thing to land on.

**Neither mode ever silently becomes the other.** A backend that is down is an error the person
sees, not a quiet slide into seeded books that look real. `libraryService()` throws in demo mode
rather than handing back something that would pass for a backend, and the HTTP client reports a
server it cannot reach as exactly that, rather than as an empty library. The rules this enforces
are in [future backend integration requirements](demo.md#future-backend-integration-requirements).

## The schema

The tables cover the whole domain, not just the slice the routes use. They are grouped by the part
of the app that owns them, mirroring [store ownership](../src/stores/README.md), so "who writes
this" has the same answer on both sides of the wire.

| Area      | Tables                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| Library   | `books`, `volumes`, `chapters`, `chapter_texts`                                       |
| Cast      | `characters`, `lexicon_entries`                                                       |
| Script    | `segments`, `clips`, `script_versions`, `script_heads`, `previous_scripts`            |
| Endpoints | `endpoints`, `voices`, `rate_windows`, `promotions`, `expression_tags`, `credentials` |
| Queue     | `jobs`, `job_events`                                                                  |
| Export    | `exports`, `export_files`, `export_chapters`                                          |
| Usage     | `requests`, `opening_spend`                                                           |
| App       | `settings`                                                                            |

### What is a column and what is a document

**A column for anything read, filtered, summed or joined. JSON only for what is written once and
read whole.**

A receipt is the clearest case of the second. `PricedRequest` and `SpeechCharge` are frozen the
moment a request settles — the usage as normalized, the rates in force at that instant, and the
reasoning that produced them — and the rule that matters about them is that nothing recalculates
one. Shredding a receipt into rows would invite exactly the update that rule forbids, so they are
stored whole, with the figures a total or a chart reads (`cost`, `cost_basis`, the token and
character counts) as columns beside them. No aggregate parses JSON, and no query is tempted to
re-derive a past cost from the endpoint's current card.

A rate card is the opposite case. A window has days and minutes past midnight; a promotion has a
start, an end and a scope. Both are read against an instant on every single request — _what was the
rate at 02:14 on Friday_ — so they are rows, and an expired promotion stays one rather than being
deleted, because the receipts it priced have to remain explicable.

### One clip table, three roles

`SegmentAudio`, the retake waiting for a verdict and every superseded `Take` are the same shape
wearing three hats, so `clips` holds all three with a `role`. Accepting a retake becomes an update
to two rows rather than a restructure, and the store's rule that a line may never be left with
neither its clip nor its retake becomes a constraint the database enforces: a partial unique index
allows at most one `current` and one `candidate` per line, and leaves `take` unconstrained because
takes are a list.

### Absent is not null

The domain marks things by leaving them out, and three fields in this schema exist only to record
that difference — each one found by a round-trip test rather than by reading the types:

- **`endpoints.timezone` is nullable**, and null means no rate card has ever been configured. An
  endpoint that came back with an empty card instead of no card would skip the defaults the app
  fills in on first use.
- **`export_chapters.duration` is nullable**, and null means the timeline was never recorded. Zero
  would be indistinguishable from a chapter of silence, and would hand the player a timeline
  claiming the audiobook is empty.
- **The operational settings arrive as a block or not at all.** `spend_limit: null` means "no
  endpoint-level limit" and `credential_id: null` means "this endpoint's own key slot" — those are
  settings, not absences, so the block's presence is keyed on `timeout_sec` and all six fields come
  back together.

### Everything a chapter owns follows its number

A chapter is addressed by its **number** within the book, continuous across volumes, and that
number moves when a volume is removed. Every child of `chapters` — the text, the script, the clips
through the script, the history, an export's chapter list, a queued job — keys on
`(book_id, chapter_id)` through a composite foreign key declared `ON UPDATE CASCADE`. Renumbering
therefore writes `chapters` and nothing else, and the rest follows in the same statement. Moving
them by hand would be a second definition of the same relationship, and the one that fell behind
would do so silently.

A **job** is in that list because it is live state: it follows the chapter through a renumbering and
ends with the chapter when the chapter goes. A queued narration of chapter 2 that quietly became
chapter 1 underneath it is not a display problem, and a job for a chapter that no longer exists is
one the Queue can neither open nor retry. `jobs.chapter_id` is nullable for a whole-book job such as
a build, and a foreign key with a null in it is satisfied by definition — which is exactly what that
needs.

Three things a removal changes do not follow a key, and `deleteVolume` does them in the same
transaction. A live job's **duplicate key** (`active_key`, `kind:book:chapter`) is a string built
from the number, so `rekeyActive` writes it again from the number the job now has — parking every
key on the job's id first, because the index is unique and chapter 10's new key is chapter 7's old
one. Left alone, a job queued for chapter 7 that became chapter 4 was not seen as a duplicate of a
request for chapter 4, which was then rendered and paid for twice, while the new chapter 7 read as
busy. An **audiobook** keeps the chapters it still has, as the demo's does, and one left with none
goes with its files. And the **clips** the removed chapters rendered are handed back and removed
from disk after the rows. Before any of it, work queued or running on the chapters that go is
cancelled through the runner, so a provider stops being paid for them; and a removal is refused
while an audiobook of the book is being built, because a build reads clips and records where each
chapter landed by number.

**A reorder is the same renumbering without the removal.** `PUT /api/books/:id/volumes/order`
writes each volume's `position` and runs the same `renumber` and `rekeyActive`, so every chapter
keeps its place within its volume and everything it owns follows its new number. Nothing is
cancelled — a running job finds its chapter by uid at every write — and nothing leaves the disk.
It is refused mid-build for the removal's reason, and while a volume is still in review, since a
new volume is added at the end and has no place in an order until it is confirmed.

### The number is an address; the ledger needs an identity

`chapters.uid` is assigned once at import and never rewritten. It exists for the one table that must
not move: the **usage ledger is append-only**, and a row that said "chapter 2" and now says "chapter
1" is not a record of the past, it is a quiet edit of one. Storing the number in `requests` would
leave two ways to be wrong and no way to be right — rewrite it and an append-only record has been
edited, leave it and the row attributes money to a different chapter.

So `requests.chapter_uid` references the chapter itself, `ON DELETE SET NULL` and never cascade: the
chapter is gone, what was spent on it is not, and it stays in every total. The number a row displays
is looked up when it is read. `label` is frozen when the request settles and is what still names the
work after the chapter it was for has been removed.

### What is deliberately not stored

- **Endpoint telemetry.** `history`, `failures`, `rateLimits`, `backoffUntil` and `lastError` are
  what a session has observed, not what anyone configured. Writing a backoff deadline to disk would
  let a restart resurrect a cooldown for a rate limit that expired days ago, and the durable record
  of what an endpoint has done is the `requests` ledger.
- **Secrets.** `credentials` is a registry of names — which account a key belongs to — and no key
  is in this schema. Where secrets live is a decision this slice does not make.
- **Reader and UI preferences.** Typography, the rail, the current book: per-browser, and they stay
  in `localStorage`.

### Does it hold the domain?

[tests/server/schema.test.ts](../tests/server/schema.test.ts) writes the **seeded world** through
the schema and reads it back, asserting equality. That world is the reference answer because it is
the data every screen is built against: four books with volumes and import notices, their casts and
pronunciation dictionaries, six thousand script lines with rendered clips and frozen speech
receipts, retakes awaiting a verdict, endpoints with off-peak schedules and running promotions, and
finished, replaced and failed exports.

It is a round-trip assertion rather than a field list on purpose. A mapper that turns an absent
`note` into a null one, or hands back a take carrying a `status` it never had, fails there rather
than in a screen six months from now — which is how all three of the nullable columns above were
found.

## The shape of it

| Location                                                  | Responsibility                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [server/index.ts](../server/index.ts)                     | Boot: open the database, migrate, recover the queue, listen                                              |
| [server/app.ts](../server/app.ts)                         | The API as a value, built around a database and a queue so tests can drive it                            |
| [server/env.ts](../server/env.ts)                         | Configuration, validated once at startup                                                                 |
| [server/routes/](../server/routes/)                       | HTTP: a request turned into one operation, and its result turned into JSON                               |
| [server/library/ops.ts](../server/library/ops.ts)         | What the library does: import, review, confirm, discard, remove — the rules                              |
| [server/cast/ops.ts](../server/cast/ops.ts)               | What a cast does: a speaker written, renamed, merged, removed, and put back                              |
| [server/script/ops.ts](../server/script/ops.ts)           | What a person does to a script: edit against a revision, checkpoint, forget                              |
| [server/exports/ops.ts](../server/exports/ops.ts)         | The finished audiobooks: listed, handed over to be downloaded, and forgotten                             |
| [server/lib/errors.ts](../server/lib/errors.ts)           | What a refusal is before it is a response; `app.onError` makes it one                                    |
| [server/lib/schemas.ts](../server/lib/schemas.ts)         | The domain shapes as request bodies: a speaker, an entry, a line, an origin                              |
| [server/db/library.ts](../server/db/library.ts)           | Every read and write the library makes, and the chapter counts a shelf reads                             |
| [server/db/script.ts](../server/db/script.ts)             | Every read and write a chapter's script makes, the revision that guards it, and the lines a rename moves |
| [server/db/history.ts](../server/db/history.ts)           | Every read and write a chapter's history makes; the capture rule applied to rows                         |
| [server/db/cast.ts](../server/db/cast.ts)                 | Every read and write a cast and its dictionary make                                                      |
| [server/db/exports.ts](../server/db/exports.ts)           | Every read and write the finished audiobooks make                                                        |
| [server/db/jobs.ts](../server/db/jobs.ts)                 | Every read and write the queue makes                                                                     |
| [server/db/schema/](../server/db/schema/)                 | The tables, grouped by the part of the app that owns them                                                |
| [server/db/rows/](../server/db/rows/)                     | The only files that know what the columns are called                                                     |
| [server/jobs/runner.ts](../server/jobs/runner.ts)         | The worker: claim, run, cancel, recover                                                                  |
| [server/jobs/scripting.ts](../server/jobs/scripting.ts)   | The scripting job, and queueing one per chapter as a run                                                 |
| [server/jobs/narration.ts](../server/jobs/narration.ts)   | The narration job: a clip per line, in the slot the store's rule says                                    |
| [server/jobs/export.ts](../server/jobs/export.ts)         | The build job: the plan laid down as files, and what an update carries over                              |
| [server/audio/files.ts](../server/audio/files.ts)         | Where a rendered clip lives, and how its url finds it again                                              |
| [server/exports/files.ts](../server/exports/files.ts)     | Where a built audiobook lives, and how a download finds it again                                         |
| [server/providers/](../server/providers/)                 | The ports a scripting model, a speech model and an encoder are reached through, and what is behind them  |
| [server/epub/parse.ts](../server/epub/parse.ts)           | Reading an actual EPUB                                                                                   |
| [server/epub/text.ts](../server/epub/text.ts)             | One section's markup to the prose a narrator would read                                                  |
| [server/epub/notices.ts](../server/epub/notices.ts)       | Deciding which chapters are not story                                                                    |
| [server/import/assemble.ts](../server/import/assemble.ts) | Parsed chapters to a book, numbered and marked `importing`                                               |

Three layers, each ignorant of the one above it. A route validates the request, calls one
operation in `server/*/ops.ts` or the enqueue half of a job in `server/jobs/`, and returns what it got: no route
builds a query, no route holds a rule. An operation states a rule — a volume goes onto a book with
nothing waiting in its review, removing the last volume removes the book, a rename moves every
line that names the speaker — and throws an `AppError` when it does not hold, without knowing what
a status code is; a job or a test calls the same operation and gets the same refusal.
`server/db/*.ts` is the only place a query is written. The routes of one book are split by the
part of the app that owns the table — [books.ts](../server/routes/books.ts),
[cast.ts](../server/routes/cast.ts), [script.ts](../server/routes/script.ts),
[exports.ts](../server/routes/exports.ts) — and all mount under `/api/books`.
Above `rows/` everything works in the shapes [`@/types`](../src/types) defines — the same domain
model the frontend uses — so the contents review does not know or care whether the demo or the
server produced what it is showing.

Chapter text is a table of its own. The review lists a few hundred chapters at a time and needs none
of their prose, so keeping it out of `chapters` means that listing stays a cheap read however long
the book is.

## Importing an EPUB

Import → review contents → add, the same three steps the demo walks. A book arrives marked
`importing`: the library does not list it, nothing runs on it, and the review works on it in place —
the same review the book keeps afterwards. Confirming clears the mark.

**Nothing is skipped by the import itself.** Chapters that do not look like story get a note
attached; a person decides. That division is the whole safety argument for guessing at all, because
it makes a wrong guess cost a click instead of a missing chapter.

Things the parse is deliberate about:

- **The conversion is Turndown's, not ours.** "Turn arbitrary publisher HTML into readable text" is
  a long tail — nested lists, `<br>` inside a paragraph, entities, whitespace that matters in one
  element and not the next — and a converter with eight million weekly downloads has met more of it
  than this project ever will. [markdown.ts](../server/epub/markdown.ts) configures it;
  [text.ts](../server/epub/text.ts) keeps only the part no converter can do, which is cutting a file
  into chapters before anything converts it.
- **HTML's named entities are made ones XML knows.** A chapter file is XHTML, parsed as XML, and
  XML knows five names; `&nbsp;`, `&mdash;` and `&hellip;` are the DTD's, which no parser here
  reads, so they arrived as the text `&nbsp;` for the narrator to spell out. EPUB 2 and Calibre
  books use them everywhere. Before a section is parsed, [entities.ts](../server/epub/entities.ts)
  replaces each HTML name with the numeric reference for the same character — what a parser that
  read the DTD would have made of it — using the `entities` package's table. A name that is not
  HTML's is left alone.
- **The navigation is waited for.** `open()` resolves as soon as the package document is parsed;
  the navigation document is a second file still being fetched. Read too early it is simply absent,
  every chapter quietly falls back to its own heading, and the result usually looks close enough to
  be believed. It is awaited on its own rather than through `book.ready`, which also covers the
  cover image and the resource list — a book with no cover has a perfectly good table of contents,
  and losing it to an unrelated failure would be the same silent fallback by another route.
- **Navigation links are resolved against the navigation document.** A spine item's `href` is
  written against the package document and a navigation entry's against the navigation document,
  which may sit in a directory of its own. `../text/c1.xhtml` and `text/c1.xhtml` are then the same
  file spelled two ways, and comparing them as written loses every label in the book. Both halves
  are also **percent-decoded**, a path segment and the fragment each on its own: an href is a URL,
  so `Chapter%201.xhtml` is `Chapter 1.xhtml`, but the manifest and the navigation are often written
  by different tools and only one of them remembered. Compared as written, a chapter lost its label
  and one anchored inside that file ran on into the one before.
- **Sections are unloaded as they are read.** A web-novel volume can be a thousand chapters, and
  holding every parsed document at once is how a routine import becomes an out-of-memory crash.
- **The navigation document, non-linear spine items and links out of the book are not chapters.**
  A cover plate and a colophon would otherwise arrive in the review as something to decide about.
  A spine item with a scheme (`https:`), a protocol-relative `//host/…`, or a `..` that climbs above
  the root of the zip names something beside the EPUB rather than in it; it used to arrive as a
  chapter that "could not be read". A file inside the zip that is merely missing is still one.
- **Tables are kept, not dropped.** A `<table>` in a novel is as often prose as it is data — a
  character list, a release timetable, or a paragraph an old conversion laid out in cells — and
  dropping the element takes everything inside it with it. They are stored as GFM tables and read
  out a row at a time. `aside` and `nav` are still dropped, because they hold a sidebar the
  narrator is not reading or are the table of contents itself — judgements about the narration
  rather than accidents of how the page was built.
- **A figure is kept; a picture is not.** Publishers set epigraphs, poems and letters in
  `<figure>` as often as pictures, and removing the element removed the verse. Images are dropped
  (by a rule: Turndown's own image rule runs before its remove list, and wrote `![](a.png)` into
  the stored text), and so is the `<figcaption>` of a figure that holds a picture; the caption of
  one that holds words is usually who wrote them, and is kept.
- **The cover is kept, as a file.** The package names its cover the EPUB 3 way (the manifest item
  marked `cover-image`) or the EPUB 2 way (`<meta name="cover">`), and the parser reads those bytes
  from the archive once the chapters are done. A new book keeps them when they are a JPEG or a PNG
  of at most 10 MB, sniffed from the bytes rather than taken from the manifest's media type, in
  `<AUDIO_DIR>/<bookId>/covers/` under a hash of its contents; the book answers with
  `coverImage`, the address it is served from. Anything else — a GIF, an SVG, a cover the manifest
  promises and the zip lacks — leaves the book without one, and the log says why. A volume added
  later does not bring its cover: that is another edition's as often as the same one, and swapping
  the shelf's picture unasked would be a surprise.

### One file, several chapters

Most web-novel EPUBs pack several chapters into one XHTML file, with the table of contents pointing
at an anchor inside it. One chapter per spine document is not a cosmetic loss: a release notice
bundled between two chapters cannot be skipped without taking the story either side of it with it.

So a section is cut where the navigation says a chapter begins, and **only at the shallowest level
that reaches that document**. A serial listing twenty chapters of one file side by side has them all
at the top level and each is a chapter; a novel listing scenes underneath a chapter has the chapter
above them, and the scenes are not chapters. Reading the deepest level instead would turn the second
book into a hundred one-page chapters, and there is no way back from that once the audiobook is
built.

A **container** is not one of those levels. An entry that names a whole document and has the
navigation pointing at places _inside that same document_ beneath it — "Volume One", linked to the
file, with Chapters One and Two anchored under it — is the heading over those chapters rather than
one of them. Taken as the boundary it is the shallowest entry reaching the file, and both chapters
import as one. Its own children are the boundaries instead.

Three cases the cutting has to be right about:

- **An anchor named by `name` rather than `id`** — `<a name="ch3" id="calibre_link-7">`, as a
  converter leaves an older book — is found by either attribute, not by whichever comes first.
- **An anchor the file does not contain** produces no chapter. Its text stays with the chapter
  before it — not lost, which is the safe direction to be wrong in.
- **Text above the first anchor** that no entry claims is the file's own front matter, a series
  title above the first chapter. It reads as the opening of the chapter that follows it, rather than
  becoming a chapter nobody named.
- **A cut through an inline element** reopens it. A chapter that begins halfway through an `<em>`
  keeps the emphasis on both halves; the wrapper is closed in the part the cut ends and opened again
  in the part it starts. A block wrapper is not reopened — splitting a paragraph is meant to end it.

### A chapter the file could not supply

One section that will not render is not a reason to lose the other nine hundred, so it arrives as a
chapter carrying a note of kind `unreadable`, verdict `review` — **one for each chapter the
navigation says was in that file**, not one for the file. A damaged file holding three chapters is
three chapters to answer for, and reporting it as one leaves the other two missing from a review
that never mentions them. It is the one case where the review
has to speak up rather than guess: narrating it would produce silence, and skipping it by default
would quietly drop a chapter nobody has looked at. An empty chapter and a lost one look identical
once the text is gone, which is why the difference is recorded rather than inferred.

If **every** section fails, the import is refused. The file is an EPUB and its package parsed, so it
opened — but there is no book in it, and importing one chapter of nothing per file would put an
empty shelf entry in the library and call it a success.

### What an upload unzips to

The upload limit is on the zip, and a zip can be a thousand times smaller than what it holds: an
80 KB file with one 80 MB chapter took a gigabyte and a half and seventeen seconds to import, with
nothing else served meanwhile. So [archive.ts](../server/epub/archive.ts) reads the archive with
yauzl before the EPUB library sees it, and refuses — a 413, `too_large` — one that unzips to more
than `MAX_UNZIPPED_MB` in all or holds a document (a chapter file, the package, the navigation) over
`MAX_DOCUMENT_MB`. Pictures are held only to the total: they are carried, not parsed.

**The sizes are trusted because they are checked.** A zip states each entry's size, and it can lie;
the EPUB library unzips with jszip, which believes it. yauzl fails an entry the moment its data runs
past what it declared, so every entry is inflated once, into nothing, a chunk at a time — and an
archive that gets through is exactly as big as it said. One that lied is refused as unreadable.
Neither refusal is handed to EPUBCheck for a diagnosis, which would unzip the whole thing again.
An entry that merely will not inflate is let through, to become the unreadable chapter below.

Either way the refusal says _why_. The parser can only report what stopped it; EPUBCheck, through
[diagnose.ts](../server/epub/diagnose.ts), reports what is wrong with the file — `RSC-001:
Referenced resource "c2.xhtml" could not be found (OEBPS/content.opf line 12)` — and that is the
half somebody holding a broken book can act on. It lands in the `detail` the UI already expands to.

It runs **only on a failure, never as a gate**. Its own measured agreement with the reference
implementation is 95.9%, and plenty of real books are technically non-conformant and read perfectly
well — this project's own test fixtures among them, which is how that was settled rather than
assumed. Refusing a book because a validator disliked its metadata would turn a working import into
a support question; explaining a failure it already had costs a person nothing. Cost is 3–50ms for a
small book and about 200ms for a 500KB one, on an error path.

### The stored form is Markdown

`chapter_texts.body` holds the chapter as Markdown: `# heading`, `*italic*`, `**bold**`,
`***both***`, `- item`, `[text](href)` and GFM tables. It is kept at all because import is the last
moment it exists — the EPUB is not retained, so anything dropped here is gone for good.

Markdown in the string rather than structure beside it, because **the string is going to move**.
Lines are edited, split and joined all through scripting, and a character range recorded against the
text points at the wrong words after the first edit — silently, with no way to tell that it has.
Markup survives anything that moves the string.

Italic and bold stay apart because the file kept them apart. A narrator may well end up treating
them alike, but that is a decision narration can make later from the distinction, and never one it
can make back if import threw it away. Stress a publisher wrote as styling rather than as an element
counts too: `<span style="font-style: italic">` is how a good share of real EPUBs mark a word, and
Turndown's own rules match only `<em>`, `<i>`, `<strong>` and `<b>`. A span inside the emphasis it
repeats is not marked twice — `*` inside `*` is `**`, which is the other grade entirely.

A table the file gave no header converts with an empty header row above it. It stays in the stored
Markdown, where it is the table's shape, and is left out of both readings: neither the preview nor a
narrator opens the table on a blank row.

There are two readers, and they want different things. The contents review wants the Markdown, so a
chapter that was laid out as a timetable is shown as a timetable. A model or a speech provider wants
it gone: sent the stored form, a model is charged for a link's address and a table's pipes, and a
speech provider reads them aloud. So the chapter-text route serves both and says which it gave:

```
GET /api/books/:id/chapters/:n/text                 → { text, format: "markdown" }
GET /api/books/:id/chapters/:n/text?format=plain    → { text, format: "plain" }
```

Anything unexpected in `format` is a 400 rather than a guess, because guessing here costs money.
Two functions in [markdown.ts](../server/epub/markdown.ts) do the work, and everything downstream
uses one of them rather than a regex of its own:

- `plainText(body)` — the prose, with no Markdown in it at all. **Anything that counts, bills or
  speaks a chapter reads this, never the column.** A provider sent the stored form would narrate a
  heading's `##`, read a link's address out, and charge by the character for both.
- `parseEmphasis(body)` — the prose and where the stress falls, as `{ at, to, mark }` ranges that
  may overlap. Right for a renderer or for a provider's emphasis markup, which read a string they
  are about to use and do not change it. The ranges are offsets into the prose **as returned**: the
  walk pads the text with the blank line it ends every block on, and tidying that away afterwards
  moves the ranges with it rather than leaving them pointing a word to the left.

The scripting job reads `plainText` before it sends a chapter to the provider, and nothing in the
server sends the column anywhere. `?format=plain` is what the frontend's estimate reads for the
same reason.

Both run a real Markdown parser over the stored text rather than stripping punctuation somebody
remembered. A table becomes `Day, Chapter` a row at a time; a horizontal rule becomes a paragraph
break; `\*` comes back the star the book had.

The parser is markdown-it, not the `marked` the frontend draws with. Under Bun, `marked`'s lexer
slows with the length of the document — 4,000 paragraphs took 30 seconds, where Node takes 15 ms —
and a single-file novel is one chapter of that, read twice on import and again by every count,
bill and speak. markdown-it reads 64,000 paragraphs in under 300 ms. The walk over its tokens keeps
the last two characters beside the prose rather than asking the prose, for the same engine's
reason: a string built by `+=` is flattened before its end can be read, once per block.

### Turndown chooses its DOM once, and can choose wrong

Worth knowing before touching [markdown.ts](../server/epub/markdown.ts). Turndown decides its HTML
parser when the module is first evaluated:

```js
var root = typeof window !== "undefined" ? window : {};
var HTMLParser = canParseHTMLNatively() ? root.DOMParser : createHTMLParser();
```

With no `window` it uses the `@mixmark-io/domino` it ships with and is tested against. With a
`window` carrying a `DOMParser` it takes that instead — and this project has both halves of the
trap: the frontend tests install a small `window` stub, and importing `@likecoin/epub-ts/node`
registers linkedom's `DOMParser`. Bound to linkedom, the table plugin stops matching and a table
collapses to `DayChapterMondayCh 1`, which is exactly the damage the extractor exists to prevent.
Silently, and only in some import orders.

So Turndown is loaded through `withoutWindow`, which hides `window` for the one moment that decision
is made — the same shape as the bracket around `@likecoin/epub-ts`. It is a named, exported function
rather than inline code because the load is cached and happens once per process: a bracket nobody
can re-enter is a bracket nobody can test.

Turndown is also given HTML **strings**, never the linkedom nodes the splitter already has. Handing
it a foreign node skips its parser and loses tables the same way.

Numbering is continuous across a book's volumes rather than restarting, because script keys, job
records and export entries are all keyed by a chapter number that has to stay unique within the
book. Removing a volume renumbers what is left, and the chapter text moves with it.

### Which chapters are notices

A web-novel EPUB carries the author's announcements inline with the fiction: hiatus notices, release
schedules, vote reminders, afterwords. They are chapters as far as the file is concerned, and
narrating them produces an audiobook that stops mid-arc to ask the listener to vote on a website.

The prototype never did this part. [src/mock/fixtures/notices.ts](../src/mock/fixtures/notices.ts)
supplies the words for a note whose kind the sample already declared;
[server/epub/notices.ts](../server/epub/notices.ts) is the part that reads a chapter and decides. It
weighs length, dialogue, links, whether the text addresses the reader, and keywords for each kind,
and the `evidence` it attaches is what it actually saw rather than what the rule is called.

Its word count is the same one the import puts on the chapter. A second count that split on
whitespace read a chapter of Chinese prose — which has no spaces — as a single word, putting it
under every short-notice threshold there is with a "skip" suggestion attached.

Three of its verdicts are `review` rather than `skip`, and all three are about not losing a chapter:

- **A full chapter with a note stuck to one end** is story _plus_ an author's note, so the note is
  marked at `start` or `end` and the chapter stays in.
- **A chapter only titled like a notice** — "Author's Note" over two thousand words of dialogue — is
  sent for a look. Skipping that automatically would drop a real chapter, which is the one mistake
  that must not happen without a person.

- **A chapter the file could not supply** is `unreadable`, described above. Not a notice at all,
  but it reaches the reader through the same review, and a channel of its own would mean a second
  place to look before trusting a book's contents.

A notice repeated later in the book is marked `duplicate` and names the chapter it repeats.

## Logging

`pino`, through [server/log/](../server/log/). A person at a terminal gets columns; anything else —
a file, a pipe, a log shipper — gets JSON, decided by whether stdout is a terminal and overridable
with `LOG_FORMAT`. `LOG_LEVEL` sets how much. Colour follows the usual conventions: `NO_COLOR` off,
`FORCE_COLOR` on for a CI that renders ANSI without being a terminal.

```
18:03:27.360  WARN  GET /api/books/nope → 404          reqId=1 responseTime=3
18:03:27.436  WARN  import · refused the file          file=package.json bytes=1823 reason=… epubcheck=…
18:03:27.437  WARN  POST /api/books/import → 415       file=package.json reqId=2 responseTime=66
```

**The redaction list is why this is a module and not a bare `pino()` call.** The server will hold
provider credentials, and a key that reaches a log line is in a file, a scrollback and possibly a
log shipper. `redact` covers the shapes one actually arrives in — on its own, inside an endpoint or
a credential that was spread into the record, in request headers — so it cannot leak through a
`log.info({ ...endpoint })` somebody wrote in a hurry. That is a guarantee; "remember not to log the
endpoint object" is a hope.

Three decisions worth knowing:

- **The formatter is ours** ([pretty.ts](../server/log/pretty.ts)), not `pino-pretty`. The look is
  the entire point of that file, and formatting our own records for our own terminal is not the kind
  of long tail a dependency saves you from the way parsing arbitrary HTML is. It also keeps the
  logger one in-process stream with no worker thread behind it — which is the arrangement that
  survives `bun build --compile`, where pino's worker transport cannot resolve its target.
- **A 4xx is a warning, not an error.** `hono-pino` calls anything with an error on the context an
  `error`, which makes "no such book" and "the database is gone" the same severity. A log where
  routine answers are red is one nobody can skim for the real thing.
- **Request headers are not written down.** The default puts every header on every line, which
  buries the field anybody was reading and drops an `authorization` into the log for the redaction
  list to have to catch. Method and path, and what came back.

A route logs through `c.var.logger`, which already carries the request. `assign` adds context that
the request's own closing line picks up too, so the summary and anything written during it agree
about which file they were talking about.

Tests use a collecting logger from [tests/support/server.ts](../tests/support/server.ts): lines are
kept rather than printed, so the suite's output stays readable and a test can assert on what was
written — and on what was not, which is how the redaction rule is checked.

## Endpoints

`/api` on the same origin, so there is no CORS to configure and no base URL to set. Errors all have
one shape — `{ error: { code, message, detail? } }` — where `code` is a stable name a client can
switch on (`not_found`, `conflict`, `bad_request`, `forbidden`, `too_large`, `unsupported_media`,
`range_not_satisfiable`, `internal`),
`message` is meant to be shown as it stands and `detail` is the longer explanation a panel can
expand to. `ApiErrorCode` in [src/types/common.ts](../src/types/common.ts) is the one list, and
the server imports it, so the two sides agree by construction rather than by luck.

**All** of them, including the ones the validator raises. `sValidator` answers a bad request with
its own `{ success, error, data }` unless it is told not to, which is a second error contract nobody
agreed to: a client reading `error.message` finds nothing in it and can only say "Request failed
(400)" — a worse message than the server already had, with the part naming the field thrown away.
[validate.ts](../server/lib/validate.ts) is the same middleware with that hole closed, and routes
use it in place of `sValidator` so the contract cannot be opted out of by forgetting a hook. Path
parameters go through it too: a chapter number or a job id that is not a whole number is a 400
naming the parameter, rather than `Number("latest")` looking up nothing and answering 404 for a
request that was never well formed.

So are Hono's own refusals: a body that is not the JSON it claims is a `bad_request` in that shape,
not the plain text Hono writes by default.

**Nobody else gets to ask.** The API has no accounts, and a request that deletes a book deletes a
book. It listens on loopback (`HOST`, `127.0.0.1` by default), so another machine cannot reach it.
Another _site_ can still make your browser send it a request — a form post, or a post with no body,
needs no preflight — so Hono's `csrf` check refuses any such request unless the browser says it came
from this origin (`Sec-Fetch-Site`, or `Origin` from a browser too old to send that), with a
`forbidden`. A request with neither header is not from a browser, and is let through: a script on
this machine forges nothing. `secureHeaders` adds the usual set to every response.

**An upload is refused before it is read.** The import route's `bodyLimit` answers a body over
`MAX_UPLOAD_MB` from its `content-length` — or by counting, when it has none — with the `too_large`
above. Bun's own ceiling sits a megabyte higher, as a backstop, so it is never the one that answers.

The client holds up the other end. Not everything that answers `/api` is the API — a proxy, a dev
server or a gateway in front of it answers with HTML — so [`HttpClient`](../src/services/http.ts)
does not assume the body parses. Letting `JSON.parse` throw would raise a `SyntaxError` out of a
method whose whole contract is that it raises `ApiError`, and the page would report a JavaScript
fault where it should be saying the server is unreachable. The library service and the jobs
service are both built on it, so that rule is written once.

| Method   | Path                                             | Does                                                          |
| -------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `GET`    | `/api/health`                                    | Is it up                                                      |
| `GET`    | `/api/books`                                     | Every book, importing ones included, with chapter counts      |
| `GET`    | `/api/books/:id`                                 | A book and its chapters                                       |
| `GET`    | `/api/books/:id/chapters/:n/text`                | A chapter's prose                                             |
| `GET`    | `/api/books/:id/chapters/:n/script`              | A chapter's script, and its revision                          |
| `PUT`    | `/api/books/:id/chapters/:n/script`              | Replace the script, naming the revision that was read         |
| `GET`    | `/api/books/:id/chapters/:n/history`             | The chapter's versions and how the script came to be          |
| `POST`   | `/api/books/:id/chapters/:n/history/checkpoints` | Name the script as it stands and keep a copy (201)            |
| `DELETE` | `/api/books/:id/chapters/:n/history/versions/:v` | Forget one version; what an Undo of a checkpoint sends        |
| `GET`    | `/api/books/:id/cast`                            | The cast and the pronunciation dictionary                     |
| `PUT`    | `/api/books/:id/characters/:name`                | One speaker, written as stated: new or replaced               |
| `POST`   | `/api/books/:id/characters/:name/rename`         | Rename; every line that names them moves                      |
| `POST`   | `/api/books/:id/characters/:name/merge`          | Fold one speaker into another                                 |
| `DELETE` | `/api/books/:id/characters/:name`                | Remove a speaker; their lines go to the Narrator              |
| `POST`   | `/api/books/:id/characters/attribute`            | Put a speaker back on exactly these lines; an Undo            |
| `PUT`    | `/api/books/:id/lexicon`                         | The dictionary, replaced whole, and the clips it made stale   |
| `GET`    | `/api/books/:id/exports`                         | The finished audiobooks                                       |
| `POST`   | `/api/books/:id/exports`                         | Queue a build; the job and the version it makes (202)         |
| `GET`    | `/api/books/:id/exports/:e`                      | One of them                                                   |
| `GET`    | `/api/books/:id/exports/:e/files/:n`             | One of its files, to save                                     |
| `DELETE` | `/api/books/:id/exports/:e`                      | Forget one, and take its files off the disk                   |
| `POST`   | `/api/books/import`                              | An uploaded EPUB → a book, or one more volume of one          |
| `POST`   | `/api/books/:id/covers`                          | A JPEG or PNG for an audiobook's cover → its url              |
| `GET`    | `/api/books/:id/covers/:file`                    | A cover's bytes                                               |
| `POST`   | `/api/books/:id/confirm`                         | The review is done; it joins the library                      |
| `POST`   | `/api/books/:id/discard`                         | Cancel: an unconfirmed book goes, or its new volume           |
| `POST`   | `/api/books/:id/chapters/skip`                   | Skip chapters for the audiobook                               |
| `POST`   | `/api/books/:id/chapters/include`                | Put them back                                                 |
| `POST`   | `/api/books/:id/chapters/keep`                   | Keep a noted chapter and stop the suggestion asking           |
| `POST`   | `/api/books/:id/chapters/decisions`              | Put decisions back exactly as stated; what an Undo sends      |
| `POST`   | `/api/books/:id/chapters/script`                 | Queue a scripting job per chapter, as one run (202)           |
| `POST`   | `/api/books/:id/chapters/narrate`                | Queue a narration job per chapter, at a scope (202)           |
| `GET`    | `/api/audio/:bookId/:file`                       | A rendered clip's audio                                       |
| `GET`    | `/api/endpoints`                                 | Speech endpoints, scripting profiles, credentials; `saved`    |
| `PUT`    | `/api/endpoints`                                 | The whole configuration, in place of what is stored           |
| `DELETE` | `/api/books/:id`                                 | Remove a book and everything it owns                          |
| `DELETE` | `/api/books/:id/volumes/:volumeId`               | Remove a volume; the last one removes the book; 409 mid-build |
| `PATCH`  | `/api/books/:id`                                 | The budget, script budget or pacing; chapters are re-timed    |
| `PATCH`  | `/api/books/:id/volumes/:volumeId`               | Rename a volume                                               |
| `PUT`    | `/api/books/:id/volumes/order`                   | Read the volumes in this order; chapters renumber to follow   |
| `GET`    | `/api/jobs`                                      | Every job, oldest first; `?bookId=` narrows it                |
| `GET`    | `/api/jobs/:id`                                  | One job, with its activity                                    |
| `POST`   | `/api/jobs/:id/cancel`                           | Stop it: a queued job never starts, a running one stops       |
| `DELETE` | `/api/jobs/:id`                                  | Take a finished job out of the history                        |
| `POST`   | `/api/jobs/clear`                                | Clear the history; live jobs stay                             |

`POST /api/books/import` is `multipart/form-data`: `file` is the EPUB, `title` optionally overrides
the one in the file, and `bookId` with `name` adds the file to an existing book as one more volume.

`POST /api/books/:id/covers` is `multipart/form-data` too, with the image as `file`. It is kept
beside the book's own cover under a hash of its bytes — the same image twice is one file and one
url — and answers `201 { cover }`; a file that is not a JPEG or PNG is a 415, over 10 MB a 413. It
does not change the book's `coverImage`: it is what an export's `settings.cover` names, so one
build can carry it and the next the EPUB's. A build refuses any other `settings.cover` with a 400 —
a `data:` URL (what the demo holds, and what a build queued before this slice recorded), another
book's image, a path that is not a cover — since a picture this server could never find would
otherwise be a build failing halfway.

`POST /api/books/:id/chapters/script` answers with the jobs it made, the chapters it left out and
why (`excluded`, `busy`, `missing`), and the book's chapters as they now stand — so the client can
say "2 already being scripted" instead of waiting for work that is not coming. The body can name
the scripting `profile` the page has chosen; see [a chapter in chunks](#a-chapter-in-chunks).

`GET /api/books` carries each book's chapter counts (`chapters: { total, included, scripted,
narrated }`), read in one grouped query rather than one per book. The shelf lists books without
their chapters — a review's worth of rows per book is not a cheap listing — and the counts are
what let a card say "12 chapters, 3 scripted" before the book has been opened. The library store
answers `contentsOf` and `progress` from them until the chapters themselves are here.

## A script edited by a person

`PUT /api/books/:id/chapters/:n/script` takes `{ segments, ifRevision, origin? }`. Two rules hold,
and both are the ones the scripting job already keeps:

- **An edit names the revision it read.** `chapters.script_revision` counts every write of a
  chapter's script, whoever made it. `ifRevision` is the revision the client last saw, and an edit
  against a script that has moved since — a job landed, another tab wrote, a rename moved lines —
  is a 409 and writes nothing, exactly as a job result that would land on newer work is refused.
  The client reads the chapter again and says so; the server's script wins. The rule runs one
  way: an edit made while a job is still queued is not a conflict for the job, because the job
  reads the revision when it starts, not when it was queued — the job's script replaces the edit,
  and the edit is preserved in the history the way any script a run replaces is.
- **History is written in the transaction that writes the script.** The working script is preserved
  before the new one replaces it, so a version and the script it preceded cannot disagree about
  which came first. `origin` says what produced the script — a bulk correction, a restore — and an
  ordinary edit needs none.

The rule behind every entry is one function, `planCapture` in
[src/lib/scriptHistory.ts](../src/lib/scriptHistory.ts), shared by the history store and
[server/db/history.ts](../server/db/history.ts): no entry for an empty script, none for an
operation that leaves the script exactly as it found it, none for a script that is already the
newest entry, and an edit opens a session that later edits join. The store closes a session with a
timer; the server has no timer and asks the clock instead (`sessionOpen`): a session is open while
its last edit is less than `SESSION_IDLE_MS` old. One rule the server adds: **a session that comes
back to exactly where it began leaves no entry**. An undo over HTTP is an edit that writes the
previous script back, and when that makes the script equal to the version the session's first edit
preserved, the version is dropped again and the head goes back to what that version recorded — the
list must never claim an edit happened that no longer exists. Only that version is the session's
to drop, and the head remembers which one it was (`script_heads.session_version`, set when an
edit's capture adds a version and cleared by anything else): the newest version is not always it,
because a checkpoint saved after the session opened is newer, and a session that comes back to the
checkpoint's script leaves the checkpoint where it is.

A write that changes nothing a version keeps — a line flagged, a clip that finished, anything about
the audio — is written and moves the revision on, but leaves the history alone. `scriptSignature`
is what a version is, and a script with the same signature is the same script, so there is no edit
to count and no session to open or close; the store sends such a write with no origin, even from a
flag batch.

A chapter that now has a script reads as scripted (`chapters.scripting` is asked of the script),
and an edit that would leave it with no lines is refused, because a chapter with nothing in it
cannot be narrated and would have nothing left to undo from. A checkpoint names the script as it
stands without changing it; forgetting the version the head still names puts the head back to how
the script came to be before it was named, which is what an Undo of a checkpoint asks for. A
checkpoint saved over a checkpoint records nothing it was saved over, because the answer is the
earlier checkpoint itself: forgetting it puts the head back to the newest checkpoint still in the
list, or to "scripted" when none is left.

## The cast

A speaker is keyed by name because the script names speakers by name and nothing else, so anything
that changes a name moves lines in every chapter of the book — and does so in the same transaction
as the cast row. A rename, a merge and a removal each answer with the lines that changed hands,
by chapter, and with each chapter's script revision now that they have (`moved`): the client keeps
editing without a stale-revision refusal, and an Undo puts back exactly those lines through
`attribute` rather than guessing at an inverse. A merge folds aliases in and cannot be told apart
from ones that were already there, which is why the undo is recorded rather than inverted — the
same reasoning as the review's `decisions` route. A line that changes hands has its rendered clip
marked stale, as the cast store does. The Narrator cannot be removed, renamed or merged into
anyone (each a 409), because a removal hands the lines to the Narrator by that name; anyone can be
merged into the Narrator, and the Cast page offers the Narrator row neither button. The dictionary
is a short list a person edits one entry at a time, and the order it reads in is part of it, so it
is written whole.

The scripting job absorbs the speakers it turned up into the cast when it writes the script: a
walk-on arrives unreviewed (`isNew`), so the Cast page can merge it; the Narrator, whom every book
has, arrives as the main cast. Nothing writes voices, styles or aliases but a person.

## The queue

A job is a row in `jobs`, the table laid out to hold the frontend's `Job`, so the Queue page reads a
server job exactly as it reads a simulated one. What the server adds is discipline the browser
never needed, and each rule below has a test in
[tests/server/jobs.test.ts](../tests/server/jobs.test.ts) that drives it through the real routes,
the real runner and a scripting model that reads the prose and never the network.

- **The same work is never queued twice, and the database says so.** While a job is queued or
  running, `jobs.active_key` is `kind:book:chapter`; the moment it finishes the key is cleared. A
  unique index over that column means a double click, a retried request or two tabs asking for the
  same chapter get the same job back rather than a second one — whatever order the requests
  arrive in, because it is the index that refuses, not a check a second request could slip past.
  SQLite treats NULLs as distinct, so finished jobs never collide. The route says which chapters it
  left out for being `busy`.
- **One job at a time.** [runner.ts](../server/jobs/runner.ts) claims the oldest queued job,
  moving it to `running` in the same transaction that reads it, and runs its handler to the end
  before claiming the next. The queue's own rule — one book's chapters run sequentially so roster
  and recap carry forward — is a property of the runner rather than something each handler has to
  re-derive. An enqueue wakes it; a slow interval is only a safety net.
- **A cancel is an abort.** A running job has an `AbortController`; cancelling aborts it, the
  handler's provider sees `signal` and stops, and whatever comes back afterwards is recorded as
  `cancelled` rather than as a failure. A queued job is finished as cancelled without ever starting.
  Either way the handler gets the last word (`onSettled`), which is how a chapter marked `queued`
  goes back to `none` — and the same hook runs when a recovery gives up on a job, so there is no
  path that settles a row without it.
- **A handler that returned is done.** A handler honours a cancel by throwing, at the last point it
  can still take its work back — a build checks once more immediately before the transaction that
  makes the new version current. One that arrives after that point is too late: the job is `done`,
  whatever the signal says. Calling it cancelled there had an export's `onSettled` delete the
  version it had just committed and leave the one before it marked `replaced`, so there was no
  current audiobook at all; and a stop in the same window left the row `running`, for the next
  start to rebuild over the finished files.
- **A restart loses no work.** A row still `running` when nothing is running is a job the last
  process died holding. `start` puts it back in the queue with an event saying so, and it starts
  again — twice in all, because a job that takes the process down every time must not be allowed
  to forever; the third time it fails with the reason recorded. `stop` (a `SIGINT` from
  `pnpm dev:server`) aborts the running job and leaves its row `running` on purpose, so there is one
  recovery path rather than two — but it gives back the start it interrupted (`handBack`), so
  `attempts` counts crashes only. A long narration interrupted by any number of clean restarts
  carries on; one the process dies during twice does not.
- **A result never lands on newer work.** `chapters.script_revision` counts how many times a
  chapter's script has been written. The scripting job reads it when it starts and writes only if
  it has not moved, inside one transaction with the write, so a script edited or replaced while a
  slow run was working is kept and the job fails saying why. The chapter is also found again by its
  **uid** at the moment of writing, not by the number the job started with: removing an earlier
  volume renumbers the book mid-run, and the script still lands on the chapter it was read from.
  `GET …/script` returns the revision so that a script-editing route, when there is one, can name
  the version it edited.
- **A chapter's status is asked of its script, not remembered.** `queued` when the job is (written
  in the same transaction as the row, so it cannot land after the worker has moved on), `running`
  with a percentage while it runs, and afterwards whatever the chapter holds: `done` if it has a
  script — including after a re-script that failed, because the old script is intact and a
  chapter with a usable script must not read as failed — `none` if it never had one, and `failed`
  only when a run that was meant to give it one could not.
- **The job log is bounded** the same way the frontend's is: the newest thousand events, with
  `dropped_events` counting what is no longer there.

### A chapter in chunks

A chapter longer than its scripting profile's `maxChars` goes to the provider as several requests,
cut exactly where the Endpoints page's chunk preview cuts it: `scriptParts` in
[src/lib/scripting.ts](../src/lib/scripting.ts), the demo's own call, at the profile's `splitAt`
and falling down to a clause, a word, a hard cut, with the source's whitespace kept so the pieces
rejoin to the chapter. The profile is the one the browser has chosen, named in the request's body
and read from the endpoints saved to the server when the run is **queued** — copied onto each job
as `scriptRun.profile`, so an edit to it afterwards does not re-cut a run already waiting. One the
server was never sent is not a refusal (a fresh server has no endpoints until the page saves them):
the chapter goes whole, and its job's log says why. No profile named, or a limit of 0, is the
chapter whole, as before.

Up to the profile's `concurrency` requests are out at once. `scriptRun` counts them — `requests`,
`completed`, `active` — which is what the Queue's job details and the Scripting page read; the bar
is the chunks' progress together, so it never runs backwards when the next one starts counting
from zero. The answers are stitched in the chapter's order, whichever came back first, and the lines
numbered 1 to n afresh, then written in the one transaction a whole chapter is. A request that
fails stops the others and fails the chapter — `Request 2 of 5 failed: …` — and nothing is
written: half a script is not a script. The history entry names the profile and the provider as
its model. Nothing is priced or held against the budget yet (see
[what is not done yet](#what-is-not-done-yet)).

A cut can fall inside a quotation or between a line and the "said Mara" that names its speaker —
the preview shows where — and the fake then reads each side on its own, so a quoted line can come
back as narration or `Unknown`. That is what the Scripting page's "smaller chunks" button and the
preview are for; a real provider will want the same care.

### The provider, and where a key would live

A scripting job hands a [`ScriptingProvider`](../server/providers/scripting.ts) a chapter's prose —
the `plain` reading, never the stored Markdown — and gets back lines with speakers. That is the
whole contract. What model, what prompt, what key and what it cost are the provider's business.

Only [the fake](../server/providers/fake.ts) exists, and `SCRIPTING_PROVIDER=fake` is the only value
[env.ts](../server/env.ts) accepts, so a server cannot be started in a configuration that spends
money. The fake is deterministic and honest about what it is: a paragraph is narration, a quoted
span is dialogue, and the speaker is whoever the paragraph names beside a speech verb — "…," said
Mara — or `Unknown`. That is enough to give the Scripting page a cast to route, a script to correct
and clips to render, which is what the screens need to be tested against, and it is the "fake AI
provider" the [demo requirements](demo.md#future-backend-integration-requirements) ask for.

A real provider is a value for `SCRIPTING_PROVIDER`, an implementation next to the fake, and a key
read from the server's environment by that implementation. **The key never leaves the process**:
it is not in the schema (`credentials` is a registry of names), not in a response, and the
[logger's redaction list](#logging) catches it if it is ever spread into a log record. The browser's
keyring is the demo's; nothing in backend mode sends a key anywhere.

### Narration

A narration job is the same kind of thing as a scripting job — a row in `jobs`, claimed by the
same runner, cancelled by the same abort, recovered by the same restart rule — and what it renders
is decided by the same rules the demo decides it by. `POST /api/books/:id/chapters/narrate` takes
chapter numbers and a scope, and the handler asks `narrationTargets` in
[src/lib/runPlan.ts](../src/lib/runPlan.ts) which lines the scope covers: the lines with no usable
clip and the ones whose clip the script has moved past (`fill`), only the ones whose last request
failed (`failed`), or every line (`all`). A chapter with nothing in the scope is left out of the
run and the route says so (`nothing`), beside the reasons scripting already has and one more for a
chapter that has no script yet (`unscripted`). Each line goes to a
[`SpeechProvider`](../server/providers/speech.ts) with its text, its speaker's voice from the cast
(the Narrator's when the speaker has none, as `effectiveVoice` decides in the browser) and its
direction, and comes back as audio with a duration.

**A line is sent what the dictionary makes of it.** The book's pronunciation dictionary is applied
by `speak` in [src/lib/speech.ts](../src/lib/speech.ts) — the function the demo's simulator
applies — as each line goes out, so a term added mid-run reaches every line not yet sent. The
clip records what it was sent: `pronounced` always, and `said` with the number of substitutions
(`lex`) when that differs from the line, because the browser's drift rule compares `pronounced`
against the dictionary as it now stands. Two things keep that record honest. `PUT …/lexicon`
marks stale, in the same transaction as the list, every rendered clip the new list would send
different words for, and answers with those lines and their chapters' revisions (`stale`), so the
client's next edit names the revision the change moved the script to. And a clip that was out
when the list changed is checked as it lands, since the change had nothing landed to mark: it
lands `stale` if its words are no longer the book's. An Undo sends the old list with the lines
the change reported (`restore`), and those whose clip matches again go back to `done` — only
those, because a clip stale by a rename would also match and is not the dictionary's to clear.

**A line carries its tags, at its endpoint's rate.** The speaker's voice names an endpoint —
`<endpointId>/<voiceId>` — and the handler reads that endpoint from the stored configuration as
each line goes out, then hands it to `expressionPlan` in
[src/lib/expressions.ts](../src/lib/expressions.ts), the demo simulator's function: the words after
the dictionary, with each tag placed on the line written in as that endpoint spells it. The clip
records the plan — `expressionSignature` and the tags sent, beside `pronounced` — so the
browser's drift rule compares like with like. A line whose tags the endpoint cannot say (support
unconfirmed or switched off, a tag it does not list, one inside a respelled word) is failed before
any request, with the reason, as the demo blocks it; the other lines are sent. The endpoint's
`sampleRate` (16–48 kHz, speech endpoints only; none means the model's own) goes with the request,
and the clip records the rate the file came back at, read from the file, so a provider that ignored
the request cannot make the record lie. A clip that lands after the dictionary or the endpoint was
saved under it is checked the way a dictionary change is: it lands `stale` if the book would now
send other words, other tags or ask another rate. A voice naming an endpoint the server does not
have is sent as before, at the model's rate, and a line carrying tags through it is held back.

**A line longer than its endpoint takes goes out in parts.** The plan is cut by
`expressionParts` — the demo's call, `splitText` over the words as sent, at the endpoint's
`splitAt` and falling down to a clause, a word, a hard cut when the boundary it prefers is not
inside the limit — with every tag protected, so a laugh is never sent as half a token. Each part
is its own request, in order, and the audio comes back as one file: the WAVs joined end to end
with nothing between them, because the cuts fall where the reading already pauses and each
part's audio brings its own breath. Parts that disagree on rate, width or channels fail the line
rather than play at the wrong pitch. The clip records it as the demo does — `parts` and `splitAt`
on every clip sent through an endpoint, `cuts` (offsets into what was said) when there was more
than one — so the render details show where the line was cut and the Queue's badge counts the
requests. A part that fails fails the line with `error.part`, and the parts before it are thrown
away rather than kept as half a line. Its duration is the parts' together.

**The endpoints are saved whole.** `PUT /api/endpoints` takes what the Endpoints page holds — speech
endpoints, scripting profiles and the credential registry, with each endpoint's voices, rate
schedule, promotions and expression tags — and keeps exactly that in place of what was stored, in
one transaction ([server/endpoints/ops.ts](../server/endpoints/ops.ts)). What an endpoint observed
(its latency history, failures, a backoff) is the session's and is dropped on the way in, and reads
back empty. It is refused whole when two endpoints of one kind share an id, one endpoint has two
voices, tags, windows or promotions under one id, or an endpoint names a credential that is not in
the list. A speech endpoint and a scripting profile may share an id — the seeded `openai` is both —
so a profile's row is kept under `scripting:<id>`; a speech endpoint keeps its bare id, because a
voice names it. `GET` answers `saved: false` until the first save, which an empty table could not
say — a server whose every endpoint was removed has none either — and is the browser's cue to hand
over the configuration it started with. Nothing already rendered is touched by a save: a clip
records what it was rendered with, and the drift rule finds what a tag redefined or a rate changed
reaches.

**Nothing usable is thrown away to make room.** A line that already has a playable clip renders
its replacement beside it, in the `candidate` role, and the clip in the book keeps playing until
the replacement lands, when it takes over and the displaced clip joins the take list. That is the
demo's rule for a bulk run, kept because the reason for it — a re-narration of a finished chapter
must not leave it silent for the duration of the run — holds just as well on a server. A
replacement that fails leaves the clip it would have replaced alone, and the line reads as failed.
A chapter's status is asked of its clips (`chapterNarration`, the same function the demo asks):
`done` when every line is rendered, `stale` when one has been edited since, `failed` when any
line has no usable clip after a run that should have given it one, and `none` when nothing has.

**A clip is a row of the script, so writing one moves the script's revision.** `script_revision`
counts every write of a chapter's script rows, whoever made it, and a clip landing is one: a
client holding a copy read before it landed would otherwise write that copy back — its stale
`queued` and `generating` statuses included — over the clip the server just rendered. Instead
the edit is refused with the 409 the client already handles, and the chapter is read again. With
the queue polled while a job runs, the client's copy is almost always the fresh one; an edit that
does fall between a clip landing and the next poll is the one that has to be made again.

**The audio is a file the server keeps.** `AUDIO_DIR` (default `./data/audio`, beside the
database) holds one directory per book and one file per clip, named by a random token rather than
by the chapter's number, because a renumbering must not move files; `clips.url` is the path the
file is served at, `/api/audio/:bookId/:file`, and the player plays a clip that has one rather
than timing it in silence. The route serves nothing whose name is not a token it could have
made, so there is no path a request can build to a file that is not a clip. Removing a book
removes its directory; removing a volume removes the clips its chapters rendered.

Only [the fake speech model](../server/providers/fakeSpeech.ts) exists, and `SPEECH_PROVIDER=fake`
is the only value [env.ts](../server/env.ts) accepts, for the reason the scripting side gives.
It writes a real WAV file — a short, quiet tone whose pitch depends on the speaker, long enough to
say the line at a reading pace — so what the tests, the Narration page and the player exercise
is a file being fetched and played, not a duration being counted down. It is deterministic, it
honours a cancel, and a test can tell it which lines to fail.

### Export

Building an audiobook is the third kind of job, and the first that is about a book rather than a
chapter — its `chapterId` is null, so its dedupe key is `export:<book>:book` and a book builds one
audiobook at a time. That is stricter than the browser's rule, which lets two audiobooks of one
book build at once, and deliberately so: here a build reads every clip the other one might be
replacing.

**The plan the page drew is the plan that is written.** `planOf` in
[src/lib/exports.ts](../src/lib/exports.ts) turns the selection, the volumes and the settings into
the output files, their order, their chapters and their names, and the handler lays down exactly
that. Nothing on the server re-derives which chapter belongs in which file, because the page has
already shown someone the answer and a second copy of that rule is how a preview and a file stop
agreeing. `reviewOf` is asked the same way: a chapter with no usable audio, one still being
narrated, or a stale one the build was not told to accept is a **409 in the page's own words**,
since the blocker's title and detail are what the error carries. A build refuses rather than
trimming — unlike a bulk narration run, which leaves chapters out and says so — because a chapter
quietly missing from an audiobook is the failure this page exists to avoid.

**An update copies what has not moved.** A finished export records where each chapter's audio sits
inside its file (`export_chapters.byte_start` and `byte_length`). When the next version is built
with the same output settings, a chapter whose signature has not changed is copied straight out of
the version on disk instead of having its clips read again; `reusedChapters` decides which, and it
is the same function that drew "191 of its 196 chapters would be carried over" on the page. Each
span is checked again as the build runs, so a chapter re-narrated since the build was queued, or a
file removed behind the server's back, costs that one chapter its shortcut rather than putting
stale audio in the file or failing the build. That includes the version being copied from removed
mid-build: a `carry` part brings the chapter's clips along as `instead`, and an encoder that finds
the file gone lays those down and marks the chapter `readAgain`. `exports.encoder` records what wrote a version and
only the same encoder ever copies out of it, because a span is bytes into a WAV and milliseconds
into an AAC stream — reading one as the other would splice noise into the middle of an audiobook.

**The version on disk stays current until the new one lands.** The row goes up as `building`
immediately; the export it supersedes is marked `replaced` by the write that finishes the new one
and not before. A build that fails keeps its row and its reason, which is what Retry reads. A
cancelled one leaves nothing behind at all — there is no half an audiobook — and in both cases the
half-written files go and the audiobook already there is untouched. A build the process died
holding is re-queued by the same recovery every kind gets, and it clears the files the dead run
left before writing its own, so a book built three times after two crashes has one audiobook on
disk rather than three.

**The files are the server's, like the clips.** `EXPORT_DIR` (default `./data/exports`, beside the
database) holds one directory per book and one file per output file, named by a token rather than
by the audiobook's name — two versions of one audiobook have the same name, and a rebuild must not
write over the version still playing. They are kept apart from the clips because a clip is an input
the next build reads again and an audiobook is the deliverable. A download is addressed through the
export that owns it (`…/exports/:e/files/:n`) rather than by the file's name on disk, so there is
no path a request can build to a file this book did not produce; the name goes back on in the
header that decides what the browser calls it. That header is Latin-1 and a title is not, so the
name goes in the `filename*` a browser reads as UTF-8, with an ASCII stand-in beside it
(`content-disposition` writes both); an em dash in the title used to make the download a 500. A version that has been superseded keeps its file until it is forgotten, so an
older version can still be saved; removing a book removes both directories, and forgetting one
audiobook removes its files and leaves the rest.

**A book's id is ASCII, and so is every path it names.** The id is the directory both kinds of file
live under and part of every url that fetches one, and [http.ts](../server/lib/http.ts) holds the
one pattern the file modules accept. `slugify` makes only what it allows: accents come off
(`Pokémon` → `pokemon`), the few Latin letters with no base letter are spelled out (`ß` → `ss`,
`æ` → `ae`), an apostrophe is dropped and anything else separates words. A title that kept its
`ß` used to be a book whose audio was written and then could never be fetched or removed.

**A book's work stops before the book goes.** A narration or a build still running writes into the
book's directories as it goes, `mkdir` and all, so removing them under it only had the job put
them back, holding files no book owns. `removeBook` cancels every live job of the book first and
waits for the one running (`runner.finished`) — a handler honours a cancel at its next step — so
its `onSettled` clears what it half wrote while the rows it needs are still there. Only then do the
rows and the directories go. Removing the last volume is removing the book, and does the same.

**Removing files is never waited for, and never fatal.** The rows go first and the response does
not wait on the disk. A promise nobody holds that rejects is an unhandled rejection, which Bun
exits on — so a removal that met a permission error, or a directory a narration job was still
writing into, used to take the server down over a leftover directory. Every such removal goes
through `inBackground` in [background.ts](../server/lib/background.ts), which logs the failure as
a warning instead.

**Both are served a part at a time.** A clip and an audiobook go out through
[serve.ts](../server/lib/serve.ts), which answers `Range` — Bun does not, for a `Response` built in a
fetch handler, and a player that cannot ask for a part cannot seek. Every answer says
`Accept-Ranges: bytes`; one range inside the file is a 206 with its `Content-Range`; a range past
the end is a 416 (`range_not_satisfiable`) carrying the size. A malformed header, another unit or
several ranges at once get the whole file, which a server may always send instead — a media element
never asks for more than one. `range-parser`, the one Express's `send` uses, reads the header, and
the length is set outright so a `HEAD` reports it too.

#### The encoder, and what it will not pretend

An [`AudiobookEncoder`](../server/providers/encoder.ts) is handed a list of parts — a clip, a run of
silence, or a span of a file this export supersedes — and answers with the file it wrote, how long
it really plays, and where each chapter landed. What container it lands in is its business, the way
a line's audio is the speech provider's. It also declares what it can do, because the Export page
makes three promises an encoder may not be able to keep: `markers`, `normalizes` and `carries`.

`EXPORT_ENCODER=wav` is the default and needs nothing installed. The
[stitcher](../server/providers/wavEncoder.ts) is the counterpart of the fake speech model: that one
writes a real WAV per line, this one joins them into a real WAV per output file, with the book's
pacing inside a chapter and the export's gap between two. So a fresh clone, a CI run and the test
suite all build something that genuinely plays. It is not an M4B and writes no chapter marks, and
rather than name a file `.m4b` that is not one, it writes `.wav`, records no markers, and the job's
log says both in those words. It does not assume the fake's format either: every source file's RIFF
header is read and checked, so a speech provider answering at 24 kHz or in 16-bit stitches
correctly and one that changes format mid-chapter is an error naming the file. Neither encoder
resamples, so one output file holds one rate: the build checks the rate each clip recorded before
anything is written, and names the chapter that brought a second rate rather than a clip's path —
an endpoint's rate changed between two chapters' narrations is the usual way to get there. ffmpeg
checks each file's format as well, since its concat demuxer would otherwise play a clip at another
rate at the wrong speed rather than fail. A pause is a whole
number of sample frames in that format (`silenceBytes`), never a byte count rounded from seconds:
at 16-bit, an odd number of bytes of silence puts every sample after it a byte out of step, which
plays as noise to the end of the file, and the 8-bit fake could never have shown it. The ffmpeg
encoder writes its silence the same way.

`EXPORT_ENCODER=ffmpeg` writes what the settings actually asked for — AAC in an M4B with the
chapter marks a player reads, or an MP3 — and corrects loudness with EBU R128 in two passes when
the build asks for it. It is the one thing in this server that depends on something outside the
process, so it is checked at boot: a server configured for it with no `ffmpeg` on `PATH` refuses to
start, naming the binary, rather than queueing work that was always going to fail. It reports
`carries: false`, because splicing an already-encoded span beside audio encoded in this run needs
both to have been encoded identically — the way to do that is a file per chapter joined with
`-c copy`, which is a different arrangement on disk from the one this server keeps. So an update
under ffmpeg re-encodes every chapter and the job says so, rather than reporting chapters it did
not really reuse.

**The cover goes in as it is.** A build carries the image its settings chose, or the book's own
when they chose none, and ffmpeg copies it in untouched as the file's attached picture — the MP4
cover atom, or an ID3v2.3 front-cover frame on an MP3. A chosen image that has gone from disk fails
the build: the audiobook asked for was one with that picture. The EPUB's gone missing is a build
without one, and a warning. The stitcher `covers` nothing — a RIFF file has no place every player
looks — and says so in the job's log rather than leaving the page's "embedded in every file"
standing.

**The book's details go in as tags.** The Export page's title, author, narrator, series, year and
description travel with every build, and ffmpeg writes them with `-metadata`, whose generic keys it
spells as ID3v2.3 frames in an MP3 and iTunes atoms in an M4B: the title as the file's own (the
book's, `Title · Vol. 2`, or the chapter's, as the plan names the file), the book's title as the
album so a set groups as one book, the author as artist and album artist, the narrator as composer
— where Apple's and Audiobookshelf's readers look for one — and the series as the grouping. A file
per chapter gets a track number and a file per volume a disc number; an M4B is marked as an
audiobook (`stik` 2) so a phone files it with its books. A blank field is left out rather than
written empty, and a blank title is the book's own. An MP3's description goes in as a `TXXX`
frame rather than `COMM`, which is what ffmpeg writes; players that read only `COMM` show none.
The stitcher `tags` nothing and says so in the job's log.

### How the screens use it

Reads are queries, through [Pinia Colada](https://pinia-colada.esm.dev): one composable per
resource in [src/queries/](../src/queries/) — a chapter's text, its script, its history, a book's
cast, its exports, and the queue — each asking the service with a server answering and the seeded
store without one, so the mode choice is made once, there, and no page grows a demo-versus-real
branch. What a query reads it installs into the store that owns it: the stores stay the working
copy every page reads and every edit acts on, and a query is how that copy is filled and kept
fresh. The query cache is a Pinia store of its own; `main.ts` installs the plugin with re-reads on
focus and reconnect off, because what changes a script or a cast in this app is a request this app
made, and each one invalidates what it changed by key.

The queue is the one thing that moves on its own. `useBookJobs` is one shared query (`defineQuery`)
that the shell keeps open for as long as the app is, polling through the auto-refetch plugin while
a job is queued or running and going quiet when the queue does. A job that moved is a chapter that
moved, so its book is read again; a scripting job that just finished has its chapter's script and
history and the book's cast invalidated, since the run wrote all three. `runScripting` in
[scripting.ts](../src/stores/scripting.ts) queues the chapters on the server, marks nothing itself
and invalidates the queue; cancel, remove and clear are requests that do the same, and nothing is
marked locally first — a cancel that failed to reach the server must not look like one that
worked.

Editing is write-behind. Every edit in [scripts.ts](../src/stores/scripts.ts) acts on the store as
it does in the demo and ends with `_commit`, which writes the chapter's script as it now stands
with the revision it was read at; writes for one chapter are serialised and coalesced, so a burst
of edits is a few writes rather than one per keystroke, and a batch commits once under its own
name. A flag, an expression moved or omitted, and a clip's status all reach the server the same
way, since they live on the script's lines. A refused write reads the server's script and history
back over the local ones with a toast saying so — read directly through the service rather than by
invalidating the query, because invalidation refetches the entries it finds and a chapter whose
page has closed has none. The revision a write or a cast answer carries is never taken backwards,
whichever answer lands last. History is the server's in that mode: the store captures nothing
itself, an edit's answer carries the history it added to, and the panel follows. The cast store's
changes are requests too, with an exact undo — a rename renames back, a merge or a removal puts
back the lines that moved. An undo of a restore writes the script back first and only then takes
the speakers the restore added off the cast, since a removal while the server's script still names
them would move their lines and refuse the write.
[tests/jobsBackend.test.ts](../tests/jobsBackend.test.ts) drives those stores against the real app,
through the same composables the pages use.

Narration takes the same shape. `runNarration` in [narration.ts](../src/stores/narration.ts)
queues the chapters on the server at the scope asked for and marks nothing itself; the expression
guard, the estimate and the budget gates are the seeded endpoints' and are bypassed as scripting's
are. A narration job that moved — a clip landed, so its progress changed — has its chapter's script
read again, which is how the Narration page shows clips arriving one by one rather than when the
run ends; the read moves the store's revision on without showing a re-script diff, because the
lines say the same things and only their clips differ. "Re-narrate what changed" and "retry what
failed" are the same request at the `fill` and `failed` scopes, and a failed line retried by hand
is retried with its chapter's other failed lines, the server's smallest unit of work. A retake is
the same request without the `auto`: the candidate lands beside the clip in the book, and the
verdict the listener gives replaces the line and the chapter with the server's answer.

Export is the same shape one level up. `buildExport` queues a build and installs the version the
server answers with, which goes up as `building` straight away so the Audiobooks tab shows it
arriving rather than nothing; an export job that moved has the book's exports read again, which is
how progress, a finish, a failure and a cancel that removed the row all reach the page. Cancel and
Retry are the queue's, as they are for every other kind.

One thing the seeded run does that the server's does not, yet: the estimate and the budget gates
are the seeded endpoints' and are bypassed in backend mode — the fake costs nothing, and a real
provider's spending is the server's to meter. It is listed under
[what is not done yet](#what-is-not-done-yet).

## Four things the EPUB library does on import

[@likecoin/epub-ts](https://github.com/likecoin/epub.ts) is the parser, through its documented Node
entry point. Four of its behaviours are worked around in
[parse.ts](../server/epub/parse.ts), and all are worth knowing before changing that file:

- It reads `typeof window < "u" ? window.requestAnimationFrame.bind(window)`, taking any `window` at
  all for a complete browser one. That holds in a browser and in a bare server process, and fails in
  between — a test run where a frontend module has installed a small `window` stub, where it throws
  on import and takes the whole file with it.
- Importing it installs linkedom's `DOMParser` **and** a global `document`. The parser needs the
  first; the second is a server process announcing itself as a browser, which is false and has
  consequences for anything that branches on `typeof document`.

So the library is loaded explicitly rather than by a top-level `import`: both fixes have to bracket
the import itself, and an `import` statement gives nowhere to stand. Both globals are put back the
way they were found.

Unhandled rejections are the third thing, and they come from two directions.

A `Book` holds a deferred promise per part of the package, and a file that cannot be unzipped
rejects all of them; nothing awaits most of them, so a corrupt upload produces three unhandled
rejections. They are settled with a no-op handler before the open, which costs nothing on a good
file and turns a bad one into the single error the caller is already catching.

The other is not reachable that way. `unpack` calls `loadNavigation(…).then(…)` with no catch, and
the `Promise.all` that settles `opened` has none either, so an EPUB declaring a navigation document
it does not contain rejects two promises nothing outside the library holds. The book opens, every
chapter is present and readable, and the process takes an unhandled rejection that is fatal under
Node's `--unhandled-rejections=throw`. `loadNavigation` is therefore shadowed **on the instance**
and settled as "no navigation" — which is the library's own behaviour for a book that declares none,
so the outcome is the documented one and the chapters keep their own headings for titles.

The fourth is the console. The library has no logger option and `console.error`s with full stacks
in two places an import reaches: turning every manifest asset into a blob URL for display, where
an image the manifest lists and the zip lacks throws; and the spine's content hooks, which add a
`<base>`, a canonical `<link>` and an identifier `<meta>` to a section's head and throw on a section
that has none — three stacks per section. Neither is needed: sections are read through
`readSection`, and the converter drops the head. So the book is opened with
`replacements: "none"` and the content hooks are cleared before anything renders, which removes the
output at its source rather than patching a process-global `console` around an `await`.

## Tests

[tests/server/](../tests/server/) runs against the real routes and the real schema, with a
`:memory:` database per test. EPUBs are assembled in memory by
[tests/support/epub.ts](../tests/support/epub.ts) — a valid EPUB 3 package with a navigation
document and a spine — which keeps the suite free of binary fixtures nobody can read a diff of.
Every shape it can build is checked against EPUBCheck by a test, because the fixtures are the only
EPUBs this suite ever sees and one that is quietly invalid is a blind spot exactly where the code
under test is meant to be strict. That caught two: an identifier that was not a UUID, and the
`dcterms:modified` EPUB 3 requires. Both are derived from the book rather than the clock, so the
same input builds the same bytes.
What it can vary is what real EPUBs vary: where the navigation document sits relative to the
chapters, whether it calls a chapter something other than the heading inside it, whether one file
holds several chapters, and whether a file the package promises is in the archive at all.

| File                                                             | Covers                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [epubImport.test.ts](../tests/server/epubImport.test.ts)         | Reading a file: metadata, titles, text, refusals                                                            |
| [notices.test.ts](../tests/server/notices.test.ts)               | Which chapters are not story                                                                                |
| [contentsReview.test.ts](../tests/server/contentsReview.test.ts) | Import → review → add, volumes, removal, renumbering                                                        |
| [volumes.test.ts](../tests/server/volumes.test.ts)               | Removing a volume: rekeyed jobs, cancelled work, files, refusals mid-build                                  |
| [bookSettings.test.ts](../tests/server/bookSettings.test.ts)     | Budget, pacing and re-timing, a volume's name, and a reorder and its refusals                               |
| [endpoints.test.ts](../tests/server/endpoints.test.ts)           | Saved and refused whole; tags and sample rate on a line; one rate a file; a long line sent in parts         |
| [covers.test.ts](../tests/server/covers.test.ts)                 | The EPUB's cover kept, an upload and its refusals, a cover in an M4B and an MP3, the book's details as tags |
| [markdown.test.ts](../tests/server/markdown.test.ts)             | The converter's DOM bracket, and reading Markdown back                                                      |
| [jobs.test.ts](../tests/server/jobs.test.ts)                     | The queue: dedupe, cancel, restart, revision conflicts, HTTP; a chapter in a profile's chunks               |
| [narration.test.ts](../tests/server/narration.test.ts)           | Narration: scopes, replacement, failure, cancel, restart, dictionary, files                                 |
| [scriptEdit.test.ts](../tests/server/scriptEdit.test.ts)         | Editing against a revision, the history rule, what a run writes                                             |
| [cast.test.ts](../tests/server/cast.test.ts)                     | The cast a run leaves, rename, merge, removal, exact undo                                                   |
| [exports.test.ts](../tests/server/exports.test.ts)               | Building one: the file, the spans, refusals, cancel, failure, download                                      |
| [fakeProvider.test.ts](../tests/server/fakeProvider.test.ts)     | What the fake models produce — attributions, a valid WAV — and that they abort                              |
| [libraryClient.test.ts](../tests/server/libraryClient.test.ts)   | The client and the API against each other                                                                   |
| [schema.test.ts](../tests/server/schema.test.ts)                 | The seeded world through the schema and back                                                                |
| [../libraryBackend.test.ts](../tests/libraryBackend.test.ts)     | The library store, with a server answering                                                                  |
| [../jobsBackend.test.ts](../tests/jobsBackend.test.ts)           | The jobs, scripting, narration, scripts, cast and history stores, with a server                             |

The client tests matter more than they look. Both sides of the seam are in this repository, so "the
API returns what the client reads" is something the suite can check rather than a comment two files
apart — they drive the real `HttpLibraryService` and `HttpJobsService` against the real app, and a
route that renames a field fails there rather than in the browser.

Where a run has to be genuinely in flight — to be cancelled, edited under or renumbered — the
provider is `gatedProvider` from [tests/support/server.ts](../tests/support/server.ts), which holds
the door until the test says so; a build has `controlledEncoder`, which is the same door on the
encoder. Nothing in the queue's tests waits on a timer.

The build's tests assert the **file**, not the row's account of itself: how long it plays is read
out of its RIFF header, and "this chapter was carried over" is checked by comparing the bytes of
that chapter's span in the new file against the same span in the old one. A row that agrees with
itself and not with the disk is the failure the Export page exists to catch, so it is not a thing
the suite can be satisfied by. The two tests that need a real encoder are skipped where `ffmpeg`
is not installed, and are the only ones in the suite that depend on anything outside the process.

## What is not done yet

`libraryStore` reads and writes through [src/services/library.ts](../src/services/library.ts), so
the library screens are the server's in backend mode. What is worth knowing about that:

- **A removal cannot be undone, so it asks first.** `_bookSnapshot` puts a book back in the store;
  nothing puts one back in the database. The danger rule in
  [store ownership](../src/stores/README.md) has two halves — act at once with Undo, or ask first —
  and with a server answering a removal takes the second: the menu item and the volume row ask
  with a second click, and the toast says it cannot be undone rather than offering a button that
  would lie. Demo mode keeps the first half, because its snapshot really does put the book back.
- **An undo of a skip or a keep is exact.** Skip, include and keep are rules that only run
  forwards — including a noted chapter records that it was looked at — so an Undo does not run the
  inverse rule: the store records what the chapters were and sends that to
  `POST /api/books/:id/chapters/decisions`, which puts it back as stated. A skip that is undone
  comes back undecided, and keeping a chapter offers Undo, on both sides of the seam.
- **A budget is stored, not enforced.** The cap, the pause and the script budget are written by
  `PATCH /api/books/:id` and read back on every load, and the browser's gates read them; nothing on
  the server holds a job against them yet, for the reason the budgets bullet below gives.
- **An undo over HTTP is an edit.** A rename is renamed back and a merge or a removal puts back the
  lines that moved, exactly; but undoing an edit, a bulk correction or a restore writes the previous
  script back as an edit, so the history says an edit happened rather than forgetting the entry the
  way the demo's snapshot does. A session that comes back to where it began leaves no entry, which
  covers the common case; a bulk correction undone leaves its entry with an edit after it.

The queue runs three kinds of job. What the scripting, narration and export slices do not do yet,
each because a route or a table's writer is missing rather than by oversight:

- **An endpoint saved is not an endpoint called.** The server keeps the configuration and reads
  the tags and the rate from it, and the fake renders every line whatever the base URL, model and
  key say. A chapter's duration
  is its clips plus the book's pacing, which a pacing change re-times on the server for every
  chapter that has been narrated.
- **An update under ffmpeg re-encodes everything.** Carrying a chapter over is real under the
  stitcher and refused under ffmpeg, for the reason [the encoder](#the-encoder-and-what-it-will-not-pretend)
  gives. Making it real there means keeping an encoded file per chapter and joining those with
  `-c copy`, which is a different arrangement on disk from the one this server has.
- **No usage record is settled.** The seeded run also settles a usage record with a receipt; the
  server's writes the script, the speakers and the version, and the fake provider has nothing to
  bill. The ledger has no route.
- **Budgets and estimates are not enforced on the server.** The fake provider costs nothing to
  meter. A real one needs the pricing engine in `src/lib/pricing.ts` on the server side and a
  reservation against the book's cap before dispatch, the way `_reserveQueued` does it in the demo.
- **Retrying a failed job re-queues it through the same route** it was asked for by, so a retry is
  planned again against the book as it now stands rather than replayed as it was.
- **A change made in another tab is noticed on the next write, not before.** Nothing pushes
  events; a script edited elsewhere is found when an edit here is refused for its stale revision.

The tables for the rest of the domain exist and are proven against the seeded world. The usage
ledger has no route, and neither do the secrets a credential names or any real provider.
The seeded demo remains the way to exercise all of it, and stays that way after the backend is
finished — see [the demo guide](demo.md).

Changing the schema means regenerating: `pnpm db:generate` after editing anything in
[server/db/schema/](../server/db/schema/), or the next boot migrates to the old shape and the tests
fail somewhere that does not name the cause. Migrations are versioned in [drizzle/](../drizzle/)
and applied in order at boot; `0001` added the script revision and the queue's dedupe key, `0002`
the version an open editing session preserved, and `0003` what a build writes — the file each
output landed in, the span each chapter occupies inside it, and which encoder wrote it; `0004` an
endpoint's sample rate and the rate each clip came back at; `0005` a book's cover image.

**Foreign keys are off while migrations run.** A change drizzle-kit cannot write as `ALTER TABLE` is
written as a rebuild — new table, copy, `DROP` the old one, rename — and with foreign keys on, that
`DROP` cascades through every `ON DELETE CASCADE` pointing at the table. The generated SQL does say
`PRAGMA foreign_keys=OFF`, but drizzle runs the migrations in one transaction, where SQLite ignores
it. So [migrate.ts](../server/db/migrate.ts) turns them off on the connection before drizzle begins,
asks `PRAGMA foreign_key_check` afterwards, and refuses to boot on a database a migration left
with a reference to nothing. [migrate.test.ts](../tests/server/migrate.test.ts) writes the rebuild
the next change to `chapters` would be and runs it over an imported book; before this, it wiped every
chapter's text. The connection also waits up to five seconds on a busy database, so
`pnpm db:migrate` beside a running server waits for a write to finish rather than failing.
