# Backend

[Back to README](../README.md) · [Development](development.md) · [Seeded demo](demo.md)

The server in [server/](../server/) holds the library. It reads EPUB files and stores the books;
runs the queue that scripts chapters, narrates them and builds audiobooks; keeps the clips and the
audiobooks as files it serves; and holds the endpoints, their keys and the ledger of what every
request cost. The page reads and writes all of it over HTTP, and nothing in the browser simulates
anything.

The server sends work to what the Endpoints page holds, and nothing else: a chapter to the
scripting profile its run was queued with, a line to the speech endpoint its speaker's voice
belongs to. No setting switches the whole server onto fakes. A **simulated** endpoint is one kind
of endpoint instead — **Simulated (free)** among the presets of either kind, picked by its base
URL, `simulated://…` — which the server answers itself, without the network and without charge
([the providers](#the-providers-and-where-a-key-lives) says how). A fresh library has no endpoints
at all, so nothing is sent anywhere until you add one. There are no credentials in the server's
configuration, and no code path from an import to a paid request.

## Run it

```sh
pnpm dev          # the API on :8787, and the frontend on :5173 proxying /api and /demo/api to it
```

That is `pnpm dev:server` and `pnpm dev:web` side by side through `concurrently`, each line
prefixed `api` or `web`; stopping either stops both. Each library's migrations are applied as the
server opens it, so a checkout that has pulled a schema change needs no separate step. Settings
and their defaults are in [server/env.ts](../server/env.ts) and [.env.example](../.env.example);
every one has a working default, so no `.env` is also fine. The other commands are in
[development](development.md).

## Which library a tab talks to

The page talks to your library at `/api`. The header's **Demo** chip opens the demo instead, for
that tab only: **Enter demo** sets `audiobook-studio:mode` in `sessionStorage` and reloads, and
[src/services/mode.ts](../src/services/mode.ts) reads it once as the page loads and points every
service at `/demo/api`. **Leave demo** clears it and reloads; a new tab opens on your library. The
choice is made at load rather than live because the stores and the query cache are built once,
from what the services answer: switching in place would mean tearing all of them down.

**Neither library ever silently becomes the other.** A server that is down is an error the person
sees — the Library says the server is not running and how to start it — not a quiet slide into
seeded books that look real, and the HTTP client reports a server it cannot reach as exactly that,
rather than as an empty library. The rules this keeps are in
[how the demo is built](demo.md#how-the-demo-is-built).

## Two libraries: yours and the demo

One server holds two libraries, built by the same function (`openLibrary` in
[server/libraries.ts](../server/libraries.ts)) from different settings, so they differ only in
what they are given — and neither is given anything of the other's:

| Library | API under   | Database (`.env`)                             | Clips, audiobooks, voice recordings                                     |
| ------- | ----------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Yours   | `/api`      | `DATABASE_URL`, default `./data/library.db`   | `AUDIO_DIR`, `EXPORT_DIR`, `VOICE_DIR`                                  |
| Demo    | `/demo/api` | `DEMO_DATABASE_URL`, default `./data/demo.db` | `audio/`, `exports/`, `voices/` under `DEMO_DIR`, default `./data/demo` |

Each has its own queue and its own speech gate. A request goes to the demo when its path is under
`/demo/api` and to your library otherwise, and every address a library writes down — a clip's, a
cover's — is under its own base, so what the demo made is only ever served by the demo. The demo
cannot touch your library because nothing in it holds a handle to your database.

Your library is never seeded: a fresh one starts with no books and no endpoints. The demo is
seeded when its database is fresh (no endpoints and no books) and left as it is otherwise, with the
world `makeWorld()` builds from [server/demo/seed/](../server/demo/seed/), written in one
transaction by [server/demo/world.ts](../server/demo/world.ts) — the one place the server reaches
into the seed: four books with their volumes, notices and prose, their casts and dictionaries, some
six thousand script lines with their clips and receipts, finished and failed exports, each book's
spend so far, and the finished job history. Its endpoints and profiles are the world's, with each
base URL moved to `simulated://` in front of the same host and path (OpenAI's is
`simulated://api.openai.com/v1`), so they keep their names, rates and voices and none of them can
reach the network; the **Simulated (free)** endpoint and profile are there beside them
([server/demo/seed.ts](../server/demo/seed.ts)). A seeded clip has an address and no file: the demo writes its WAV — the
simulated tone, as long as the row says and at its rate — the first time the audio route or a
build reads it ([server/audio/demoClips.ts](../server/audio/demoClips.ts)), rather than six
thousand at seed time. Your library never makes a file it does not have, so a missing one is a 404
there.

The demo alone has routes under `/demo/api/demo` ([server/routes/demo.ts](../server/routes/demo.ts)):

- **`POST …/reset`** stops the demo's queue (the running job is aborted and waited for), deletes
  every row of every table the schema declares, removes the demo's folders, seeds again at the
  time of the reset and starts the queue, with a few runs going so it is not empty.
- **`GET …/situations`** lists the Demo drawer's situations, and **`POST …/situations/:id`**
  rebuilds the demo with one applied, the way a reset does, answering with what it did and the page
  to open. It runs
  [server/demo/seed/scenarios/situations.ts](../server/demo/seed/scenarios/situations.ts) against
  the world in memory — a `ScenarioContext` over plain data
  ([server/demo/situations.ts](../server/demo/situations.ts)) — and writes the result in one
  transaction, at the time of the request, so a ten-second cooldown or a promotion dated from now
  is fresh. Situations that read the clock's hour use the server's timezone. The server does not
  remember which situation was applied; the tab keeps its name, note and steps in `sessionStorage`.
- **`GET`/`PUT …/speed`** (1, 4 or 16) divides every simulated wait in the demo — a line's, a
  scripting chunk's, a build chapter's ([server/demo/pace.ts](../server/demo/pace.ts)). It is kept
  in memory, survives a reset, and is 1× again when the server restarts. Your library is never
  paced.

What a situation describes that is not a row is made real once the queue is running again
([server/demo/live.ts](../server/demo/live.ts)). **What an endpoint has been through** becomes what
the server keeps for any endpoint: each point of its recent history a settled request in the ledger
at its moment and latency, each other rate limit a refused request, every one free and marked
simulated, and a speech endpoint still cooling down held by the gate for the rest of its cooldown.
**Work in flight** is real scripting or narration runs on the simulated endpoints; a **running
build** is a real one whose chapters the demo's encoder reports 140 ms apart; a **failed build** is
queued through the real path and settled at once as failed, so **Retry** rebuilds it. A book's
**opening scripting spend** is a ledger row, since that is what a script budget is held to.
[libraries](../tests/server/libraries.test.ts), [demoWorld](../tests/server/demoWorld.test.ts),
[demoSituations](../tests/server/demoSituations.test.ts) and
[demoLive](../tests/server/demoLive.test.ts) hold all of this.

## The schema

The tables are grouped by the part of the app that owns them, mirroring
[store ownership](../src/stores/README.md), so "who writes this" has the same answer on both sides
of the wire.

| Area      | Tables                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| Library   | `books`, `volumes`, `chapters`, `chapter_texts`                                       |
| Cast      | `characters`, `lexicon_entries`, `speaker_samples`, `speaker_sample_files`            |
| Script    | `segments`, `clips`, `script_versions`, `script_heads`, `previous_scripts`            |
| Endpoints | `endpoints`, `voices`, `rate_windows`, `promotions`, `expression_tags`, `credentials` |
| Voices    | `cloned_voices`, `voice_samples`                                                      |
| Queue     | `jobs`, `job_events`                                                                  |
| Export    | `exports`, `export_files`, `export_chapters`                                          |
| Usage     | `requests`, `opening_spend`, `clone_fees`                                             |
| App       | `settings`                                                                            |

`opening_spend` is what a book had spent before the ledger began; only the demo's seed writes one,
so a book imported on the server starts at zero. `settings` holds what belongs to the installation
rather than to a book, such as the library's default scripting prompt. Chapter text is a table of
its own because the review lists a few hundred chapters at a time and needs none of their prose.

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
to two rows rather than a restructure, and the rule that a line may never be left with neither its
clip nor its retake becomes a constraint the database enforces: a partial unique index allows at
most one `current` and one `candidate` per line, and leaves `take` unconstrained because takes are
a list.

### Absent is not null

The domain marks things by leaving them out, and three fields exist only to record that
difference — each found by the round-trip test below rather than by reading the types:

- **`endpoints.timezone` is nullable**, and null means no rate card has ever been configured. An
  endpoint that came back with an empty card instead of no card would skip the defaults the app
  fills in on first use.
- **`export_chapters.duration` is nullable**, and null means the timeline was never recorded. Zero
  would be indistinguishable from a chapter of silence.
- **The operational settings arrive as a block or not at all.** `spend_limit: null` means "no
  endpoint-level limit" and `credential_id: null` means "no named account" — settings, not
  absences — so the block's presence is keyed on `timeout_sec` and its fields come back together.

### Everything a chapter owns follows its number

A chapter is addressed by its **number** within the book, continuous across volumes, and that
number moves when a volume is removed or the volumes are reordered. Every child of `chapters` — the
text, the script, the clips through the script, the history, an export's chapter list, a queued
job — keys on `(book_id, chapter_id)` through a composite foreign key declared `ON UPDATE CASCADE`.
Renumbering therefore writes `chapters` and nothing else, and the rest follows in the same
statement. Moving them by hand would be a second definition of the same relationship, and the one
that fell behind would do so silently.

A **job** is in that list because it is live state: a queued narration of chapter 2 that quietly
became chapter 1 underneath it is not a display problem, and a job for a chapter that no longer
exists is one the Queue can neither open nor retry. `jobs.chapter_id` is nullable for a whole-book
job such as a build, and a foreign key with a null in it is satisfied by definition.

Three things a removal changes do not follow a key, and `deleteVolume` does them in the same
transaction. A live job's **duplicate key** (`active_key`, `kind:book:chapter`) is a string built
from the number, so `rekeyActive` writes it again from the number the job now has — parking every
key on the job's id first, because the index is unique and chapter 10's new key is chapter 7's old
one. Left alone, a job queued for chapter 7 that became chapter 4 would not be seen as a duplicate
of a request for chapter 4, which would then be rendered and paid for twice. An **audiobook** keeps
the chapters it still has, and one left with none goes with its files. The **clips** the removed
chapters rendered are removed from disk after the rows. Before any of it, work on the chapters that
go is cancelled through the runner, so a provider stops being paid for them; and a removal is
refused while an audiobook of the book is being built, because a build reads clips and records
where each chapter landed by number. Nothing puts a removed book or volume back, so the page asks
before removing rather than offering Undo.

**A reorder is the same renumbering without the removal.** `PUT /api/books/:id/volumes/order`
writes each volume's `position` and runs the same renumbering and `rekeyActive`. Nothing is
cancelled — a running job finds its chapter by uid at every write — and nothing leaves the disk.
It is refused mid-build for the removal's reason, and while a volume is still in review, since a
new volume is added at the end and has no place in an order until it is confirmed.

### The number is an address; the ledger needs an identity

`chapters.uid` is assigned once at import and never rewritten. It exists for the one table that must
not move: the **usage ledger is append-only**, and a row that said "chapter 2" and now says "chapter
1" is not a record of the past, it is a quiet edit of one. So `requests.chapter_uid` references the
chapter itself, `ON DELETE SET NULL` and never cascade: the chapter is gone, what was spent on it is
not, and it stays in every total. The number a row displays is looked up when it is read, and
`label`, frozen when the request settles, still names the work after the chapter has been removed.

### Voices are tied by value, not by key

A save of the endpoints replaces every endpoint and voice row, so anything that must outlive a save
cannot hang off `voices` by a cascading key — it would be emptied on every save. `cloned_voices`,
`voice_samples` and `clone_fees` name their voice by `(endpoint_id, voice_id)` instead, and the save
reconciles them in its own transaction
([cloning a voice](#cloning-a-voice-and-keeping-its-samples)).

### What is deliberately not stored

- **Endpoint telemetry.** `history`, `failures`, `rateLimits`, `backoffUntil` and `lastError` are
  what a process has observed, not what anyone configured. Writing a backoff deadline to disk would
  let a restart resurrect a cooldown for a rate limit that expired days ago, and the durable record
  of what an endpoint has done is the `requests` ledger. A save drops them on the way in.
- **A key in anything readable.** `endpoints.api_key` is the one secret in the schema, write-only
  over HTTP ([where a key lives](#the-providers-and-where-a-key-lives)). `credentials` is a registry
  of names — which account an endpoint belongs to — and holds no key.
- **Reader and UI preferences.** Typography, the rail, the current book: per-browser, in
  `localStorage`.

### Does it hold the domain?

[schema.test.ts](../tests/server/schema.test.ts) writes the **seeded world** through the schema and
reads it back, asserting equality. That world is the reference answer because it is the data every
screen is built against: books with volumes and import notices, casts and dictionaries, six
thousand script lines with clips and frozen receipts, retakes awaiting a verdict, endpoints with
off-peak schedules and running promotions, and finished, replaced and failed exports. It is a
round-trip assertion rather than a field list on purpose: a mapper that turns an absent `note` into
a null one, or hands back a take carrying a `status` it never had, fails there rather than in a
screen six months from now.

### Migrations

Changing the schema means regenerating: `pnpm db:generate` after editing anything in
[server/db/schema/](../server/db/schema/), or the next boot migrates to the old shape and the tests
fail somewhere that does not name the cause. Migrations are versioned in [drizzle/](../drizzle/)
and applied in order as each library opens.

**Foreign keys are off while migrations run.** A change drizzle-kit cannot write as `ALTER TABLE` is
written as a rebuild — new table, copy, `DROP` the old one, rename — and with foreign keys on, that
`DROP` cascades through every `ON DELETE CASCADE` pointing at the table. The generated SQL does say
`PRAGMA foreign_keys=OFF`, but drizzle runs the migrations in one transaction, where SQLite ignores
it. So [migrate.ts](../server/db/migrate.ts) turns them off on the connection before drizzle begins,
asks `PRAGMA foreign_key_check` afterwards, and refuses to boot on a database a migration left
with a reference to nothing; [migrate.test.ts](../tests/server/migrate.test.ts) runs such a rebuild
over an imported book. The connection also waits up to five seconds on a busy database, so
`pnpm db:migrate` beside a running server waits for a write to finish rather than failing.

## The shape of it

| Location                                                                                      | Responsibility                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [server/index.ts](../server/index.ts)                                                         | Boot: check the encoder, open both libraries, start their queues, listen                              |
| [server/libraries.ts](../server/libraries.ts)                                                 | One library — database, queue, gate, files, API under its base — and the fetch that picks one by path |
| [server/app.ts](../server/app.ts)                                                             | The API as a value, built around a database and a queue so tests can drive it                         |
| [server/env.ts](../server/env.ts)                                                             | Configuration, validated once at startup                                                              |
| [server/routes/](../server/routes/)                                                           | HTTP: a request turned into one operation, and its result turned into JSON                            |
| [server/library/](../server/library/), [cast/](../server/cast/), [script/](../server/script/) | What a person does to a book, a cast and a script: the rules, as operations                           |
| [server/narration/](../server/narration/)                                                     | A chapter's slot and status rules, a line in parts or in batches, a retake and its verdict, the cost  |
| [server/exports/](../server/exports/)                                                         | The finished audiobooks: listed, downloaded, forgotten, and where their files live                    |
| [server/endpoints/ops.ts](../server/endpoints/ops.ts)                                         | The endpoint configuration saved whole; a voice sample; a provider's failure as a refusal             |
| [server/voices/](../server/voices/), [speakerSamples/](../server/speakerSamples/)             | The recordings a cloned voice was made from, and the ones a script file brought for a speaker         |
| [server/usage/](../server/usage/)                                                             | The ledger, and the budgets held against it                                                           |
| [server/jobs/](../server/jobs/)                                                               | The runner, and the scripting, narration and build jobs with the enqueue half of each                 |
| [server/providers/](../server/providers/)                                                     | The ports a scripting model, a speech model and an encoder are reached through, and what is behind    |
| [server/epub/](../server/epub/), [import/](../server/import/)                                 | Reading an EPUB, cutting it into chapters, deciding which are notices, assembling a book              |
| [server/audio/](../server/audio/), [covers/](../server/covers/)                               | Where a clip or a cover lives, and reading a clip's format and length off its bytes                   |
| [server/demo/](../server/demo/)                                                               | The seed and `world.ts`; `situations.ts`, `pace.ts`, `reset.ts`, and `live.ts` for what stays running |
| [server/db/](../server/db/)                                                                   | Every query, per area; the client, migrations, statements compiled once                               |
| [server/db/schema/](../server/db/schema/), [rows/](../server/db/rows/)                        | The tables, and the only files that map columns to domain shapes                                      |
| [server/lib/](../server/lib/), [log/](../server/log/)                                         | Errors, validation, request schemas, upload limits, serving a file, background work, zips; the logger |

Three layers, each ignorant of the one above it. A route validates the request, calls one
operation (`server/*/ops.ts`, or the enqueue half of a job) and returns what it got: no route builds
a query, no route holds a rule. An operation states a rule — a volume goes onto a book with nothing
waiting in its review, removing the last volume removes the book, a rename moves every line that
names the speaker — and throws an `AppError` when it does not hold, without knowing what a status
code is; a job or a test calls the same operation and gets the same refusal. Queries live in
`server/db/*.ts` and nowhere else: an operation or a job that needs several writes in one
transaction opens it and calls the `db/` functions inside it. The demo's seed and reset, which write
every table at once, and the ledger ([ledger.ts](../server/usage/ledger.ts), whose header says why)
are the exceptions, and `.oxlintrc.json` refuses `drizzle-orm` or `~/db/schema` imported anywhere
else under `server/`. Dependencies point from the jobs to the domain: a job imports the rules it
runs by (`server/narration/chapter.ts`, `server/script/chunks.ts`), and no operation imports a job
for them. Above `rows/` everything works in the shapes [`@/types`](../src/types) defines — the same
domain model the frontend uses. So do the answers: what a route replies with, where it is more than
one domain type in a wrapper — a run queued, a script and its revision, the lines a rename moved — is
declared once in [src/types/api.ts](../src/types/api.ts), returned by the operation and checked at
the route with `satisfies`, and the page's services read the same type, so a field renamed on one
side is a type error on the other rather than an `undefined` on the page.

## Importing an EPUB

Import → review contents → add. A book arrives marked `importing`: the library does not list it,
nothing runs on it, and the review works on it in place — the same review the book keeps
afterwards. Confirming clears the mark. **Nothing is skipped by the import itself.** Chapters that
do not look like story get a note attached; a person decides. That division is the whole safety
argument for guessing at all, because it makes a wrong guess cost a click instead of a missing
chapter. Numbering is continuous across a book's volumes, because script keys, job records and
export entries are all keyed by a chapter number that has to stay unique within the book.

Things the parse is deliberate about:

- **The conversion is Turndown's, not ours.** Turning arbitrary publisher HTML into readable text
  is a long tail a widely used converter has met far more of than this project ever will.
  [markdown.ts](../server/epub/markdown.ts) configures it; [text.ts](../server/epub/text.ts) keeps
  only what no converter can do, which is cutting a file into chapters before anything converts it.
- **HTML's named entities are made ones XML knows.** A chapter file is XHTML, parsed as XML, which
  knows five names; `&nbsp;`, `&mdash;` and `&hellip;` are the DTD's, which no parser here reads, so
  they would arrive as text for the narrator to spell out. [entities.ts](../server/epub/entities.ts)
  replaces each HTML name with the numeric reference for the same character before a section is
  parsed, using the `entities` package's table.
- **The navigation is waited for.** `open()` resolves as soon as the package document is parsed;
  the navigation document is a second file still being fetched. Read too early it is absent, every
  chapter quietly falls back to its own heading, and the result usually looks close enough to be
  believed. It is awaited on its own rather than through `book.ready`, which also covers the cover
  image — a book with no cover has a perfectly good table of contents.
- **Navigation links are resolved against the navigation document**, which may sit in a directory
  of its own, so `../text/c1.xhtml` and `text/c1.xhtml` are the same file. Both halves are also
  **percent-decoded**, a path segment and the fragment each on its own, because the manifest and the
  navigation are often written by different tools and only one of them remembered that
  `Chapter%201.xhtml` is `Chapter 1.xhtml`.
- **Sections are unloaded as they are read.** A web-novel volume can be a thousand chapters, and
  holding every parsed document at once is how a routine import becomes an out-of-memory crash.
- **The navigation document, non-linear spine items and links out of the book are not chapters.**
  A spine item with a scheme (`https:`), a protocol-relative `//host/…`, or a `..` that climbs above
  the root of the zip names something beside the EPUB rather than in it. A file inside the zip that
  is merely missing is still a chapter, and an unreadable one.
- **Tables are kept, not dropped.** A `<table>` in a novel is as often prose as data — a character
  list, a release timetable, a paragraph an old conversion laid out in cells. They are stored as GFM
  tables and read out a row at a time. `aside` and `nav` are dropped: a sidebar the narrator is not
  reading, or the table of contents itself.
- **A figure is kept; a picture is not.** Publishers set epigraphs, poems and letters in `<figure>`
  as often as pictures. Images are dropped by a rule (Turndown's own image rule runs before its
  remove list, and would write an empty image reference into the stored text), and so is the
  `<figcaption>` of a figure that holds a picture; the caption of one that holds words is kept.
- **The cover is kept, as a file.** The package names its cover the EPUB 3 way (the manifest item
  marked `cover-image`) or the EPUB 2 way (`<meta name="cover">`). A new book keeps it when it is a
  JPEG or a PNG of at most 10 MB, sniffed from the bytes rather than taken from the manifest, in
  `<AUDIO_DIR>/<bookId>/covers/` under a hash of its contents
  ([server/covers/files.ts](../server/covers/files.ts)); the book's `coverImage` is the address it
  is served from, under its library's base. Anything else leaves the book without one, and the log
  says why. A volume added later does not bring its cover: that is another edition's as often as
  the same one.

### One file, several chapters

Most web-novel EPUBs pack several chapters into one XHTML file, with the table of contents pointing
at an anchor inside it. One chapter per spine document is not a cosmetic loss: a release notice
bundled between two chapters cannot be skipped without taking the story either side of it with it.

So a section is cut where the navigation says a chapter begins, and **only at the shallowest level
that reaches that document**. A serial listing twenty chapters of one file side by side has them all
at the top level and each is a chapter; a novel listing scenes underneath a chapter has the chapter
above them, and the scenes are not chapters. Reading the deepest level instead would turn the second
book into a hundred one-page chapters. A **container** is not one of those levels: an entry that
names a whole document and has the navigation pointing at places _inside that same document_
beneath it — "Volume One", with Chapters One and Two anchored under it — is the heading over those
chapters, and its children are the boundaries instead.

Cases the cutting has to be right about:

- **An anchor named by `name` rather than `id`** — `<a name="ch3" id="calibre_link-7">` — is found
  by either attribute.
- **An anchor the file does not contain** produces no chapter. Its text stays with the chapter
  before it — not lost, which is the safe direction to be wrong in.
- **Text above the first anchor** that no entry claims is the file's own front matter, and reads as
  the opening of the chapter that follows it rather than a chapter nobody named.
- **A cut through an inline element** reopens it: a chapter that begins halfway through an `<em>`
  keeps the emphasis on both halves. A block wrapper is not reopened — splitting a paragraph is
  meant to end it.

### A chapter the file could not supply

One section that will not render is not a reason to lose the other nine hundred, so it arrives as a
chapter carrying a note of kind `unreadable`, verdict `review` — **one for each chapter the
navigation says was in that file**, not one for the file, so a damaged file holding three chapters
is three chapters to answer for. It is the one case where the review has to speak up rather than
guess: narrating it would produce silence, and skipping it by default would quietly drop a chapter
nobody has looked at. An empty chapter and a lost one look identical once the text is gone, which is
why the difference is recorded rather than inferred. If **every** section fails, the import is
refused: an EPUB with no book in it is not a success.

### What an upload unzips to

The upload limit is on the zip, and a zip can be a thousand times smaller than what it holds: an
80 KB file with one 80 MB chapter took a gigabyte and a half and seventeen seconds to import, with
nothing else served meanwhile. So [archive.ts](../server/epub/archive.ts), through the zip guard in
[server/lib/zip.ts](../server/lib/zip.ts) that the script import shares, reads the archive with
yauzl before the EPUB library sees it, and refuses — a 413, `too_large` — one that unzips to more
than `MAX_UNZIPPED_MB` in all or holds a document (a chapter file, the package, the navigation) over
`MAX_DOCUMENT_MB`. Pictures are held only to the total: they are carried, not parsed.

**The sizes are trusted because they are checked.** A zip states each entry's size, and it can lie;
jszip, which the EPUB library unzips with, believes it. yauzl fails an entry the moment its data
runs past what it declared, so every entry is inflated once, a chunk at a time, and an archive that
gets through is exactly as big as it said. One that lied is refused as unreadable. An entry that
merely will not inflate is let through, to become an unreadable chapter.

A refusal says _why_. The parser can only report what stopped it; EPUBCheck, through
[diagnose.ts](../server/epub/diagnose.ts), reports what is wrong with the file — `RSC-001:
Referenced resource "c2.xhtml" could not be found (OEBPS/content.opf line 12)` — and that lands in
the `detail` the UI expands to. It runs **only on a failure, never as a gate**, and never on a size
refusal, which it would unzip whole again. Plenty of real books are technically non-conformant and
read perfectly well, this project's test fixtures among them; refusing one because a validator
disliked its metadata would turn a working import into a support question.

### The stored form is Markdown

`chapter_texts.body` holds the chapter as Markdown: headings, `*italic*`, `**bold**`,
`***both***`, list items, inline links and GFM tables. It is kept at all because import is the last
moment it exists — the EPUB is not retained, so anything dropped here is gone for good.

Markdown in the string rather than structure beside it, because **the string is going to move**.
Lines are edited, split and joined all through scripting, and a character range recorded against the
text points at the wrong words after the first edit — silently. Markup survives anything that moves
the string. Italic and bold stay apart because the file kept them apart: a narrator may end up
treating them alike, but that is a decision narration can make later from the distinction, and
never one it can make back. Stress written as styling counts too — `<span style="font-style:
italic">` is how a good share of real EPUBs mark a word, and Turndown's own rules match only `<em>`,
`<i>`, `<strong>` and `<b>`. A span inside the emphasis it repeats is not marked twice.

There are two readers, and they want different things. The contents review wants the Markdown, so a
timetable is shown as a timetable. A model or a speech provider wants it gone: sent the stored form,
a model is charged for a link's address and a table's pipes, and a speech provider reads them
aloud. So the chapter-text route serves both and says which it gave:

```
GET /api/books/:id/chapters/:n/text                 → { text, format: "markdown" }
GET /api/books/:id/chapters/:n/text?format=plain    → { text, format: "plain" }
```

Anything unexpected in `format` is a 400 rather than a guess, because guessing here costs money.
Two functions in [markdown.ts](../server/epub/markdown.ts) do the work, and everything downstream
uses one of them rather than a regex of its own:

- `plainText(body)` — the prose, with no Markdown in it at all. **Anything that counts, bills or
  speaks a chapter reads this, never the column.** A table becomes `Day, Chapter` a row at a time; a
  horizontal rule a paragraph break; a header row the file never gave is left out.
- `parseEmphasis(body)` — the prose and where the stress falls, as `{ at, to, mark }` ranges that
  may overlap, offsets into the prose **as returned**.

Both run markdown-it over the stored text rather than stripping punctuation somebody remembered. It
is not the `marked` the frontend draws with: under Bun, `marked`'s lexer slows with the length of
the document — 4,000 paragraphs took 30 seconds — and a single-file novel is one chapter of that,
read on import and again by every count, bill and speak. markdown-it reads 64,000 paragraphs in
under 300 ms.

### Turndown chooses its DOM once, and can choose wrong

Worth knowing before touching [markdown.ts](../server/epub/markdown.ts). Turndown decides its HTML
parser once, when the module is first evaluated. With no `window` it uses the `@mixmark-io/domino` it ships with and is tested against. With a
`window` carrying a `DOMParser` it takes that instead — and this project has both halves of the
trap: the frontend tests install a small `window` stub, and importing `@likecoin/epub-ts/node`
registers linkedom's `DOMParser`. Bound to linkedom, the table plugin stops matching and a table
collapses to `DayChapterMondayCh 1` — silently, and only in some import orders. So Turndown is
loaded through `withoutWindow`, which hides `window` for the one moment that decision is made; it
is a named, exported function because the load is cached once per process, and a bracket nobody
can re-enter is a bracket nobody can test. Turndown is also given HTML **strings**, never the
linkedom nodes the splitter already has: a foreign node skips its parser and loses tables the same
way.

### Which chapters are notices

A web-novel EPUB carries the author's announcements inline with the fiction: hiatus notices, release
schedules, vote reminders, afterwords. Narrating them produces an audiobook that stops mid-arc to
ask the listener to vote on a website. [server/epub/notices.ts](../server/epub/notices.ts) reads
each chapter and decides. It weighs length, dialogue, links, whether the text addresses the reader,
and keywords for each kind, and the `evidence` it attaches is what it actually saw. Its word count
is the one the import puts on the chapter: a count that split on whitespace would read a chapter of
Chinese prose as a single word, and suggest skipping it.

Three of its verdicts are `review` rather than `skip`, all about not losing a chapter: **a full
chapter with a note stuck to one end** (the note is marked at `start` or `end` and the chapter stays
in); **a chapter only titled like a notice** — "Author's Note" over two thousand words of dialogue;
and **a chapter the file could not supply**, which reaches the reader through the same review so
there is one place to look before trusting a book's contents. A notice repeated later in the book
is marked `duplicate` and names the chapter it repeats.

### Four things the EPUB library does on import

[@likecoin/epub-ts](https://github.com/likecoin/epub.ts) is the parser, through its documented Node
entry point. Its behaviours worked around in [parse.ts](../server/epub/parse.ts):

- **The globals.** It takes any `window` at all for a complete browser one
  (`window.requestAnimationFrame.bind(window)`), so it throws on import where a frontend module has
  installed a small `window` stub; and importing it installs linkedom's `DOMParser` **and** a global
  `document`, a server process announcing itself as a browser to anything that branches on
  `typeof document`. So the library is loaded explicitly rather than by a top-level `import` — both
  fixes have to bracket the import itself — and both globals are put back the way they were found.
- **Unhandled rejections.** A file that cannot be unzipped rejects every deferred promise a `Book`
  holds, and nothing awaits most of them; they are settled with a no-op handler before the open. And
  `unpack` calls `loadNavigation(…).then(…)` with no catch, so an EPUB declaring a navigation
  document it does not contain rejects promises nothing outside the library holds, though every
  chapter is readable. `loadNavigation` is shadowed **on the instance** and settled as "no
  navigation", the library's own behaviour for a book that declares none.
- **The console.** It `console.error`s full stacks when it turns every manifest asset into a blob URL
  (an image the zip lacks) and when the spine's content hooks edit a section's head (a section that
  has none). Neither is needed — sections are read through `readSection`, and the converter drops
  the head — so the book is opened with `replacements: "none"` and the content hooks are cleared,
  which removes the output at its source rather than patching a process-global `console`.

## Logging

`pino`, through [server/log/](../server/log/). A person at a terminal gets columns; anything else
gets JSON, decided by whether stdout is a terminal and overridable with `LOG_FORMAT`. `LOG_LEVEL`
sets how much; `NO_COLOR` and `FORCE_COLOR` work as usual. Every line names the library it came
from.

**The redaction list is why this is a module and not a bare `pino()` call.** The server holds
provider keys, and a key that reaches a log line is in a file, a scrollback and possibly a log
shipper. `redact` covers the shapes one actually arrives in — `apiKey`, a key or a token on its own,
inside an object that was spread into the record, in request headers — so it cannot leak through a
`log.info({ ...endpoint })` somebody wrote in a hurry.

- **The formatter is ours** ([pretty.ts](../server/log/pretty.ts)), not `pino-pretty`: the look is
  the entire point of that file, and it keeps the logger one in-process stream with no worker
  thread — which survives `bun build --compile`, where pino's worker transport cannot resolve its
  target.
- **A 4xx is a warning, not an error.** `hono-pino` calls anything with an error on the context an
  `error`, which makes "no such book" and "the database is gone" the same severity.
- **Request headers are not written down.** Method and path, and what came back; not every header,
  which buries the field anybody was reading and drops an `authorization` into the log.

A route logs through `c.var.logger`, which already carries the request; `assign` adds context the
request's closing line picks up too. Tests use a collecting logger from
[tests/support/server.ts](../tests/support/server.ts), so a test can assert on what was written —
and on what was not, which is how [logging.test.ts](../tests/server/logging.test.ts) checks the
redaction rule.

## The HTTP API

`/api` on the same origin (`/demo/api` in a demo tab), so there is no CORS to configure and no base
URL to set. Errors all have one shape — `{ error: { code, message, detail? } }` — where `code` is a
stable name a client can switch on (`not_found`, `conflict`, `bad_request`, `forbidden`,
`too_large`, `unsupported_media`, `range_not_satisfiable`, `upstream` for a provider this server
called, `internal`), `message` is meant to be shown as it stands and `detail` is the longer
explanation a panel can expand to. `ApiErrorCode` in [src/types/common.ts](../src/types/common.ts)
is the one list, and the server imports it.

**All** errors, including the validator's. `sValidator` answers a bad request with its own
`{ success, error, data }` unless told not to, which is a second error contract nobody agreed to;
[validate.ts](../server/lib/validate.ts) is the same middleware with that hole closed, and routes
use it so the contract cannot be opted out of by forgetting a hook. Path parameters go through it
too: a chapter number that is not a whole number is a 400 naming the parameter, rather than
`Number("latest")` looking up nothing and answering 404. A body that is not the JSON it claims is a
`bad_request` in the same shape, not the plain text Hono writes by default.

**Nobody else gets to ask.** The API has no accounts, and a request that deletes a book deletes a
book. It listens on loopback (`HOST`, `127.0.0.1` by default), so another machine cannot reach it.
Another _site_ can still make your browser send it a request — a form post, or a post with no body,
needs no preflight — so Hono's `csrf` check refuses any such request unless the browser says it came
from this origin (`Sec-Fetch-Site`, or `Origin`), with a `forbidden`. A request with neither header
is not from a browser, and is let through: a script on this machine forges nothing.
`secureHeaders` adds the usual set to every response.

**An upload is refused before it is read.** Each upload route takes its limit from `uploadLimit` in
[http.ts](../server/lib/http.ts): an EPUB `MAX_UPLOAD_MB`, a script file — to plan its import or
keep its voice samples — `MAX_SCRIPT_UPLOAD_MB`. Its `body` half answers a body over the limit —
from its `content-length`, or by counting — with a `too_large` before the form is read, and allows
a megabyte more for the multipart envelope; so its `file` half asks the file itself once the form
is read, and a file a byte over the limit gets the same refusal, naming its size. A clone's samples
and a cover have limits of their own. Bun's own ceiling sits a megabyte above the largest of them,
so it is never the one that answers. [security.test.ts](../tests/server/security.test.ts) holds
these refusals.

The client holds up the other end. Not everything that answers `/api` is the API — a proxy or a dev
server in front of it answers with HTML — so [`HttpClient`](../src/services/http.ts) does not assume
the body parses: a `SyntaxError` out of a method whose contract is that it raises `ApiError` would
report a JavaScript fault where it should say the server is unreachable. Every service in
[src/services/](../src/services/) is built on it.

| Method   | Path                                              | Does                                                                                                         |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/health`                                     | Is it up                                                                                                     |
| `GET`    | `/api/books`                                      | Every book, importing ones included, with chapter counts                                                     |
| `POST`   | `/api/books/import`                               | An uploaded EPUB → a book, or one more volume of one                                                         |
| `GET`    | `/api/books/:id`                                  | A book and its chapters                                                                                      |
| `PATCH`  | `/api/books/:id`                                  | Budget, script budget, pacing, prompt or `readNotes`; chapters are re-timed and, for `readNotes`, re-settled |
| `DELETE` | `/api/books/:id`                                  | Remove a book and everything it owns                                                                         |
| `POST`   | `/api/books/:id/confirm`                          | The review is done; it joins the library                                                                     |
| `POST`   | `/api/books/:id/discard`                          | Cancel: an unconfirmed book goes, or its new volume                                                          |
| `PATCH`  | `/api/books/:id/volumes/:volumeId`                | Rename a volume                                                                                              |
| `DELETE` | `/api/books/:id/volumes/:volumeId`                | Remove a volume; the last one removes the book; 409 mid-build                                                |
| `PUT`    | `/api/books/:id/volumes/order`                    | Read the volumes in this order; chapters renumber to follow                                                  |
| `POST`   | `/api/books/:id/covers`                           | A JPEG or PNG for an audiobook's cover → its url                                                             |
| `GET`    | `/api/books/:id/covers/:file`                     | A cover's bytes                                                                                              |
| `GET`    | `/api/books/:id/chapters/:n/text`                 | A chapter's prose, as Markdown or plain                                                                      |
| `POST`   | `/api/books/:id/chapters/skip`, `include`, `keep` | Skip chapters, put them back, or keep a noted one                                                            |
| `POST`   | `/api/books/:id/chapters/decisions`               | Put decisions back exactly as stated; what an Undo sends                                                     |
| `POST`   | `/api/books/:id/chapters/script`                  | Queue a scripting job per chapter, as one run (202)                                                          |
| `POST`   | `/api/books/:id/script-trial`                     | One chunk sent with a draft prompt; nothing written                                                          |
| `POST`   | `/api/books/:id/chapters/narrate`                 | Queue a narration job per chapter, at a scope (202)                                                          |
| `GET`    | `/api/books/:id/chapters/:n/script`               | A chapter's script, and its revision                                                                         |
| `PUT`    | `/api/books/:id/chapters/:n/script`               | Replace the script, naming the revision that was read                                                        |
| `GET`    | `/api/books/:id/chapters/:n/history`              | The chapter's versions and how the script came to be                                                         |
| `POST`   | `/api/books/:id/chapters/:n/history/checkpoints`  | Name the script as it stands and keep a copy (201)                                                           |
| `DELETE` | `/api/books/:id/chapters/:n/history/versions/:v`  | Forget one version; what an Undo of a checkpoint sends                                                       |
| `POST`   | `/api/books/:id/chapters/:n/retakes`              | Another take of these lines, as one job (202)                                                                |
| `POST`   | `/api/books/:id/chapters/:n/lines/:line/verdict`  | Keep or drop a line's retake                                                                                 |
| `PUT`    | `/api/books/:id/chapters/:n/lines/:line/flag`     | Raise or replace a line's flag, naming no revision                                                           |
| `DELETE` | `/api/books/:id/chapters/:n/lines/:line/flag`     | Take a line's flag down                                                                                      |
| `GET`    | `/api/books/:id/cast`                             | The cast and the pronunciation dictionary                                                                    |
| `PUT`    | `/api/books/:id/characters/:name`                 | One speaker, written as stated: new or replaced                                                              |
| `POST`   | `/api/books/:id/characters/:name/rename`          | Rename; every line that names them moves                                                                     |
| `POST`   | `/api/books/:id/characters/:name/merge`           | Fold one speaker into another                                                                                |
| `DELETE` | `/api/books/:id/characters/:name`                 | Remove a speaker; their lines go to the Narrator                                                             |
| `POST`   | `/api/books/:id/characters/attribute`             | Put a speaker back on exactly these lines; an Undo                                                           |
| `PUT`    | `/api/books/:id/lexicon`                          | The dictionary, replaced whole, and the clips it made stale                                                  |
| `GET`    | `/api/books/:id/script-export`                    | The book's script as a file; `?samples=1` carries voice samples                                              |
| `GET`    | `/api/books/:id/script-export/samples`            | Whose recordings the export would carry, and how much                                                        |
| `POST`   | `/api/books/:id/script-import`                    | What importing a script file would do; nothing written                                                       |
| `GET`    | `/api/books/:id/speaker-samples`                  | Recordings a script file brought, waiting with their speakers                                                |
| `POST`   | `/api/books/:id/speaker-samples`                  | Keep them for the speakers named, from the same file                                                         |
| `GET`    | `/api/books/:id/speaker-samples/:s/files/:file`   | One of them                                                                                                  |
| `DELETE` | `/api/books/:id/speaker-samples/:s`               | Discard; `POST …/:s/restore` takes it back within a day                                                      |
| `GET`    | `/api/books/:id/exports`                          | The finished audiobooks                                                                                      |
| `POST`   | `/api/books/:id/exports`                          | Queue a build; the job and the version it makes (202)                                                        |
| `GET`    | `/api/books/:id/exports/:e`                       | One of them                                                                                                  |
| `GET`    | `/api/books/:id/exports/:e/files/:n`              | One of its files, to save                                                                                    |
| `DELETE` | `/api/books/:id/exports/:e`                       | Forget one, and take its files off the disk                                                                  |
| `GET`    | `/api/books/:id/spend`                            | What the book has spent, and what its unfinished work holds                                                  |
| `GET`    | `/api/audio/:bookId/:file`                        | A rendered clip's audio                                                                                      |
| `GET`    | `/api/endpoints`                                  | Endpoints, profiles, credentials, prompt, script settings                                                    |
| `PUT`    | `/api/endpoints`                                  | The whole configuration, in place of what is stored                                                          |
| `POST`   | `/api/endpoints/test`                             | One small request to a saved endpoint with its saved key                                                     |
| `POST`   | `/api/endpoints/voices`                           | A saved endpoint's voices: its library, or a public search                                                   |
| `POST`   | `/api/endpoints/sample`                           | One saved voice, heard: kept, its own recording, or rendered                                                 |
| `POST`   | `/api/endpoints/voices/clone`                     | A voice made from samples on the provider (multipart, 201)                                                   |
| `GET`    | `/api/endpoints/:id/samples`                      | An endpoint's voices with kept samples                                                                       |
| `GET`    | `/api/endpoints/:id/voices/:voice/samples`        | One voice's kept samples; `…/:file` one sample                                                               |
| `POST`   | `/api/endpoints/:id/voices/:voice/samples`        | Keep samples for a voice already saved; nothing sent                                                         |
| `DELETE` | `/api/endpoints/:id/voices/:voice/samples`        | Forget them, keep the voice; `POST …/restore` takes it back                                                  |
| `GET`    | `/api/endpoints/requests`                         | One endpoint's requests, newest first; `?kind&id&range`                                                      |
| `GET`    | `/api/endpoints/live`                             | Each speech endpoint's lines out and held, cooldown, clips done                                              |
| `GET`    | `/api/jobs`                                       | Every job, oldest first; `?bookId=` narrows it                                                               |
| `GET`    | `/api/jobs/:id`                                   | One job, with its activity                                                                                   |
| `POST`   | `/api/jobs/:id/cancel`                            | Stop it: a queued job never starts, a running one stops                                                      |
| `POST`   | `/api/jobs/cancel`                                | `{ ids }`: stop these, in one request — a whole run; `{ cancelled }` says which were live                    |
| `POST`   | `/api/jobs/run-next`                              | `{ ids }`: move these queued jobs ahead of the rest, in their order; `{ moved }` says which                  |
| `DELETE` | `/api/jobs/:id`                                   | Take a finished job out of the history                                                                       |
| `POST`   | `/api/jobs/clear`                                 | Clear the history; live jobs stay                                                                            |

The demo's own routes are [above](#two-libraries-yours-and-the-demo); the script file, its import
and the samples it carries are [script export and import](script-transfer.md). A few bodies worth
knowing:

- `POST /api/books/import` is multipart: `file` is the EPUB, `title` optionally overrides the one in
  the file, and `bookId` with `name` adds the file to an existing book as one more volume.
- `POST …/covers` is multipart too (`file`), kept beside the book's own cover and answered
  `201 { cover }`. It does not change the book's `coverImage`: it is what an export's
  `settings.cover` names, and a build refuses any other `settings.cover` with a 400, since a picture
  this server could never find would otherwise be a build failing halfway.
- `POST …/chapters/script` answers with the jobs it made, the chapters it left out and why
  (`excluded`, `busy`, `missing`), and the book's chapters as they now stand, so the page can say
  "2 already being scripted". The body names the scripting `profile` the page has chosen; see
  [a chapter in chunks](#a-chapter-in-chunks) for one the server does not have, or none. Narrating
  and asking for retakes answer the book's chapters the same way; the operation that queues the run
  reads them, after the jobs have marked theirs `queued`.
- Skip, include and keep are rules that only run forwards — including a noted chapter records that
  it was looked at — so an Undo sends what the chapters were to `…/chapters/decisions`, which puts
  it back as stated, rather than running an inverse rule.
- `GET /api/books` carries each book's chapter counts (`total`, `included`, `scripted`,
  `narrated`), read in one grouped query, so a card can say "12 chapters, 3 scripted" without the
  shelf listing every chapter.
- Every chapter the server lists carries its line counts (`lines`: `total`, `done`, `generating`,
  `failed`, `skipped`), read in one grouped query over the book's clips, so a page can show how far a
  chapter has got without reading its script. The first four count only the lines read aloud;
  `skipped` is the site text and notes the book does not read (`isSpoken` in
  [src/lib/siteText.ts](../src/lib/siteText.ts)).

## Site text and notes

A line can be marked as not the story — `watermark` (a site's boilerplate or anti-scraping text,
never read) or `note` (a translator's or author's note, read only when the book's `read_notes` is
on) — rather than removed, so the word-for-word check on every scripting answer still guards the
story ([docs/scripting.md](scripting.md#site-text-and-translators-notes)). The server holds three
things for it, from migration `0014_site_text`:

- `segments.site_check`, the detector's second opinion on a line's type (`{ suggest, why }`),
  written by the scripting job inside the transaction that writes the script
  ([server/script/siteCheck.ts](../server/script/siteCheck.ts)): signals in the line's own words,
  a line of five words or more repeated in three or more of the book's other chapters, and a
  marked line of over forty words that nothing gives away. An edit that changes a line's type
  drops the suggestion the line had; dismissing one is an edit without it.
- `books.read_notes`, set by `PATCH /api/books/:id`. Flipping it re-settles every chapter not
  being narrated, since which lines need a clip has changed.
- Nothing new for clips: an unspoken line keeps any clip it had, the narration job never sends
  it, and the export leaves it out of the stitch (`heardLines`), so marking a line back as story
  needs no render.

The scripting job logs how many lines a chapter's script marked and how many the detector wants a
person to look at, and warns when the words left out of the audio pass `UNREAD_SHARE_WARNING` of
the chapter — the same figure, counted the same way, that lists the chapter in the review inbox.

## A script edited by a person

`PUT /api/books/:id/chapters/:n/script` takes `{ segments, ifRevision, origin? }`. Two rules hold,
and both are the ones the scripting job keeps:

- **An edit names the revision it read.** `chapters.script_revision` counts every write of a
  chapter's script rows, whoever made it — a job, a person, a rename, a clip landing. An edit whose
  `ifRevision` is not the current one is a 409 and writes nothing, exactly as a job result that
  would land on newer work is refused; the page reads the chapter again and says so. The rule runs
  one way: an edit made while a job is queued is not a conflict for the job, which reads the
  revision when it starts — its script replaces the edit, and the edit is preserved in the history.
- **History is written in the transaction that writes the script.** The working script is preserved
  before the new one replaces it, so a version and the script it preceded cannot disagree about
  which came first. `origin` says what produced the script — a bulk correction, a restore — and an
  ordinary edit needs none.

The rule behind every entry is `planCapture` in [src/lib/scriptHistory.ts](../src/lib/scriptHistory.ts),
applied by [server/db/history.ts](../server/db/history.ts): no entry for an empty script, none for
an operation that leaves the script as it found it, none for a script that is already the newest
entry, and an edit opens a session that later edits join while its last edit is less than
`SESSION_IDLE_MS` old. **A session that comes back to exactly where it began leaves no entry**: an
undo over HTTP is an edit that writes the previous script back, and when that equals the version
the session's first edit preserved, the version is dropped and the head goes back to what it
recorded — the list must never claim an edit that no longer exists. The head remembers which
version is the session's (`script_heads.session_version`), because a checkpoint saved after the
session opened is newer and must stay. Undoing a bulk correction or a restore is still an edit, so
it leaves that entry with an edit after it.

A write that changes nothing a version keeps — a line flagged, a clip that finished — moves the
revision on but leaves the history alone: `scriptSignature` is what a version is. A single line's
flag has a route of its own, `…/lines/:line/flag`, which writes that line's flag and nothing else
and so names no revision: a run landing clips moves the revision on with every clip, and a flag
sent as the whole script while one did was refused as a stale edit and lost. An edit that would
leave a chapter with no lines is refused, since it could not be narrated and would have nothing left
to undo from. A checkpoint names the script as it stands; forgetting the version the head still
names puts the head back to how the script came to be before it was named, which is what an Undo of
a checkpoint asks for, or to the newest checkpoint still in the list.

## The cast

A speaker is keyed by name because the script names speakers by name and nothing else, so anything
that changes a name moves lines in every chapter of the book — in the same transaction as the cast
row. A rename, a merge and a removal each answer with the lines that changed hands, by chapter, and
each chapter's new script revision (`moved`): the page keeps editing without a stale-revision
refusal, and an Undo puts back exactly those lines through `attribute` rather than guessing at an
inverse. A merge folds aliases in and cannot be told apart from ones already there, which is why the
undo is recorded rather than inverted. A line that changes hands has its clip marked stale. The
Narrator cannot be removed, renamed or merged into anyone (each a 409), because a removal hands the
lines to the Narrator by that name. The dictionary is a short list whose order is part of it, so it
is written whole.

The scripting job adds the speakers it turned up to the cast when it writes the script: a walk-on
arrives unreviewed (`isNew`), so the Cast page can merge it; the Narrator arrives as the main cast.
Nothing writes voices, styles or aliases but the page's own requests.

## The queue

A job is a row in `jobs`, laid out to hold the frontend's `Job`. Each rule below has a test in
[jobs.test.ts](../tests/server/jobs.test.ts) that drives it through the real routes and runner.

- **The same work is never queued twice, and the database says so.** While a job is queued or
  running, `jobs.active_key` is `kind:book:chapter`, cleared the moment it finishes. A unique index
  over that column means a double click, a retried request or two tabs asking for the same chapter
  get the same job back — whatever order the requests arrive in, because it is the index that
  refuses, not a check a second request could slip past. The route says which chapters it left out
  for being `busy`.
- **One job at a time.** [runner.ts](../server/jobs/runner.ts) claims the next queued job — the
  highest `priority`, then the oldest — moving it to `running` in the same transaction that reads
  it, and runs its handler to the end before claiming the next, so one book's chapters run in order
  and roster and recap carry forward. An enqueue wakes it; a slow interval is only a safety net.
- **Run next is a priority, not a reorder.** `POST /api/jobs/run-next` gives the queued jobs it
  names one priority above the highest waiting, so a whole run moves as a block in its own order,
  and a later move goes ahead of it. Every job starts at 0, so with nothing moved the queue is
  oldest first. A chapter moved ahead of the one before it is scripted without that one's recap.
- **A cancel is an abort.** A running job's `AbortController` is aborted, the provider sees `signal`
  and stops, and the job is recorded `cancelled` rather than failed; a queued one is finished as
  cancelled without starting. Either way the handler gets the last word (`onSettled`) — which is how
  a chapter marked `queued` goes back to `none` — and the same hook runs when a recovery gives up on
  a job.
- **A handler that returned is done.** A handler honours a cancel by throwing, at the last point it
  can still take its work back — a build checks immediately before the transaction that makes the
  new version current. A cancel after that is too late: calling the job cancelled would have an
  export's `onSettled` delete the version it had just committed.
- **A restart loses no work.** A row still `running` at start is a job the last process died
  holding; it is put back in the queue with an event saying so and starts again — twice in all,
  because a job that takes the process down every time must not be allowed to forever. `stop` (a
  `SIGINT`) aborts the running job and leaves its row `running` on purpose, so there is one recovery
  path, but gives back the start it interrupted (`handBack`), so `attempts` counts crashes only.
- **A result never lands on newer work.** The scripting job reads `chapters.script_revision` when it
  starts and writes only if it has not moved, in one transaction with the write, so a script edited
  while a slow run was working is kept and the job fails saying why. The chapter is found again by
  its **uid** at the moment of writing, so a book renumbered mid-run still gets the script on the
  chapter it was read from.
- **A chapter's status is asked of its script, not remembered.** `queued` when the job is (written
  in the same transaction as the row), `running` with a percentage, and afterwards `done` if it has
  a script — including after a re-script that failed, since the old script is intact — `none` if it
  never had one, and `failed` only when a run meant to give it one could not.
- **Retry is a new request** through the same route, planned again against the book as it now
  stands rather than replayed.
- **The job log is bounded** to the newest thousand events, with `dropped_events` counting the rest.

### A chapter in chunks

A chapter longer than its scripting profile's `maxChars` goes to the provider as several requests,
cut exactly where the Endpoints page's chunk preview cuts it ([chunks.ts](../server/script/chunks.ts)):
`scriptParts` in [src/lib/scripting.ts](../src/lib/scripting.ts), at the profile's `splitAt` and falling down to a
clause, a word, a hard cut, with the source's whitespace kept so the pieces rejoin to the chapter.
The profile is the one the page names in the request's body, read from the saved endpoints when the
run is **queued** and copied onto each job as `scriptRun.profile`, so an edit to it afterwards does
not re-cut a run already waiting. A profile the server does not have is refused before anything is
queued (404, `No such scripting endpoint “…”`): the endpoints live on this server, so a name it
does not know is a mistake to say at once rather than a run of jobs that each fail. A request that
names no profile is queued, and what it is sent to decides — the server's own provider refuses it,
saying to choose one, and a test's fake scripts it.

Up to the profile's `concurrency` requests are out at once. `scriptRun` counts them — `requests`,
`completed`, `active` — for the Queue and the Scripting page; the bar is the chunks' progress
together, so it never runs backwards. The answers are stitched in the chapter's order, whichever
came back first, numbered afresh and written in one transaction. A request that fails stops the
others and fails the chapter — `Request 2 of 5 failed: …` — and nothing is written: half a script is
not a script. Every request is priced into the ledger and held against the book's budget
([what a request costs](#what-a-request-costs-and-what-a-book-may-spend)). A cut can fall between a
line and the "said Mara" that names its speaker; the book's cast goes in every request's prompt so a
chunk read on its own still calls Mara "Mara", and the preview shows where the cuts fall.

## The providers, and where a key lives

A scripting job hands a [`ScriptingProvider`](../server/providers/scripting.ts) a chapter's prose —
the plain reading, never the stored Markdown — and gets back lines with speakers; a narration job
hands a [`SpeechProvider`](../server/providers/speech.ts) one line and gets back audio. Which one
answers is decided per request, by the endpoint's base URL:

- **A simulated endpoint** (`simulated://…`) never reaches the network.
  [The scripting fake](../server/providers/fake.ts) makes a paragraph narration and a quoted span
  dialogue, spoken by whoever the paragraph names beside a speech verb — "…," said Mara — or
  `Unknown`; [the speech fake](../server/providers/fakeSpeech.ts) renders a quiet WAV tone per
  speaker, long enough to say the line, through [simulatedSpeech.ts](../server/providers/simulatedSpeech.ts),
  which also answers its Test button, its six voices and a sample. A simulated endpoint waits its
  `latency` (milliseconds) before each answer and fails its `failRate` (0–1) share as a server error
  worth another try, so a run on it moves, and fails, the way a real one can; the Requests tab edits
  both. It needs no key, and the preset's card is zero.
- **Every other endpoint** is called: a chapter goes to its profile's chat-completions model
  ([endpointScripting.ts](../server/providers/endpointScripting.ts)), a line to the endpoint its
  voice names (`<endpointId>/<voiceId>`).

The tests hand the app the fakes directly ([tests/support/server.ts](../tests/support/server.ts)),
so no test reaches the network whatever it saves. **Nothing about a provider is in the
environment**: base URL, model, timeout, retries and key are the endpoint's, saved with it. The
`.env` variables `SCRIPTING_PROVIDER_URL`, `…_MODEL`, `…_TOKEN`, `FISHAUDIO_TOKEN` and
`FISHAUDIO_VOICE_ID` are read by `pnpm test:live` and nothing else.

**The key is write-only.** It is `endpoints.api_key`, one per endpoint and one per profile (a
speech endpoint and a profile that share an id keep separate keys). `PUT /api/endpoints` takes an
`apiKey` beside an endpoint: left out, the stored key is kept — the page never has it to send back,
so absent has to mean keep — and `""` forgets it. `GET` answers `hasKey: true` and never the key.
The target a request is sent to ([target.ts](../server/providers/target.ts)) reads the key at the
moment of dispatch, so it is never copied onto a job and a key changed on the page is the one the
next request uses. Named credentials are labels only: every endpoint has its own key.

**Around every request** [http.ts](../server/providers/http.ts) keeps the endpoint's `timeoutSec`
per attempt and `maxRetries` after the first, retries only what another attempt could fix (408, 425,
429, 500, 502, 503, 504, no answer — not a 409, which is the same conflict the second time), waits
what a `Retry-After` names or `cooldownSec` after a bare 429, and stops at once on a cancel. A
provider that refuses inside a 200 hands `call` a `check` that reads the answer first, so such a
refusal is retried in the same loop. A refusal becomes a sentence naming the endpoint and what it
said, and a body the attempt's clock cuts off says it timed out. An endpoint that `needsKey` and has
none fails before any request.

### Scripting requests

[chatScripting.ts](../server/providers/chatScripting.ts) speaks OpenAI's chat completions — OpenAI,
a gateway, a local model — at `{baseUrl}/chat/completions`, asking for `{"lines":[…]}` with
`response_format: json_object`, `max_tokens` only when the profile's `maxOutputTokens` is above 0,
and the profile's reasoning level as its host spells it ([src/lib/reasoning.ts](../src/lib/reasoning.ts),
shared with the page). A gateway may wrap the JSON in a code fence anyway; the answer is read from
the first `{` to the last `}`. A **reasoning model counts its thinking against `max_tokens`**, so a
low cap cuts the answer off. Before anything is written, the lines are held against the prose
(`fidelity`): if more than 2% of the words went missing or were invented, the chapter fails saying
how many and which — an audiobook that silently skips a paragraph is the worst thing this job could
do. Word counts, not order, so it catches a dropped sentence but not a moved one. A bad answer is
not retried, so a failure never spends tokens twice without anyone asking.

Beside the lines the answer carries `cast` — gender, other names and a description of the speakers
the excerpt says something new about — and a `recap` of where the excerpt leaves off. Both are read
apart from the lines and item by item, so a malformed entry is dropped and never costs the script.
The job fills the cast in with `learnCast` ([server/db/cast.ts](../server/db/cast.ts)), in the
transaction that writes the script, only where the cast is blank, and keeps the last request's
recap in `chapters.recap` (migration `0015_chapter_recap`) for the next chapter's
`{{previous.recap}}` ([docs/scripting.md](scripting.md#what-a-run-remembers)).

**The prompt** has three layers ([src/lib/prompt.ts](../src/lib/prompt.ts)), described from the
page's side in [endpoints](endpoints.md): the library's default in `settings` under `prompt` (no row
is the built-in one), saved with the Endpoints `PUT`; a profile's notes, replacement and reasoning
level in its row's `prompt_*` and `reasoning_effort` columns; a book's notes and replacement in the
book row's `prompt_*` columns, set by `PATCH /api/books/:id`. Saves are held to the rules the editor
shows (`profilePromptProblems`, `bookPromptProblems`) and refused with a 400 naming the problem.
`enqueueScripting` resolves the layers once and keeps the template on `scriptRun.prompt`, so an edit
made after queueing reaches only later runs; at dispatch each request's tags are filled in and the
locked output format is added after the system prompt. The history version records the prompt's
origin and fingerprint.

**A prompt trial** is `POST /api/books/:id/script-trial` ([server/script/trial.ts](../server/script/trial.ts)):
one chunk sent with draft layers over the saved ones and `lenient` set, so lines that fail
`fidelity` come back rather than being refused. It writes nothing but a ledger row, checks the
book's budget first, answers a provider refusal as a result with `error` (200), and is cancelled
with the request. **Thinking is counted**: ledger rows keep `reasoning_tokens` (null = not
reported) and `reasoning_effort`, and `scriptReasoning` turns an endpoint's latest 20 at its current
level into the thinking-per-input-token share the estimates add to output.

### Speech requests

[endpointSpeech.ts](../server/providers/endpointSpeech.ts) finds which provider the base URL speaks
and hands the line to that provider's wire module. A provider is two files:

- **Its description**, `src/lib/providers/<id>.ts`, shared by the browser and the server: how its
  base URL is recognised, the request line the Connection tab shows, the formats it can be asked for
  (`FormatSupport[]`), how each model takes expression tags, whether it bills a request it refused
  (`billsFailures`), how it clones (`cloning`), and the models its docs name.
  [index.ts](../src/lib/providers/index.ts) is the list, read in order; `compatible` — OpenAI's
  shape, which the local servers copy — says yes to any base URL and is last. The helpers the pages
  call (`isFishAudio`, `ttsRequestPath`, `speechFormats`, …) are in
  [endpointShapes.ts](../src/lib/endpointShapes.ts).
- **Its wire module**, `server/providers/speech/<id>.ts`: the request a line goes out as, how a 2xx
  that is not the audio itself becomes audio, its Test button, its voice list and its clone. The
  registry ([registry.ts](../server/providers/speech/registry.ts)) is a `Record` over the
  description ids, so a provider described and given no wire module does not compile; `simulated`
  alone has none.

What is the same for every provider happens once, around the module. The line is held to the
provider's formats before anything is built (`refuseEncoding`); [send.ts](../server/providers/send.ts)
sends it through `call`, turns a 2xx into a clip ([answer.ts](../server/providers/answer.ts)), and
reports the request to the ledger with its attempts, the usage the answer said it used — handed
over before anything is decoded, so an unusable answer still reports what it cost — and whether it
was billed. A line with nowhere to go — a speaker with no voice, a voice whose endpoint is no longer
configured, a missing key — fails before any request, with the reason. Adding a provider is its
description and a line in the list, its wire module and a line in the registry, and its tests; its
preset goes in [src/lib/presets/speech.ts](../src/lib/presets/speech.ts), with each provider's
`concurrency` set from its own docs for its entry plan.

Each wire module's header cites the docs it was written from. What is particular to each:

- **Fish** ([fish.ts](../server/providers/speech/fish.ts)): `POST /v1/tts`, the model in a `model`
  header, the voice as `reference_id`. The model is held to the ones Fish documents (`s1`, `s2-pro`,
  `s2.1-pro`, `s2.1-pro-free`, `drama-3-preview`), because Fish answers any other with the paid
  `s2.1-pro`. No free-text direction is written in: the job already placed the configured tags.
- **Gemini** ([gemini.ts](../server/providers/speech/gemini.ts)): `generateContent` with the AUDIO
  modality. A 3.8 model is asked for WAV `INLINE`, names the voice as `voiceConfig.voice`, and takes
  the line's instructions as `speechMetadata.style`, because 3.8 reads the text word for word; a
  legacy 3.1 preview takes none of that and answers raw 24 kHz PCM, put under a WAV header.
  `usageMetadata` (text tokens in, audio tokens out) is reported, so a line is priced from Google's
  count. An answer that did not finish with `STOP`, or came back at another rate, fails — billed.
- **ElevenLabs** ([elevenlabs.ts](../server/providers/speech/elevenlabs.ts)):
  `POST /v1/text-to-speech/{voice_id}` with an `output_format` naming the rate and bitrate
  (`wav_24000` by default, which every plan may ask for). No instructions field; `eleven_v3` takes
  audio tags in the text. A whole `character-cost` header is reported as the characters billed.
- **BreezeBlue** ([breezeblue.ts](../server/providers/speech/breezeblue.ts)): ElevenLabs' shape, plus
  an `instructions` field of up to 1,000 characters; a line with more fails before a request.
- **MiniMax** ([minimax.ts](../server/providers/speech/minimax.ts)): `POST /v1/t2a_v2`, answered as
  JSON with the audio in hex. A refusal can arrive as a 200 whose `base_resp.status_code` is not 0;
  the codes MiniMax says to retry (1000, 1001, 1002, 1024, 1033, 1039, 1041, 2045) are sent again,
  the rate limits among them after the cooldown, and any other fails at once, carrying MiniMax's
  code. `extra_info.usage_characters` is reported as billed.
- **Cartesia** ([cartesia.ts](../server/providers/speech/cartesia.ts)): `POST /tts/bytes` with
  `Cartesia-Version: 2026-08-14`, answered with the audio. It reports no usage.
- **Qwen-Audio 3.0** ([qwen.ts](../server/providers/speech/qwen.ts)): Model Studio's
  `SpeechSynthesizer`, answered with a signed link to the audio that is fetched at once, without the
  key, as part of the same request. `usage.characters` is reported as billed. No instructions, WAV
  at 24 kHz only, and requests kept to 600 characters, until more is known about these models.
- **OpenAI-shaped** ([openai.ts](../server/providers/speech/openai.ts)): `/audio/speech` with the
  line's instructions except on `tts-1` and `tts-1-hd`; OpenAI's own API is sent a custom voice,
  `voice_…`, as `{ "id": … }`. It cannot be asked for a sample rate, so an endpoint with one set
  fails its lines before any request rather than rendering at the model's own and reading as drift
  forever after.

What every provider's audio goes through:

- **The format is the endpoint's** (`encoding`: WAV by default, or MP3 or Opus with a bitrate), and
  a clip is kept in the format it came back in — the file's extension is the only record of which.
  A rate or bitrate the API does not offer fails before any request (`encodingProblems`) rather
  than being refused or quietly changed by the provider. Changing an endpoint's format stales
  nothing: it applies to the next line rendered. A simulated endpoint answers WAV only.
- A WAV answer's streamed header claims sizes that are true of nothing (Fish's reads
  `data ffffff00`, about 4 GB); [wav.ts](../server/providers/wav.ts) keeps the samples that arrived,
  in whole frames, under a plain 44-byte header. An MP3 or Opus answer is kept byte for byte.
  [probe.ts](../server/audio/probe.ts) is the one reader of a clip: a WAV by its header, an MP3's
  length by counting its frames (music-metadata estimates the length of an MP3 with no Xing header,
  which is what Fish sends), an Opus by reading to the last page. A 200 carrying JSON, an empty
  body, the wrong container or something unreadable becomes a failure a person can read.
- A line split at `maxChars` is joined per format: WAV end to end, MP3 by laying the parts' frames
  end to end with every tag and Xing/Info frame dropped ([mp3.ts](../server/audio/mp3.ts)). An Opus
  line that would need parts fails before any request: chained Ogg streams are legal, but players
  seek them badly.

### Voices, samples and test requests

**Voices** come from `POST /api/endpoints/voices` `{ id, source, query?, language?, page? }`,
answering `{ voices, total, page, hasMore }` ([voices.ts](../server/providers/voices.ts), which asks
the wire module) with the saved endpoint and key — listing voices spends nothing. A simulated
endpoint answers with the voices it names. For Fish, `library` is every model in your workspace and
`public` one page of Fish's public catalogue, TTS models only; a pasted 32-character id is looked up
directly, and a public voice carries Fish's own recording as `sample: { url, text }` for the Voices
tab to play from Fish's CDN, free. Gemini's and OpenAI's documented voices are answered without a
request; any other OpenAI-shaped server is asked `GET /audio/voices`.

A provider's failure here, in a voice sample and in a clone is answered by one rule
(`providerFailure` in [ops.ts](../server/endpoints/ops.ts)): refused before any request — no key, a
provider that cannot do this — is a `400`; a 4xx the provider answered, other than 408 or 429, is
the request's to fix too and is a `400` carrying what it said; a rate limit, a fault on its side or
no answer at all is a `502` with the code `upstream`. None of these messages carries the key.

**A voice sample** is `POST /api/endpoints/sample` `{ id, voice }`, answering the audio itself with
`x-sample-source` (`recording` or `rendered`), `x-sample-kept` (`1` when nothing was asked of the
provider this time) and `x-audio-duration` when known. It is what every ▶ beside a voice plays, and
it is found in this order:

1. **Kept**: what was played for the voice before, from `heard/` under the library's `VOICE_DIR`.
   Free.
2. **The provider's own recording**, where it keeps one — Fish does, for most voices — fetched only
   from an `https` link on Fish's own hosts. Free, and kept. Fish not having one is not a failure.
3. **Rendered**: the saved endpoint says one fixed sentence (`VOICE_SAMPLE` in
   [endpointShapes.ts](../src/lib/endpointShapes.ts)) in that voice, at the endpoint's format and
   rate, tried once. This is the one that is billed, priced into the ledger against the endpoint
   with no book (`Voice sample · <label>`), and kept before the answer goes back.

A rendered sample is kept under a hash of the endpoint's base URL, model, format and rate and the
sentence, so an endpoint changed in any of them makes its samples again. A simulated endpoint's
tone is never kept. Saving the endpoints removes what was kept for any endpoint no longer among
them.

**Test connection** is `POST /api/endpoints/test` `{ kind, id }`, answering `{ ok, message, ms }`:
one small request to the saved endpoint with its saved key, through the provider its runs go
through. Scripting sends a two-sentence excerpt through the path a chapter takes; each speech wire
module has its own cheapest proof (Fish lists the account's models; an OpenAI-shaped server lists
`/models`). The page writes any edit still waiting first, but not an unsaved connection draft:
saving one can move queued work, which asks first.

### Cloning a voice, and keeping its samples

`POST /api/endpoints/voices/clone` is a multipart form of the endpoint's `id`, the voice's `title`,
and the recordings under `samples`. The provider makes the voice **once**; from then on a line is
spoken with the new voice's id, like any other voice's.

Which providers can clone, and from what, is each provider's `cloning`
([src/lib/providers/types.ts](../src/lib/providers/types.ts)): how many samples, how big, which
formats its docs take, which models it clones for, and what it costs. The route holds the form to it
before anything is read whole: too many samples is a `400`, one over the provider's size (never
above 20 MB, nor 100 MB in all) a `413`, and a sample is what its first bytes say (`sniffSample`) —
WAV, MP3, M4A, Ogg Opus or FLAC, of which the provider takes the ones its docs name; anything else
is a `415` naming the file. How the voice is made is the wire module's `clone`
([speech/wire.ts](../server/providers/speech/wire.ts)):

| Provider   | Request                                                                                                            | Samples                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Fish Audio | `POST /model`, multipart: `type=tts`, `train_mode=fast`, `visibility=private`; Fish transcribes the samples        | 1–20; WAV, MP3, M4A, Opus, FLAC; 20 MB |
| ElevenLabs | `POST /v1/voices/add`, multipart `name` + `files` (Instant Voice Cloning)                                          | up to 20; MP3, WAV, M4A, FLAC; 10 MB   |
| BreezeBlue | `POST /v1/voice-previews/clone`, then `POST /v1/voice-previews/{id}/save` with `language_code=en`                  | 1; WAV, MP3; 5 MB                      |
| Cartesia   | `POST /voices/clone`, multipart `clip`, `name`, `language=en`, `access=private`                                    | 1; WAV, MP3, FLAC, Opus; 16 MB         |
| MiniMax    | `POST /v1/files/upload` (`purpose=voice_clone`), then `POST /v1/voice_clone` with a `voice_id` made from the title | 1; WAV, MP3, M4A; 20 MB                |
| Qwen       | `POST /api/v1/services/audio/tts/customization`, `qwen-voice-enrollment`, the sample as a data URL                 | 1; WAV, MP3, M4A; 10 MB                |

A Qwen voice is enrolled for `qwen3-tts-vc-2026-01-22` and speaks only with it, so an endpoint on
another model is refused with the model to change to. OpenAI's custom voices need its sales team,
and Gemini's voice replication needs a recording of Google's consent sentence besides the sample,
so neither clones here. The route answers `201` with the new voice, with a `warning` when the
provider said to do something before it speaks (ElevenLabs and BreezeBlue may ask for the voice to
be verified).

Making a voice is not idempotent, so each of its requests goes out **once**, whatever the
endpoint's `maxRetries` ([clone.ts](../server/providers/clone.ts)): an upload that timed out may
still have made the voice, and a second attempt would make a duplicate. Its clock is ten minutes
rather than the per-line timeout, and the route lifts Bun's ten-second idle limit for this one
request, which would otherwise close it while the provider works.

**What a clone costs goes in the ledger**, as `cloning.fee` says, against the endpoint and no book
(`settleClone` in [ledger.ts](../server/usage/ledger.ts)). Qwen charges $0.01 as the voice is made,
and the row is appended then; BreezeBlue charges 100 credits then, which counts as unpriced. MiniMax
charges $1.50 the first time a line is spoken in the voice, so the fee waits in `clone_fees` and the
first billed request in that voice appends it and removes the row in one transaction. Fish,
ElevenLabs and Cartesia charge nothing per voice.

**The samples are kept once the provider has answered**, never before, so a failed clone keeps
nothing: the bytes as picked, named by their hash, under `VOICE_DIR` in one directory per voice
([voices/files.ts](../server/voices/files.ts)), with a `cloned_voices` row holding the voice's
title and when they were kept, and a `voice_samples` row per sample, with its transcript
when the form gave one (`transcripts`, one text per `samples` file, in order; Fish's `texts` go only
when every sample has one, Qwen's `text` with its one clip). The voice already
exists on the account by then, so a failure to keep them answers `201` with `samplesKept: false`;
the `voice cloned` log line records the same. `saveEndpoints` reconciles kept samples with the
configuration in its own transaction ([server/db/voiceSamples.ts](../server/db/voiceSamples.ts)): a
voice the configuration holds is attached; an attached voice it no longer holds is marked missing
and keeps its samples for a day, so an Undo that brings it back finds them; a clone the page has
not saved yet is spared for a day, since the clone answers before the page adds its voice. Files go
after the commit, in the background.
[Script export and import](script-transfer.md#kept-when-a-voice-is-cloned) has the rules in full,
and how a script file carries the samples to another library.

## What a request costs, and what a book may spend

**Every request a provider sends is priced and appended to the ledger, answered or not.** A
provider reports each one through its input's `sent` callback ([sent.ts](../server/providers/sent.ts))
— when it went out and came back, its attempts and whether one was a 429, what it used — and the job
settles it with the book, the chapter's uid and a label ([ledger.ts](../server/usage/ledger.ts)).
The price is the page's own engine, `src/lib/pricing/`, imported as it is: `priceRequest` for a
scripting request, `measureSpeech` and `priceSpeechRequest` for a speech one, against the card
stored when the request completed and at the rates in force then. The receipt is frozen on the row,
so a rate changed tomorrow re-prices nothing. What a receipt holds, and why, is in
[pricing](pricing.md).

Which requests count follows what a provider bills. A chat answer the job then refuses — cut off,
empty, not the chapter's — was billed and is priced from the usage it reported; a chat request that
failed on the wire reported none and costs nothing. An answered chat request that reported no usage
was billed for something nobody here knows: its cost is unknown, never $0 — unless its card charges
nothing — and its row keeps in `held` the worst case it held while it was out, which every budget
counts in place of the cost. A speech request reports whether it was billed,
by one rule in [send.ts](../server/providers/send.ts): a 2xx was generated and is billed, even when
what came back proved unusable. A refusal after the retries, a request that never got an answer,
and a refusal inside a 200 are not billed unless the provider's docs say it bills failures
(`billsFailures`, false for every provider so far); such a request is still a row, at nothing, and
its receipt says so. A request refused before it was sent never happened and has no row; nor does
one cancelled mid-flight, since what the provider made of it is not knowable.

**Simulated requests are metered too**, marked `simulated` and priced at the endpoint's card like
any other — nothing on the Simulated preset's zero card, the seeded rates on the demo's endpoints —
so a budget can be run into, tested and shown without a key or a charge.

**A book's budget is enforced here, by one question asked twice.**
[budget.ts](../server/usage/budget.ts) asks whether some work fits: a paused book fits nothing; a
book with a cap fits what keeps _spent + held by unfinished jobs + this_ under it; scripting must
also fit under the script budget. The price asked about is the worst case, because a run lasts long
enough for a promotion to end or a peak to start inside it: for scripting, the dearest rates the
card can reach and the whole output ceiling; for speech, the dearer of today's price and the price
without promotions ([narration/cost.ts](../server/narration/cost.ts)).

- **Before anything is queued**, with the whole run's worst case. A run that does not fit queues
  nothing and answers **409** with a sentence that says what to change — a run, a retry, a retake
  or a prompt trial alike.
- **Before each request goes out**, by the running job, with its own reservation left out of the
  book's total. That only fails when something moved under a run that fitted — a request cost more
  than it reserved, the cap was lowered, the book was paused — and the job stops with the same
  sentence, keeping what it already paid for.

A job holds its reservation in `jobs.reserved`, summed by the gate over unfinished jobs, and gives
it back as the work settles — a scripting job each chunk's share as its request ends, a narration
job each line's as the line is written — so held plus spent never counts the same money twice. A
job holds nothing once it has finished, however it ended: `finishJob` clears the column and the
run's own figure together, so the Queue does not show a cancelled or failed run still holding what
its unsent lines had reserved. A narration job stopped by the budget puts the lines it had not sent
back as they were, rather than failing them. `GET /api/books/:id/spend` answers the sums;
`GET /api/endpoints/requests` answers one endpoint's rows for the Activity list and the charts, each with the number its chapter goes by now.

**An endpoint's daily limit is enforced by the same question, per request.** `spendLimit` is what
one endpoint may be charged since local midnight on the server, across every book; null is no
limit. Spent is the ledger's cost on that endpoint since midnight, and held is what its requests
out right now hold at their worst case — kept in memory (`holdToday`), since only this process
sends and nothing is out after a restart. What queued jobs reserve is not counted: a long run
legitimately spans days, and counting its queued chapters would stop it at its first request.
So a run is refused before anything is queued only when the limit cannot cover even the first
request it sends that endpoint; otherwise each request asks, with its own worst case, before it goes
out, and the one that would pass the limit stops the job the way a book's cap does — what is out
lands and is paid for, nothing more is sent, and the chapter fails with a sentence naming the
endpoint and its limit. A voice sample and a fee charged as a voice is made are billed to the
endpoint, so they are held to its limit too; a connection test writes no ledger row and is not.

## Narration

A narration job is the same kind of thing as a scripting job — claimed by the same runner, cancelled
by the same abort, recovered by the same restart rule — and what it renders is decided by the
functions the page plans with. `POST /api/books/:id/chapters/narrate` takes chapter numbers and a
scope, and `narrationTargets` in [src/lib/runPlan.ts](../src/lib/runPlan.ts) decides which lines it
covers: the lines with no usable clip and the ones whose clip the script has moved past (`fill`),
only the failed ones (`failed`), or every line (`all`). A chapter with nothing in the scope is left
out and the route says so (`nothing`), beside `unscripted` and the reasons scripting has. Each line
goes to the provider with its text, its speaker's voice — their own, else the book's Character
voice, else the Narrator's (`speakerVoice` in [src/lib/cast.ts](../src/lib/cast.ts)) — and its
direction, and comes back as audio with a duration.

**A line is sent what the dictionary makes of it.** `speak` in [src/lib/speech.ts](../src/lib/speech.ts)
applies the book's dictionary as each line goes out, so a term added mid-run reaches every line not
yet sent. The clip records what it was sent — `pronounced`, and `said` with the number of
substitutions (`lex`) when that differs — because the drift rule compares `pronounced` against the
dictionary as it now stands. `PUT …/lexicon` marks stale, in the same transaction, every rendered
clip the new list would send different words for, and answers with those lines and their chapters'
revisions (`stale`); a clip that was out when the list changed is checked as it lands. An Undo sends
the old list with the lines the change reported (`restore`), and only those whose clip matches again
go back to `done` — a clip stale by a rename would match too, and is not the dictionary's to clear.

**A line carries its tags, at its endpoint's rate.** The handler reads the speaker's endpoint from
the stored configuration as each line goes out and hands it to `expressionPlan` in
[src/lib/expressions.ts](../src/lib/expressions.ts): the words after the dictionary, with each tag
written in as that endpoint spells it. The clip records the plan (`expressionSignature` and the tags
sent) so the drift rule compares like with like. A line whose tags the endpoint cannot say is failed
before any request, with the reason; the others are sent. The endpoint's `sampleRate` (16–48 kHz;
none means the model's own) goes with the request, and the clip records the rate the file came back
at, read from the file, so a provider that ignored the request cannot make the record lie. A clip
that lands after the dictionary or the endpoint was saved under it lands `stale` if the book would
now send other words, other tags or another rate.

**A line longer than its endpoint takes goes out in parts** ([parts.ts](../server/narration/parts.ts)),
cut by `expressionParts` at the
endpoint's `splitAt`, falling down to a clause, a word, a hard cut, with every tag protected so a
laugh is never sent as half a token. Each part is its own request, in order, holding the line's one
slot, and the audio comes back as one file with nothing between the parts, because the cuts fall
where the reading already pauses. Parts that disagree on rate, width or channels fail the line
rather than play at the wrong pitch. The clip records `parts`, `splitAt` and `cuts` for the render
details and the Queue's badge; a part that fails fails the line with `error.part`, and the parts
before it are thrown away rather than kept as half a line. A failed clip's `error.code` is the
status the provider answered — the failing part's, for a line in parts — so a 503 after its
retries is told apart from a line that was never sent (0).

**Lines go out as their endpoint will take them.** Every line asks the speech gate
([server/providers/gate.ts](../server/providers/gate.ts)) for a slot on its speaker's endpoint, in
the chapter's order: up to the endpoint's `concurrency` at once, none while it is paused, none while
it is cooling down after a rate limit. The gate is one per library, because the limit is the
provider's, and reads the endpoint's limits every time it looks, so a concurrency raised or an
endpoint paused mid-run changes what the next line does. **A paused endpoint holds its lines** —
they stay `queued`, and the job says once that it is waiting — which is what separates Pause from
Cancel; since the runner runs one job at a time, a pause holds the queue behind it too. **A rate
limit is the endpoint's**: the request that met it waits its `Retry-After` (or `cooldownSec`), and
the gate holds every other line for that endpoint until the same moment rather than letting them
walk into the same refusal one by one. A budget that stops covering the next line stops anything
more going out and lets the lines already out land and be paid for. What the gate has seen is the
process's own, never stored; `GET /api/endpoints/live` answers it, with the clips each endpoint
rendered that the library plays beside it (`done`, `failed`) — counted from the stored clips, across
every book, so unlike the rest they survive a restart.

**An endpoint that takes batches is sent batches** ([batch.ts](../server/narration/batch.ts)). A
speech server that answers the
[batch speech API](speech-batch-api.md) says so at `GET …/audio/speech/capabilities`, asked once per
endpoint as a run starts and remembered for a few minutes. Its lines then go in batches: each batch
takes one of the endpoint's slots at the gate and is filled, in the chapter's order, up to the items
and characters the server said it takes; a line longer than an item goes as its parts. The answer is
a stream of JSON lines in whatever order the server finishes, and each line lands on its own — its
own clip, its own ledger row per item, its own failure. A line goes into a later batch, up to the
endpoint's retries, only when nothing has retried it yet: its item came back failed and worth
another try, or the stream was cut off before reaching it (`BatchCut`). A batch the server refuses
whole is retried by `call`, as any request is, and its lines then fail with the status it answered —
sending them again in another batch would try each line (1 + retries)² times
([narrationBatch.test.ts](../tests/server/narrationBatch.test.ts) counts them). An endpoint that
does not answer, or whose model does not batch, is sent one line at a time; hosted providers and simulated endpoints are never asked. The fake batches too when
a test asks (`batch` in `fakeSpeechProvider`), answering last item first so nothing passes by
assuming order.

**The endpoints are saved whole.** `PUT /api/endpoints` takes what the Endpoints page holds and
keeps exactly that in place of what was stored, in one transaction
([server/endpoints/ops.ts](../server/endpoints/ops.ts)), refusing it whole when two endpoints of one
kind share an id, an endpoint has two voices, tags, windows or promotions under one id, or names a
credential that is not in the list. A profile's row is kept under `scripting:<id>`, since a speech
endpoint and a profile may share an id and a voice names the speech endpoint's. The same document
carries the library's scripting prompt and the script settings — the profile runs go to, and the
switches beside it; a write that leaves either out keeps what is stored, so a save from a page
that never showed them cannot reset them, and a read names only a profile that is still saved. Nothing already
rendered is touched by a save: a clip records what it was rendered with, and the drift rule finds
what a change reaches.

**Nothing usable is thrown away to make room.** A line that already has a playable clip renders its
replacement beside it, in the `candidate` role, and the clip in the book keeps playing until the
replacement lands, when it takes over and the displaced clip joins the take list: a re-narration of
a finished chapter must not leave it silent for the length of the run. A replacement that fails
leaves the clip alone, and the line reads as failed. A chapter's status is asked of its clips
(`chapterNarration`): `done` when every line is rendered, `stale` when one has been edited since,
`failed` when a line has no usable clip after a run that should have given it one, `none` otherwise.

**A retake waits for a verdict.** `POST …/chapters/:n/retakes` queues one job for the lines named
([server/narration/ops.ts](../server/narration/ops.ts)): their clips are written `queued` in the
transaction that creates the job, into the slot a run would choose (`queuedSlot` in
[server/narration/chapter.ts](../server/narration/chapter.ts)), and the handler renders exactly
those, as candidates that do not take over. A job keeps the scope it was queued at on
`narrationRun.scope` — `pending` for a retake's — rather than reading it back from the label the
Queue shows; a job queued before the scope was kept is read by its label.
`POST …/lines/:line/verdict` keeps the candidate or drops it, and both settle the chapter the way a
run does, since a chapter's length is asked of the clips that play.

**A clip is a row of the script, so writing one moves the script's revision.** A page holding a copy
read before the clip landed would otherwise write that copy back — its stale `queued` status
included — over the clip the server just rendered. Instead the edit is refused with the 409 the page
already handles. With the queue polled while a job runs, the page's copy is almost always fresh.

**The audio is a file the server keeps.** `AUDIO_DIR` holds one directory per book and one file per
clip, named by a random token rather than by the chapter's number, because a renumbering must not
move files; `clips.url` is `/api/audio/:bookId/:file`. The route serves nothing whose name is not a
token it could have made, so there is no path a request can build to a file that is not a clip.
Removing a book removes its directory; removing a volume removes the clips its chapters rendered.

## Export

Building an audiobook is the third kind of job, and the one about a book rather than a chapter — its
`chapterId` is null, so its dedupe key is `export:<book>:book` and a book builds one audiobook at a
time, because a build reads every clip another build might be replacing. The page's side is
[export planning](exports.md).

**The plan the page drew is the plan that is written.** `planOf` in
[src/lib/exports.ts](../src/lib/exports.ts) turns the selection, the volumes and the settings into
the output files, their order, chapters and names, and the handler lays down exactly that: a second
copy of that rule is how a preview and a file stop agreeing. `reviewOf` is asked the same way, so a
chapter with no usable audio, one still being narrated, or a stale one the build was not told to
accept is a **409 in the page's own words**. A build refuses rather than trimming — unlike a bulk
narration run — because a chapter quietly missing from an audiobook is the failure this page exists
to avoid.

**An update copies what has not moved.** A finished export records where each chapter's audio sits
inside its file (`export_chapters.byte_start` and `byte_length`). When the next version is built
with the same output settings, a chapter whose signature has not changed is copied straight out of
the version on disk; `reusedChapters` decides which, the same function that drew "191 of its 196
chapters would be carried over" on the page. Each span is checked again as the build runs, so a
chapter re-narrated since, or a file removed behind the server's back, costs that one chapter its
shortcut: a `carry` part brings the chapter's clips along as `instead`, and an encoder that finds the
file gone lays those down and marks the chapter `readAgain`. `exports.encoder` records what wrote a
version, and only the same encoder copies out of it, because a span is bytes into a WAV and
milliseconds into an AAC stream.

**The version on disk stays current until the new one lands.** The row goes up as `building` at
once; the export it supersedes is marked `replaced` by the write that finishes the new one. A build
that fails keeps its row and its reason, which Retry reads; a cancelled one leaves nothing behind.
Either way the half-written files go and the audiobook already there is untouched. A build the
process died holding is re-queued like any job, and clears what the dead run left before writing
its own.

**The files are the server's, like the clips.** `EXPORT_DIR` holds one directory per book and one
file per output file, named by a token — two versions of one audiobook have the same name, and a
rebuild must not write over the version still playing. They are kept apart from the clips because
a clip is an input the next build reads again and an audiobook is the deliverable. A download is
addressed through the export that owns it (`…/exports/:e/files/:n`), so there is no path a request
can build to a file this book did not produce; the name goes back on in `content-disposition`, as a
UTF-8 `filename*` with an ASCII stand-in, since the header is Latin-1 and a title is not. A
superseded version keeps its file until it is forgotten.

**A book's id is ASCII, and so is every path it names.** [http.ts](../server/lib/http.ts) holds the
one pattern the file modules accept, and `slugify` makes only what it allows: accents come off
(`Pokémon` → `pokemon`), the Latin letters with no base letter are spelled out (`ß` → `ss`, `æ` →
`ae`), an apostrophe is dropped and anything else separates words.

**A book's work stops before the book goes.** A narration or a build still running writes into the
book's directories as it goes, `mkdir` and all, so `removeBook` cancels every live job of the book
first and waits for the one running (`runner.finished`), letting its `onSettled` clear what it half
wrote while the rows it needs are still there. Only then do the rows and the directories go.
**Removing files is never waited for, and never fatal**: a rejected promise nobody holds is an
unhandled rejection, which Bun exits on, so every removal goes through `inBackground` in
[background.ts](../server/lib/background.ts), which logs a failure as a warning.

**Both are served a part at a time.** A clip and an audiobook — and a cover or a kept voice
sample — go out through `serveFile` in [serve.ts](../server/lib/serve.ts): a 404 in the API's words
for a file that is not there, a cache kept for good for a name that is the bytes' hash, and an
answer to `Range` — Bun does not, for a `Response` built in a fetch handler, and a player that
cannot ask for a part cannot seek. One range inside the file is a 206 with its `Content-Range`; a
range past the end is a 416 carrying the size; a malformed header, another unit or several ranges
get the whole file, which a server may always send. `range-parser` reads the header, and the length
is set outright so a `HEAD` reports it too.

### The encoder, and what it will not pretend

An [`AudiobookEncoder`](../server/providers/encoder.ts) is handed a list of parts — a clip, a run of
silence, or a span of a file this export supersedes — and answers with the file it wrote, how long
it really plays, and where each chapter landed. It declares what it can do, because the Export page
makes promises an encoder may not be able to keep: `markers`, `normalizes`, `carries`, `covers` and
`tags`. What it cannot do, the job's log says. Which settings each one honours, from the page's
side, is in [encoders and formats](exports.md#encoders-and-formats).

`EXPORT_ENCODER=wav`, the default, needs nothing installed: the
[stitcher](../server/providers/wavEncoder.ts) joins the clips into a real WAV per output file, with
the book's pacing inside a chapter and the export's gap between two, so a fresh clone, a CI run and
the test suite all build something that plays. Rather than name a file `.m4b` that is not one, it
writes `.wav`. It reads and checks every source file's RIFF header rather than assuming the fake's
format, so a provider answering at 24 kHz or in 16-bit stitches correctly and one that changes
format mid-chapter is an error naming the file.

Neither encoder resamples, so one output file holds one rate: the build checks the rate each clip
recorded before anything is written, and names the chapter that brought a second rate. A pause is a
whole number of sample frames (`silenceBytes`), never a byte count rounded from seconds: at 16-bit,
an odd number of bytes of silence puts every sample after it a byte out of step, which plays as
noise to the end of the file.

`EXPORT_ENCODER=ffmpeg` is the one thing in this server that depends on something outside the
process, so it is checked at boot: a server configured for it with no runnable `FFMPEG_BIN` refuses
to start, naming the binary, rather than queueing work that was always going to fail. It reports
`carries: false`, because splicing an already-encoded span beside audio encoded in this run needs
both to have been encoded identically — a file per chapter joined with `-c copy`, which is a
different arrangement on disk from the one this server keeps. It copies the cover in untouched as
the attached picture; a chosen image gone from disk fails the build, and the EPUB's cover gone
missing is a warning. It writes the book's details with `-metadata`, whose generic keys ffmpeg
spells as ID3v2.3 frames in an MP3 and iTunes atoms in an M4B: the file's own title, the book's
title as the album so a set groups as one book, the author as artist and album artist, the narrator
as composer — where Apple's and Audiobookshelf's readers look — the series as the grouping, the
description as both `comment` and `description`, a track or disc number per chapter or volume file,
and `stik` 2 on an M4B so a phone files it with its books. A blank field is left out. With
normalisation on it levels each file to the export's target in two EBU R128 passes, and the job's
log records what the file measured before it was levelled (`-21.4 LUFS in, levelled to -18`): the
one figure the Export page cannot know until a build has read the audio.

## How the screens use it

Every service in [src/services/](../src/services/) talks to the tab's base, so no page and no store
has a demo branch of its own. Reads are queries, through [Pinia Colada](https://pinia-colada.esm.dev):
one composable per resource in [src/queries/](../src/queries/) — a chapter's text, script and
history, a book's cast, exports and spending, an endpoint's requests and live state, and the queue.
What a person edits a query installs into the store that owns it, so the stores stay the working
copy every page reads and every edit acts on; what nobody edits in the browser — the queue, the
spending, the audiobooks, the live state — stays in the query cache, where the stores' getters read
it. `main.ts` turns re-reads on focus and reconnect off, because what
changes a script or a cast is a request this app made, and each one invalidates what it changed by
key.

The queue is the one thing that moves on its own. `useBookJobs` is one shared query the shell keeps
open, polling through the auto-refetch plugin while a job is queued or running. A job that moved has
its book read again; a finished scripting job has its chapter's script and history and the book's
cast invalidated; a narration job that moved has its chapter's script read again, which is how clips
appear one by one; an export job has the book's exports read again; every move reads the book's
spending; and while narration runs, the speech endpoints' live state is read too. Queueing, cancel,
remove and clear are requests, and nothing is marked locally first — a cancel that failed to reach
the server must not look like one that worked. A run the budget refuses comes back as a 409 whose
sentence the toast shows.

Editing is write-behind. Every edit in [scripts.ts](../src/stores/scripts.ts) acts on the store at
once and ends with `_commit`, which writes the chapter's script as it now stands with the revision
it was read at; writes for one chapter are serialised and coalesced, and a batch commits once under
its own name. A refused write reads the server's script and history back with a toast saying so —
through the chapter's query entry, made again if it has gone (`fetchScript`), because invalidation
only refetches entries it finds, and a chapter whose page has closed may have none. A read of the
chapter that lands while an edit of it is being saved is put off until the save has landed. A revision is never taken backwards,
whichever answer lands last. The history is the server's; an edit's answer carries the history it
added to. The cast store's changes are requests with an exact undo, and an undo of a restore writes
the script back before taking the restore's speakers off the cast, since a removal while the
server's script still names them would move their lines and refuse the write.

**Money spent is the server's figure.** The jobs store's `spent`, `reserved`, `scriptSpent` and
`scriptReserved` answer from `GET /api/books/:id/spend` (`useBookSpend`, `useLibrarySpend`); the
Endpoints page's Activity list and charts read `GET /api/endpoints/requests` (`useEndpointHistory`).
Estimates are the page's, worked out with the same `src/lib` functions the server prices with, and
the server is the authority: it refuses before queuing and stops a running job before a request
that no longer fits.

## Tests

[tests/server/](../tests/server/) runs against the real routes, the real schema and the real queue,
each test on a private in-memory database copied from one migrated once per file
([tests/support/server.ts](../tests/support/server.ts)). Conventions for the whole suite are in
[development](development.md).

EPUBs are assembled in memory by [tests/support/epub.ts](../tests/support/epub.ts), so the suite has
no binary fixtures nobody can read a diff of. Every shape it builds is checked against EPUBCheck,
because the fixtures are the only EPUBs this suite ever sees, and the same input builds the same
bytes. It varies what real EPUBs vary: where the navigation sits, whether it names a chapter
differently from its heading, whether one file holds several chapters, and whether a file the
package promises is there at all.

| Area             | Files                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Import           | [epubImport](../tests/server/epubImport.test.ts), [markdown](../tests/server/markdown.test.ts), [notices](../tests/server/notices.test.ts), [covers](../tests/server/covers.test.ts), [security](../tests/server/security.test.ts)                                                                                                                                                                                                               |
| Library          | [contentsReview](../tests/server/contentsReview.test.ts), [volumes](../tests/server/volumes.test.ts), [bookSettings](../tests/server/bookSettings.test.ts), [removal](../tests/server/removal.test.ts), [libraryClient](../tests/server/libraryClient.test.ts)                                                                                                                                                                                   |
| Schema and store | [schema](../tests/server/schema.test.ts), [migrate](../tests/server/migrate.test.ts), [prepared](../tests/server/prepared.test.ts), [logging](../tests/server/logging.test.ts)                                                                                                                                                                                                                                                                   |
| Scripting        | [jobs](../tests/server/jobs.test.ts), [scriptEdit](../tests/server/scriptEdit.test.ts), [cast](../tests/server/cast.test.ts), [chatScripting](../tests/server/chatScripting.test.ts), [scriptingPrompts](../tests/server/scriptingPrompts.test.ts), [promptTrial](../tests/server/promptTrial.test.ts), [simulatedScripting](../tests/server/simulatedScripting.test.ts), [fakeProvider](../tests/server/fakeProvider.test.ts)                   |
| Narration        | [narration](../tests/server/narration.test.ts), [narrationConcurrency](../tests/server/narrationConcurrency.test.ts), [narrationBatch](../tests/server/narrationBatch.test.ts), [speechGate](../tests/server/speechGate.test.ts), [speechBatch](../tests/server/speechBatch.test.ts), [simulatedSpeech](../tests/server/simulatedSpeech.test.ts), [encodedClips](../tests/server/encodedClips.test.ts), [ranges](../tests/server/ranges.test.ts) |
| Providers        | [endpoints](../tests/server/endpoints.test.ts), [endpointKeys](../tests/server/endpointKeys.test.ts), [endpointSpeech](../tests/server/endpointSpeech.test.ts), [speechProviders](../tests/server/speechProviders.test.ts), [voices](../tests/server/voices.test.ts), [voiceSample](../tests/server/voiceSample.test.ts), [voiceClone](../tests/server/voiceClone.test.ts) and one per other cloning provider                                    |
| Money            | [usage](../tests/server/usage.test.ts), [narrationBudget](../tests/server/narrationBudget.test.ts), [scriptCost](../tests/server/scriptCost.test.ts), [cloneFees](../tests/server/cloneFees.test.ts)                                                                                                                                                                                                                                             |
| Export           | [exports](../tests/server/exports.test.ts), [wavEncoder](../tests/server/wavEncoder.test.ts)                                                                                                                                                                                                                                                                                                                                                     |
| Script files     | [scriptExport](../tests/server/scriptExport.test.ts), [scriptImport](../tests/server/scriptImport.test.ts), [speakerSamples](../tests/server/speakerSamples.test.ts)                                                                                                                                                                                                                                                                             |
| Demo             | [libraries](../tests/server/libraries.test.ts), [demoWorld](../tests/server/demoWorld.test.ts), [demoSituations](../tests/server/demoSituations.test.ts), [demoLive](../tests/server/demoLive.test.ts), [demoClips](../tests/server/demoClips.test.ts), [demoSpeed](../tests/server/demoSpeed.test.ts)                                                                                                                                           |
| Stores           | [libraryBackend](../tests/libraryBackend.test.ts), [jobsBackend](../tests/jobsBackend.test.ts), [endpointsBackend](../tests/endpointsBackend.test.ts)                                                                                                                                                                                                                                                                                            |

The client tests matter more than they look: both sides of the seam are in this repository, so they
drive the real `HttpLibraryService` and `HttpJobsService` against the real app, and a route that
renames a field fails there rather than in the browser. The store tests go one layer up, through the same query
composables the pages use, against a test's own server ([backendServer.ts](../tests/support/backendServer.ts))
or the seeded demo ([demoServer.ts](../tests/support/demoServer.ts)).

Where a run has to be genuinely in flight — to be cancelled, edited under or renumbered — the
provider is `gatedProvider` or `gatedSpeechProvider` from
[tests/support/server.ts](../tests/support/server.ts), which holds the door until the test says so;
a build has `controlledEncoder` in [exports.test.ts](../tests/server/exports.test.ts). Nothing in the
queue's tests waits on a timer. The build's tests assert the **file**, not the row's account of
itself: how long it plays is read out of its header, and "this chapter was carried over" is checked
by comparing the bytes of that chapter's span in the new file against the old one. The tests that
need a real encoder, in exports, covers and encodedClips, are skipped where `ffmpeg` is not
installed.

[tests/live/](../tests/live/) is the exception on purpose: `pnpm test:live` sends a few real
requests to the scripting gateway and the Fish Audio account named in `.env` — scripting, speech in
each format, the voice list, the gate at the preset's concurrency, and the connection tests. They
are skipped unless `LIVE=1`, so the ordinary suite never reaches the network.

## Known gaps

- **Endpoints in one quota group do not share a limit.** `quotaGroup` is stored, but each endpoint's
  daily limit is held to that endpoint's own spending alone.
- **A billed request that was aborted has no row.** When one chunk of a chapter fails, the others in
  flight are aborted, and a request cancelled mid-flight reports nothing, since what the provider
  made of it is not knowable. A budget stop, by contrast, lets what is out land and pays for it.
- **Gemini is WAV only, and ElevenLabs has no Opus.** Both providers document more, but neither has
  been tried against this server's readers. Gemini's extended voice library
  (`GET /v1beta/voices`) is not listed either; its voices can be added by id.
- **OpenAI's `gpt-4o-mini-tts` audio half is an assumption.** OpenAI bills audio tokens out but
  publishes no tokens-per-second figure and reports no usage, so the preset's 25 tokens a second is
  a guess, and every figure that leans on it says so.
- **Undoing an endpoint's removal brings it back without its key**, since the save removed the row
  the key was on.
- **An update under ffmpeg re-encodes everything**, for the reason
  [the encoder](#the-encoder-and-what-it-will-not-pretend) gives.
- **A seeded demo audiobook has no file**, so downloading one of the demo's finished exports is a
  404; one the demo builds has its file.
- **A change made in another tab is noticed on the next write or poll, not before.** Nothing pushes
  events; a script edited elsewhere is found when an edit here is refused for its stale revision.
