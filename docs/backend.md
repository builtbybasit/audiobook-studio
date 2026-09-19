# Backend

[Back to README](../README.md) · [Development](development.md) · [Seeded demo](demo.md)

The server in [server/](../server/) is where the app stops pretending. It reads real EPUB files and
stores real books. **The first slice is the library: import, the contents review, and removal. The
second is the queue: scripting a chapter is a job the server runs, and the Queue page shows it. The
third is what a scripted chapter owns: its script can be edited over HTTP, its history and the
book's cast are written by the run that made them, and the frontend reads all of it through
queries.** Narration, endpoints, pricing and export are still the seeded demo and are untouched by
all three.

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
| [server/exports/ops.ts](../server/exports/ops.ts)         | The finished audiobooks: listed and forgotten; nothing builds one yet                                    |
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
| [server/providers/](../server/providers/)                 | The port a scripting model is reached through, and the fake behind it                                    |
| [server/epub/parse.ts](../server/epub/parse.ts)           | Reading an actual EPUB                                                                                   |
| [server/epub/text.ts](../server/epub/text.ts)             | One section's markup to the prose a narrator would read                                                  |
| [server/epub/notices.ts](../server/epub/notices.ts)       | Deciding which chapters are not story                                                                    |
| [server/import/assemble.ts](../server/import/assemble.ts) | Parsed chapters to a book, numbered and marked `importing`                                               |

Three layers, each ignorant of the one above it. A route validates the request, calls one
operation in `server/*/ops.ts` or `server/jobs/scripting.ts`, and returns what it got: no route
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
- **The navigation is waited for.** `open()` resolves as soon as the package document is parsed;
  the navigation document is a second file still being fetched. Read too early it is simply absent,
  every chapter quietly falls back to its own heading, and the result usually looks close enough to
  be believed. It is awaited on its own rather than through `book.ready`, which also covers the
  cover image and the resource list — a book with no cover has a perfectly good table of contents,
  and losing it to an unrelated failure would be the same silent fallback by another route.
- **Navigation links are resolved against the navigation document.** A spine item's `href` is
  written against the package document and a navigation entry's against the navigation document,
  which may sit in a directory of its own. `../text/c1.xhtml` and `text/c1.xhtml` are then the same
  file spelled two ways, and comparing them as written loses every label in the book.
- **Sections are unloaded as they are read.** A web-novel volume can be a thousand chapters, and
  holding every parsed document at once is how a routine import becomes an out-of-memory crash.
- **The navigation document and non-linear spine items are not chapters.** A cover plate and a
  colophon would otherwise arrive in the review as something to decide about.
- **Tables are kept, not dropped.** A `<table>` in a novel is as often prose as it is data — a
  character list, a release timetable, or a paragraph an old conversion laid out in cells — and
  dropping the element takes everything inside it with it. They are stored as GFM tables and read
  out a row at a time. `figure`, `figcaption`, `aside` and `nav` are still dropped, because they
  caption something the audiobook cannot show, hold a sidebar the narrator is not reading, or are
  the table of contents itself — judgements about the narration rather than accidents of how the
  page was built.

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

Both run `marked` over the stored text rather than stripping punctuation somebody remembered. A
table becomes `Day, Chapter` a row at a time; a horizontal rule becomes a paragraph break; `\*`
comes back the star the book had.

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
switch on (`not_found`, `conflict`, `bad_request`, `too_large`, `unsupported_media`, `internal`),
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

The client holds up the other end. Not everything that answers `/api` is the API — a proxy, a dev
server or a gateway in front of it answers with HTML — so [`HttpClient`](../src/services/http.ts)
does not assume the body parses. Letting `JSON.parse` throw would raise a `SyntaxError` out of a
method whose whole contract is that it raises `ApiError`, and the page would report a JavaScript
fault where it should be saying the server is unreachable. The library service and the jobs
service are both built on it, so that rule is written once.

| Method   | Path                                             | Does                                                     |
| -------- | ------------------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/api/health`                                    | Is it up                                                 |
| `GET`    | `/api/books`                                     | Every book, importing ones included, with chapter counts |
| `GET`    | `/api/books/:id`                                 | A book and its chapters                                  |
| `GET`    | `/api/books/:id/chapters/:n/text`                | A chapter's prose                                        |
| `GET`    | `/api/books/:id/chapters/:n/script`              | A chapter's script, and its revision                     |
| `PUT`    | `/api/books/:id/chapters/:n/script`              | Replace the script, naming the revision that was read    |
| `GET`    | `/api/books/:id/chapters/:n/history`             | The chapter's versions and how the script came to be     |
| `POST`   | `/api/books/:id/chapters/:n/history/checkpoints` | Name the script as it stands and keep a copy (201)       |
| `DELETE` | `/api/books/:id/chapters/:n/history/versions/:v` | Forget one version; what an Undo of a checkpoint sends   |
| `GET`    | `/api/books/:id/cast`                            | The cast and the pronunciation dictionary                |
| `PUT`    | `/api/books/:id/characters/:name`                | One speaker, written as stated: new or replaced          |
| `POST`   | `/api/books/:id/characters/:name/rename`         | Rename; every line that names them moves                 |
| `POST`   | `/api/books/:id/characters/:name/merge`          | Fold one speaker into another                            |
| `DELETE` | `/api/books/:id/characters/:name`                | Remove a speaker; their lines go to the Narrator         |
| `POST`   | `/api/books/:id/characters/attribute`            | Put a speaker back on exactly these lines; an Undo       |
| `PUT`    | `/api/books/:id/lexicon`                         | The pronunciation dictionary, replaced whole             |
| `GET`    | `/api/books/:id/exports`                         | The finished audiobooks                                  |
| `GET`    | `/api/books/:id/exports/:e`                      | One of them                                              |
| `DELETE` | `/api/books/:id/exports/:e`                      | Forget one                                               |
| `POST`   | `/api/books/import`                              | An uploaded EPUB → a book, or one more volume of one     |
| `POST`   | `/api/books/:id/confirm`                         | The review is done; it joins the library                 |
| `POST`   | `/api/books/:id/discard`                         | Cancel: an unconfirmed book goes, or its new volume      |
| `POST`   | `/api/books/:id/chapters/skip`                   | Skip chapters for the audiobook                          |
| `POST`   | `/api/books/:id/chapters/include`                | Put them back                                            |
| `POST`   | `/api/books/:id/chapters/keep`                   | Keep a noted chapter and stop the suggestion asking      |
| `POST`   | `/api/books/:id/chapters/decisions`              | Put decisions back exactly as stated; what an Undo sends |
| `POST`   | `/api/books/:id/chapters/script`                 | Queue a scripting job per chapter, as one run (202)      |
| `DELETE` | `/api/books/:id`                                 | Remove a book and everything it owns                     |
| `DELETE` | `/api/books/:id/volumes/:volumeId`               | Remove a volume; the last one removes the book           |
| `GET`    | `/api/jobs`                                      | Every job, oldest first; `?bookId=` narrows it           |
| `GET`    | `/api/jobs/:id`                                  | One job, with its activity                               |
| `POST`   | `/api/jobs/:id/cancel`                           | Stop it: a queued job never starts, a running one stops  |
| `DELETE` | `/api/jobs/:id`                                  | Take a finished job out of the history                   |
| `POST`   | `/api/jobs/clear`                                | Clear the history; live jobs stay                        |

`POST /api/books/import` is `multipart/form-data`: `file` is the EPUB, `title` optionally overrides
the one in the file, and `bookId` with `name` adds the file to an existing book as one more volume.

`POST /api/books/:id/chapters/script` answers with the jobs it made, the chapters it left out and
why (`excluded`, `busy`, `missing`), and the book's chapters as they now stand — so the client can
say "2 already being scripted" instead of waiting for work that is not coming.

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
- **A restart loses no work.** A row still `running` when nothing is running is a job the last
  process died holding. `start` puts it back in the queue with an event saying so, and it starts
  again — twice in all, because a job that takes the process down every time must not be allowed
  to forever; the third time it fails with the reason recorded. `stop` (a `SIGINT` from
  `pnpm dev:server`) aborts the running job and leaves its row `running` on purpose, so a stop and a
  crash are the same case to the recovery and there is one recovery path rather than two.
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

One thing the seeded run does that the server's does not, yet: the estimate and the budget gates
are the seeded endpoints' and are bypassed in backend mode — the fake costs nothing, and a real
provider's spending is the server's to meter. It is listed under
[what is not done yet](#what-is-not-done-yet).

## Three things the EPUB library does on import

[@likecoin/epub-ts](https://github.com/likecoin/epub.ts) is the parser, through its documented Node
entry point. Three of its behaviours are worked around in
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

| File                                                             | Covers                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [epubImport.test.ts](../tests/server/epubImport.test.ts)         | Reading a file: metadata, titles, text, refusals                               |
| [notices.test.ts](../tests/server/notices.test.ts)               | Which chapters are not story                                                   |
| [contentsReview.test.ts](../tests/server/contentsReview.test.ts) | Import → review → add, volumes, removal, renumbering                           |
| [markdown.test.ts](../tests/server/markdown.test.ts)             | The converter's DOM bracket, and reading Markdown back                         |
| [jobs.test.ts](../tests/server/jobs.test.ts)                     | The queue: dedupe, cancel, restart, revision conflicts, HTTP                   |
| [scriptEdit.test.ts](../tests/server/scriptEdit.test.ts)         | Editing against a revision, the history rule, what a run writes                |
| [cast.test.ts](../tests/server/cast.test.ts)                     | The cast a run leaves, rename, merge, removal, exact undo                      |
| [exports.test.ts](../tests/server/exports.test.ts)               | The finished audiobooks over HTTP                                              |
| [fakeProvider.test.ts](../tests/server/fakeProvider.test.ts)     | What the fake scripting model attributes, and that it aborts                   |
| [libraryClient.test.ts](../tests/server/libraryClient.test.ts)   | The client and the API against each other                                      |
| [schema.test.ts](../tests/server/schema.test.ts)                 | The seeded world through the schema and back                                   |
| [../libraryBackend.test.ts](../tests/libraryBackend.test.ts)     | The library store, with a server answering                                     |
| [../jobsBackend.test.ts](../tests/jobsBackend.test.ts)           | The jobs, scripting, scripts, cast and history stores, with a server answering |

The client tests matter more than they look. Both sides of the seam are in this repository, so "the
API returns what the client reads" is something the suite can check rather than a comment two files
apart — they drive the real `HttpLibraryService` and `HttpJobsService` against the real app, and a
route that renames a field fails there rather than in the browser.

Where a run has to be genuinely in flight — to be cancelled, edited under or renumbered — the
provider is `gatedProvider` from [tests/support/server.ts](../tests/support/server.ts), which holds
the door until the test says so. Nothing in the queue's tests waits on a timer.

## What is not done yet

`libraryStore` reads and writes through [src/services/library.ts](../src/services/library.ts), so
the library screens are the server's in backend mode. Two things about that worth knowing:

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
- **A budget cap, a pause, the pacing, a volume rename and a volume reorder stay in the browser.**
  The columns are in the schema and nothing writes them, so those survive a navigation and not a
  reload.
- **An undo over HTTP is an edit.** A rename is renamed back and a merge or a removal puts back the
  lines that moved, exactly; but undoing an edit, a bulk correction or a restore writes the previous
  script back as an edit, so the history says an edit happened rather than forgetting the entry the
  way the demo's snapshot does. A session that comes back to where it began leaves no entry, which
  covers the common case; a bulk correction undone leaves its entry with an edit after it.

The queue runs one kind of job. What the scripting slice does not do yet, each because a route or a
table's writer is missing rather than by oversight:

- **Only scripting has a handler.** A `narration` or `export` job enqueued on this server fails at
  once saying so. The runner, the dedupe rule, cancellation and recovery are the same for a kind
  that does not exist yet; what it needs is a handler and a provider port of its own.
- **No usage record is settled.** The seeded run also settles a usage record with a receipt; the
  server's writes the script, the speakers and the version, and the fake provider has nothing to
  bill. The ledger has no route.
- **Budgets and estimates are not enforced on the server.** The fake provider costs nothing to
  meter. A real one needs the pricing engine in `src/lib/pricing.ts` on the server side and a
  reservation against the book's cap before dispatch, the way `_reserveQueued` does it in the demo.
- **Retrying a failed job re-queues it through the same route**, which is right for scripting and
  meaningless for the kinds that have no handler.
- **Building an audiobook is refused in backend mode.** The exports routes read and forget; nothing
  writes an export until there is a build job, and a build simulated in the browser would show an
  audiobook the server does not have.
- **A change made in another tab is noticed on the next write, not before.** Nothing pushes
  events; a script edited elsewhere is found when an edit here is refused for its stale revision.

The tables for the rest of the domain exist and are proven against the seeded world. The usage
ledger, narration and endpoints have no routes, and neither do credential storage or any real
provider. The seeded demo remains the way to exercise all of it, and stays that way after the
backend is finished — see [the demo guide](demo.md).

Changing the schema means regenerating: `pnpm db:generate` after editing anything in
[server/db/schema/](../server/db/schema/), or the next boot migrates to the old shape and the tests
fail somewhere that does not name the cause. Migrations are versioned in [drizzle/](../drizzle/)
and applied in order at boot; `0001` added the script revision and the queue's dedupe key, and
`0002` the version an open editing session preserved.
