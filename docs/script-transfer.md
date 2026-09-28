# Script export and import

[Back to README](../README.md) · [Script history](scripting.md#chapter-script-history) · [Endpoints](endpoints.md)

Three slices, built in order; each is usable on its own, and each says under its heading whether it is built yet.

A book's script is the most expensive thing in it after the audio: paid scripting runs, then an
afternoon of corrections to speakers, expression tags and pauses. Until now it lived only as rows
in one install's database. Export writes it into a file a person can **share**, **carry to a newer
EPUB of the same book**, **move to another install**, or **edit outside the app**, and import brings
it back without costing the target book a chapter, a voice or a clip it already had.

## Decisions

|                              | Decision                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Format**                   | `<book>.script.zip`: `manifest.json`, `cast.json`, `lexicon.json`, one `chapters/NNNN-slug.json` per scripted chapter. A lone chapter `.json` also imports. Expression tags inline as `{tag}`. |
| **In the file**              | Lines, cast, dictionary, voice hints; voice samples only when asked for (slice 3). Never clips, charges, flags, history, endpoints or keys.                                                    |
| **Where it imports**         | Only into a book already imported from the reader's own EPUB. The file never creates a book.                                                                                                   |
| **Chapter matching**         | By a fingerprint of the chapter's **source** words, never its title or number. Changed source words refuse that chapter.                                                                       |
| **Choosing chapters**        | Export writes the whole book; import lists the matched chapters and you tick which to apply.                                                                                                   |
| **Word edits**               | Accepted as corrections; those lines' clips go stale. A chapter whose lines drift over 2% from its source is refused.                                                                          |
| **Cast and dictionary**      | Missing entries added, existing ones kept, aliases unioned. Each difference offers **Use the file's**, and **Replace all**.                                                                    |
| **Voices**                   | Chosen per speaker, with **Use all**. Ticked by default only where the speaker has no voice. Public voices can be added; a private clone offers Keep or Replace.                               |
| **Voice samples**            | Cloning keeps its samples (slice 2). Export carries them only when **Include voice samples** is ticked (slice 3). Import never clones; it links to the Voices tab's clone form, filled in.     |
| **Other providers' cloning** | A separate slice, not this one.                                                                                                                                                                |

## Slice 1: script export and import

**Built.** Export and import on the book menu, the import page at `/book/:id/script-import`, and
the plan route. Tests: [tests/scriptFile.test.ts](../tests/scriptFile.test.ts),
[tests/server/scriptExport.test.ts](../tests/server/scriptExport.test.ts),
[tests/server/scriptImport.test.ts](../tests/server/scriptImport.test.ts) and the import cases in
[tests/history.test.ts](../tests/history.test.ts).

### The file and the export

A book's script is the most expensive thing in it after the audio: paid scripting runs, then an
afternoon of corrections. Export writes that work into one file a person can keep, send, open or
carry to a newer EPUB of the same book. This part defines the file and how it is written; reading it
back is [import](#import).

**A zip of small files, not one big one.** A 200-chapter book as one JSON document is a file nobody
edits by hand. `<book>.script.zip` holds one file per chapter, so fixing the speakers in chapter 12
means opening `chapters/0012-the-gate.json` and nothing else. The extension stays `.zip` so Finder
opens and recompresses it; what the file _is_ is read from its `format`, never from its name.

```
The Gate.script.zip
├── manifest.json     {"format":"audiobook-studio/script","version":1,"title":"…","author":"…",
│                      "chapters":[{"file":"chapters/0012-the-gate.json","title":"12 · The Gate",
│                                   "sourceHash":"sha256:…","words":3412}]}
├── cast.json
├── lexicon.json
└── chapters/0012-the-gate.json
```

**A chapter file stands alone.** It repeats its own `format` (`audiobook-studio/script-chapter`),
`version`, `title`, `sourceHash` and `words`, so a single chapter dragged out of the zip, edited and
imported on its own is still a complete document. The manifest's chapter list is a table of contents
the import screen can show before it parses anything; where the two disagree, the chapter file wins.

```json
{
  "format": "audiobook-studio/script-chapter",
  "version": 1,
  "title": "12 · The Gate",
  "sourceHash": "sha256:…",
  "words": 3412,
  "lines": [
    {
      "speaker": "Mira",
      "type": "dialogue",
      "direction": "tense",
      "text": "{sigh} Don't move.",
      "pause": 0.6
    },
    { "speaker": "Narrator", "type": "narration", "text": "Nobody did.", "sep": "\n\n" }
  ]
}
```

**The fingerprint is of the source, never of the lines.** A script cannot rebuild its chapter: the
scripting model drops the quotation marks around dialogue and squashes whitespace, the answer check
tolerates 2% of words missing or added (`server/providers/chatScripting.ts:98`), and the reader's
rewrite changes words on purpose. So `sourceHash` is sha256 over the chapter's own words in reading
order — `wordsOf(plainText(body))` (`chatScripting.ts:101`, `server/epub/markdown.ts:377`), joined
by single spaces — and `words` is their count, for display. Normalising through `wordsOf` means a
re-imported EPUB that differs only in markup, curly quotes or spacing still matches. **One function
computes it**, `sourceHash(body)` in a new `server/script/transfer.ts`, and export and import both
call it; two copies of the normalisation would drift until every chapter was refused. `wordsOf` is
imported from where it is, not copied.

**A line carries the script and nothing about this install.** Each line is `speaker`, `type` and
`text`, with `direction`, `pause`, `sep`, `edited` and the `fallback`, `fallbackCount`,
`fallbackMismatch` trio when set — exactly what `scriptOnly` keeps (`src/lib/scriptHistory.ts:66-82`).
There are no segment ids or positions: they are local, and import numbers lines afresh. Clips,
charges, listener flags, history, endpoints and keys are never written. The test that nothing was
lost is the one history already trusts: `scriptSignature(before) === scriptSignature(after)`
(`scriptHistory.ts:59`), which covers text, `sep`, speaker, type, direction, expressions and pause.

**Expression tags travel inside the text.** An annotation is stored as a UTF-16 offset into the
line (`src/types/expression.ts:22`), and an offset is silently wrong after the first hand edit. In
the file it is a marker at that position: `{sigh}`, where `sigh` is the tag's shared `id`, never a
provider's token — each provider writes tags its own way, and the file must not care which one
rendered it. An omitted tag is `{sigh!}` and one awaiting review is `{sigh?}`, the same suffixes
`exprSignature` uses (`scriptHistory.ts:40`). A literal `{` in the book is written `{{`; a lone `}`
needs no escape, because only `{` opens a marker. `annotationId`, `label`, `token` and `kind` are not
written: the id is local and the rest belong to the endpoint that will speak the line.

**A marker reads the way a person types it.** A marker that starts a word — at the start of the
line or after whitespace — is written with one space after it, and reading takes that space back:
`{sigh} Don't move.` is the line `Don't move.` with the tag before its first word, and `{sigh}Don't
move.` reads the same. Glued to a word, `move{sigh}.`, a marker takes no space. A tag id is whatever
was typed when the tag was configured, so inside a marker a backslash escapes `{ } ! ? \`:
`{huh\?}` is the tag `huh?`, where `{huh?}` is the tag `huh` awaiting review.

**The marker functions live in `src/lib`.** `writeMarkers(segment)` and `readMarkers(text)` are
pure, in `src/lib/scriptFile.ts` beside the schemas' types, because the server writes the export and
the browser will want to read a single chapter file to preview it before sending it. The server
already imports from `@/lib` (`server/providers/clone.ts` imports `@/lib/endpointShapes`), so one
copy serves both. `readMarkers` is a real scanner, not a strip-by-regex: it returns the plain text
and the annotations with their positions in it, and refuses an unclosed `{`.

**The cast and dictionary go whole.** `cast.json` is each speaker's `name`, `aliases`, `gender`,
`description`, `style`, `color`, `major`, and a voice **hint** — `{endpoint, provider, voiceId,
voiceLabel}`, with the endpoint's name, its base URL's host, and the voice's id and label from the
`voices` table (`server/db/schema/endpoints.ts:148-160`). A `VoiceRef` itself is never written: its
endpoint id is a local key. `lexicon.json` is `term`, `say`, `ipa`, `note`, `matchCase`, `enabled`.

**The schemas are the parser's contract.** `ScriptFileSchema`, `ScriptChapterSchema`,
`CastFileSchema` and `LexiconFileSchema` join `server/lib/schemas.ts` beside `SegmentSchema` (`:51`),
as valibot, so a hand-edited file that breaks is refused with the path of what broke.

**Which chapters are written.** Every chapter with a script, excluded or not: exclusion is the
target book's decision, made on its own Contents page, and a script dropped here cannot be got back
there. A chapter with no script writes no file. A chapter whose scripting job is still running is
written as it last stood.

**Where it starts.** `GET /api/books/:id/script-export` in a new `server/routes/transfer.ts`, served
with `content-disposition` the way built audiobooks are (`server/routes/exports.ts:87-104`). The
button is **Export script** in the book menu (`src/views/library/BookMenu.vue`), beside _Add a
volume…_, because it is a whole-book action, and the Export page is about audiobooks. `jszip` moves
from `devDependencies` (`package.json:71`) to `dependencies`, since the server now writes zips.

**Tests.** Extending before adding, per [development](development.md#before-adding-a-test):

- `tests/scriptFile.test.ts`, one `test.each` over marker cases — tag at the start, at the end, two
  at one position, `!`, `?`, a literal `{`, an unclosed `{` refused — each asserting
  `readMarkers(writeMarkers(s))` gives back the annotations.
- The round trip on a scripted `story(3)` chapter, asserting `scriptSignature` equality.
- `sourceHash` equal across two bodies that differ only in markup and curly quotes, different after
  one changed word.
- One route test: the zip lists a manifest, cast, lexicon and one file per scripted chapter, and no
  file for an unscripted one.

**Not in this slice**

- Reading the file back: matching, merging the cast and dictionary, the write path ([import](#import)).
- Voice samples (Slices 2 and 3).
- Choosing chapters on export: export always writes the whole book.

### Import

A script file is someone's paid scripting runs and an afternoon of corrections. Importing it must
never cost the book it lands in anything: not a chapter whose words moved, not a voice you chose,
not a clip already rendered. So import **reads, matches and shows first, and writes nothing until
you apply** — and what it writes goes through the paths a restore already uses, so history, Undo and
stale audio behave the way they already do.

#### Reading the file

**One zip guard, shared with the EPUB import.** `checkArchive` (`server/epub/archive.ts:60`)
already refuses an archive that unzips past its limits or lies about its sizes, but it is an EPUB's:
its per-document limit only matches `\.(x?html?|xml|opf|ncx|svg)$` (`:30`), it throws
`EpubParseError` (`:68`, `:100`), its messages say "EPUB" (`:73`, `:87`, `:92`, `:123`), and it inflates
each entry into nothing (`:116`), so a second reader would unzip everything twice. It moves to
`server/lib/zip.ts` as `readArchive(bytes, { limits, document, wording })`, returning the entries it
inflated (name and bytes) alongside the size. The EPUB import (`server/library/ops.ts:145`) calls it
with today's pattern and words and discards the bytes; its tests pass unchanged.

**Tolerant of a hand-made zip.** Finder's Compress wraps everything in a folder and adds
`__MACOSX/`; editors leave `.DS_Store` and `._*`. The reader skips those and directories, takes the
**shallowest** `manifest.json` and reads every other path relative to it, and finds chapters by
scanning `chapters/*.json` rather than trusting the manifest's list — a deleted chapter file is one
fewer chapter, not a broken import. No manifest, or two at the same depth, refuses the file.
Anything else unrecognised is ignored and listed. A lone `.json` whose `format` is
`audiobook-studio/script-chapter` is accepted as a one-chapter import. The format is known from the
`format` field, never the extension, so a dropped EPUB gets a clear refusal. Each JSON is checked
against a valibot schema, the way lines already are (`SegmentSchema`, `server/lib/schemas.ts:51`),
and a malformed chapter file is refused **by name**, not the whole import.

#### Matching chapters

**Into a book you already have, by the words of its source.** The server computes each target
chapter's `sourceHash` with the same shared function the export used — sha256 over
`wordsOf(plainText(body))` in order (`wordsOf`, `server/providers/chatScripting.ts:101`;
`plainText`, `server/epub/markdown.ts:377`; `body`, `server/db/schema/library.ts:111`) — and pairs
file chapters by equal hash. Never by title and never by number: numbers move when a book is
renumbered, and titles are the one thing a re-release tidies. Two chapters with the same hash (two
identical author's notes, say) pair in reading order. A file chapter with no partner is **refused
and listed** with its title and word count, which is how an EPUB that changed a chapter — even one
typo — shows up.

**A sanity check on the lines.** A matched chapter's lines, markers stripped, must pass `fidelity`
(`chatScripting.ts:116`) against the target chapter's plain text: at most 2% of words missing or
added (`:98`). That is the same bar a model's answer clears, so an honest correction passes and a
file that rewrote a scene is refused with the check's own examples of the missing words.

**Nothing is written by the check.** `POST /api/books/:id/script-import` takes the file as
multipart and answers with the plan: each chapter matched (with its lines parsed to segments, the
inline `{tag}` markers turned back into annotations by the format's parser, and fresh line ids
`1…n`, since the file carries none and `editScript` refuses a repeated id —
`server/script/ops.ts:76`), refused (and why), the cast and dictionary differences, the voice
rows, and the entries ignored. The file carries a tag's shared `id` only, so the parser fills each
annotation's `label`, `token` and `kind` from the tags of the endpoint that will speak the line; a
tag that endpoint does not offer arrives as needing review, the way a model change already leaves
it. In this slice the upload is held to the EPUB's `MAX_UPLOAD_MB`: a script without audio is text,
and compresses like it.

#### The import page

**`/book/:id/script-import`, reached from "Import script…" in the book menu and the Scripting
header.** It is a page rather than a dialog because it has four things to say, and it reads top to
bottom in the order they are decided:

- **Chapters** — every matched chapter, ticked, with shift-range, per-volume and "all", and beside
  each what applying it does: _identical — nothing to do_, _38 lines · 4 words corrected · 12 clips
  go stale_. Refused chapters sit under their own heading with the reason. A chapter with a run in
  flight is unticked and says so, the same refusal restore gives (`src/stores/history.ts:377`).
- **Voices** — see below.
- **Apply N chapters** names the work and is dead at zero.

After applying, the page becomes the report: what was applied, what was refused, the entries
ignored, and the cast and dictionary differences.

#### Writing the script

**The restore path, not a new one.** For each ticked chapter the store does what `restore`
(`src/stores/history.ts:367`) does with a version: `planRestore(current, imported, opts)`
(`src/lib/scriptHistory.ts:493`) carries every rendered clip across line by line and re-judges it,
then `_commit` writes it through `PUT …/script` into `editScript` (`server/script/ops.ts:71`) with
the revision it was read at, so a script that moved meanwhile is a 409, not an overwrite. The server
preserves the current script before it (`history.capture`, `ops.ts:88`), and a chapter whose
`scriptSignature` is unchanged adds no entry (`ops.ts:83-84`). **Changed words are corrections:** the
line takes them, and its clip goes stale through `clipDrift` ("text: edited",
`src/stores/narration.ts:122`).

**A new origin.** `VersionOrigin` (`src/types/history.ts:12`) gains
`{ kind: "imported"; file?: string; chapters?: number }`: `originLabel` "Imported from The Gate
script", `originKindLabel` "imported", `originNote` "38 chapters" (`scriptHistory.ts:142`, `:160`,
`:176`).

**One Undo for the whole import.** The toast's Undo writes each chapter's previous script back as an
edit, as restore's undo does, drops the speakers the import added unless a line still uses them
(`_dropSpeakers`, `src/stores/cast.ts:319`), and puts back the dictionary and voices as they were.

#### Cast and dictionary

**Add what's missing, keep what's there.** Speakers the book lacks are added the way a restore adds
them — `_absorbCast` (`src/stores/cast.ts:306`), the store's twin of the server's `ensureSpeakers`
(`server/db/cast.ts:84`) — as unreviewed `newSpeaker`s the Cast page can merge, then filled from the
file (gender, description, style, aliases) before `_push` (`:247`) writes them. A speaker the book
has keeps its own details; only **aliases are unioned**, which adds matches and loses nothing.
Dictionary terms the book lacks are appended; a term it has keeps the book's `say`.

**Replacing is offered, not assumed.** The report lists each differing speaker and term with the
book's value beside the file's, **Use the file's** per row and **Replace all N**, each an undoable
toast. Replacing a speaker changes description, style and gender; replacing a term changes `say`,
`ipa`, note, match-case and enabled. The dictionary is written whole (`replaceLexicon`,
`server/db/cast.ts:117`, through `_pushLexicon`), so its stale-and-restore of clips already works.

#### Voices

**Voices are chosen per speaker, because they are the part of a book most tuned by hand.** One row
per speaker whose voice the file names: the book's voice → the file's, a tick, and **Use all** at
the top. **Ticked by default only for new speakers and speakers on the Narrator's voice**
(`voice: null`, `server/db/schema/cast.ts:31`); a voice you chose starts unticked.

**A voice applies only when it is plainly the same voice.** The file names a voice by provider, id
and label; the endpoint id in a `VoiceRef` is a local key and means nothing elsewhere. The row is
applicable when a `voices` row (`server/db/schema/endpoints.ts:148`) on an **enabled** endpoint of
that provider (`:58`) has that id **and** that label. Several matches offer a choice of endpoint.

**A public voice not here yet is offered for adding.** The server asks the matching endpoint through
the existing lister (`server/providers/voices.ts`, `POST /api/endpoints/voices`): the `library`
source answers a provider's own voices — OpenAI's, Gemini's prebuilt, Qwen's system voices —
without a request, and Fish's `public` search finds one voice by its 32-character id
(`server/providers/speech/fish.ts:64`). Found, the row offers **Add to <endpoint> and use**, which is
`addVoice` (`src/stores/endpoints.ts:564`).

**A private clone offers Keep or Replace.** A clone lives on someone else's account and cannot be
fetched. Its row names the voice the file expected and offers **Keep** (the current voice, or the
Narrator's for a new speaker) or **Replace…**, which opens the voice picker over this install's
voices.

#### Tests

- `tests/server/scriptImport.test.ts`: a zip wrapped in a folder with `__MACOSX` and `.DS_Store`
  reads; two manifests refused; unknown entries listed; a bomb refused with 413 through the shared
  guard; a lone chapter JSON accepted; a malformed chapter refused by name. Matching: a renumbered
  and retitled book still pairs; one changed source word refuses; duplicate hashes pair in order; a
  chapter over 2% `fidelity` refused. The route writes nothing.
- `tests/server/epubImport.test.ts` unchanged and passing after the extraction.
- `tests/scriptImport.test.ts` (stores): export then import into the same book adds no history
  entry; a corrected word keeps the other clips and stales that one; the entry reads "imported";
  a chapter with a run in flight is skipped; Undo restores scripts, cast, dictionary and voices;
  cast add/keep/alias union; **Use the file's** and **Replace all** with their undo; voice defaults;
  a label mismatch or disabled endpoint makes a row inapplicable; a public voice is offered; a private
  clone offers only Keep and Replace.

#### Not in this slice

The demo mode (the check is the server's); carrying voice samples and cloning from them (slices 2
and 3); cloning on providers other than Fish; importing into a book that does not exist yet.

## Slice 2: cloning keeps its samples

**Status: built.** The routes and tables are as below; see
[endpoints](endpoints.md) and [backend](backend.md#the-providers-and-where-a-key-lives) for how
they read now. `GET /api/endpoints/:id/samples` was added beside the per-voice routes, so the
Voices tab asks once per endpoint rather than once per voice.

Today a clone is made in a single request. The route reads the recordings (`server/routes/endpoints.ts:106-164`), hands them to Fish once (`server/providers/clone.ts:120-157`), and the only record it keeps is a log line (`routes/endpoints.ts:159-164`). The route's own comment says "nothing is kept on this server" (`:98-99`), and so does the Voices tab (`src/views/endpoints/VoicesTab.vue:175-178`). Slice 3 can't export samples the server threw away, so this slice keeps them with the voice they made. Cloning stays Fish-only (`src/lib/endpointShapes.ts:244`). A sample is any audio the person picks, recorded or downloaded.

**Kept where the bytes already are.** The route already holds each recording as a parsed `File`, sniffed and re-typed by its bytes (`routes/endpoints.ts:135-157`). Once Fish answers with the new voice's id, the route writes those same bytes to disk. Nothing is re-encoded and nothing is renamed: the format stays the one `sniffRecording` found (`clone.ts:81`), and the file keeps the name the person gave it for display. It is written only after Fish answers, because the voice's id is the key, so a failed clone keeps nothing. If the clone succeeds but the samples can't be kept, the route still answers `201`, with `samplesKept: false`, and the toast says so. The voice already exists on the account, so failing the request would be wrong.

**On disk, beside the other data.** There's a new `VOICE_DIR` (default `./data/voices`) next to `AUDIO_DIR` and `EXPORT_DIR` (`server/env.ts:89,111`), so voice samples can be measured, backed up and cleared on their own. Files live at `<VOICE_DIR>/<key>/<sha>.<ext>`. `<key>` is a hash of endpoint id plus voice id, because a Fish id is not a safe directory name we control. `<sha>` is a hash of the bytes, the way covers are named (`server/covers/files.ts:1-6`), so the same file picked twice is stored once and a url can never climb out of its directory.

**Two tables, and neither points at `voices`.** Saving the endpoints clears every endpoint and voice row and lays the whole configuration down again (`server/db/endpoints.ts:4-9`, `replaceEndpoints` at `:178`). A foreign key with cascade to `voices` (`schema/endpoints.ts:148-160`) would therefore wipe every sample on every save. Instead:

- `cloned_voices`: `(endpoint_id, voice_id)` as the key, plus the title, `made_at`, `consent_at`,
  `consent_text` (the statement the form showed when it was ticked), `attached`, `missing_since`
  and `forgotten_at`.
- `voice_samples`: `(endpoint_id, voice_id, file)` as the key, plus `name`, `format`, `bytes` and `position`, cascading from `cloned_voices`.

They come in through two drizzle migrations: the tables, then the two removal columns.

**Reconciled on save, not cascaded.** `saveEndpoints` (`server/endpoints/ops.ts:96-100`) reconciles inside the same transaction:

- A saved configuration that includes a clone's voice marks that clone `attached`, and no longer missing.
- An attached clone whose voice has left the configuration is marked **missing** (`missing_since`), not deleted. Removing a voice or an endpoint on the page offers Undo, and the page saves 400 ms later; a settings import can drop a voice and bring it back. A missing clone whose voice returns is attached again with its recordings, and one still missing a day later goes on the next save.
- An unattached clone is spared, because the page adds the voice and saves it a moment later (`src/stores/endpoints.ts:668-680`). Deleting it then would race that save. An unattached clone older than a day is a clone the page discarded, and it goes on the next save.
- A forgotten clone goes on the first save a day after the forget.

Files are removed after the commit without waiting, with `inBackground` (`server/lib/background.ts:14`), the way a removed book's clips are (`server/library/ops.ts:340`) — only the files the deleted rows named, never the voice's directory whole, so a keep writing into it at the same moment loses nothing; the directory goes once it is empty. Removing a voice removes its samples in the end on purpose: keeping someone's voice after the voice itself is gone is exactly what the consent never covered. A keep that fails part way takes back the files it wrote, except any a row already names.

**Consent travels with the samples.** The form can't clone without `consent=yes` (`routes/endpoints.ts:126-131`). Today the only record of that is a log line, which a log rotation loses. `cloned_voices.consent_at` makes it a fact that stays with the bytes. Slice 3 exports it, and the importing side shows it.

**Older clones can be given samples, and I recommend allowing it.** A voice cloned before this slice has no row, and the server can't tell it apart from any other voice. Fetch lists the account's own library with `self=true` (`server/providers/speech/fish.ts:33,154`), and a `Voice` carries only an id, a label and a gender, with nothing marking it as a clone. So a voice row with kept samples shows _"3 samples kept"_. Any other voice on a clonable endpoint offers **Keep its samples…**, which takes the same picker, the same limits and the same consent tick as cloning, and sends nothing to Fish. Otherwise the only way to make an older voice exportable is to re-clone it, which leaves a duplicate private voice on the account.

**The limits are the clone's.** At most `MAX_CLONE_CLIPS` (20) files per voice (`endpointShapes.ts:250`), `MAX_CLIP_BYTES` (20 MB) each and 100 MB in all (`routes/endpoints.ts:39-46`). Attaching samples uses the same body limit and the same refusals. It can replace a voice's kept samples, but never adds to them past 20.

**Routes slice 3 needs.** Each works on a saved endpoint's voice, and the voice id is URL-encoded in the path:

- `GET /api/endpoints/:id/voices/:voice/samples` returns the sample list and `consentAt`.
- `GET …/samples/:file` returns the bytes with the format's media type (`RECORDING_MIME`, `clone.ts:55`) and an immutable cache header, since the name is the content. A `:file` that isn't `<sha>.<ext>` is a 404.
- `POST …/samples` is a multipart form with `consent` and `clips`, and replaces the kept samples.
- `DELETE …/samples` forgets the samples and keeps the voice. A forget hides them at once and is final only after a day, so the Voices tab's toast offers Undo.
- `POST …/samples/restore` takes a forget back, while no save has made it final.

**Tests,** on the fake cloner:

- a clone writes files byte-identical to the upload, typed by sniffing (an `.mp3` that is really M4A is kept as `m4a`), and records `consent_at`;
- a failed clone leaves no row and no file;
- a save without the voice deletes its rows and then its files;
- a save in the gap before the page's own save spares an unattached clone;
- attaching samples needs consent, and 21 files are refused;
- a fetched file comes back byte-identical with the right type;
- `../` or a bad name in `:file` gets a 404;
- two tests for the page: the "N samples kept" label, and the Keep-its-samples form.

**Not in this slice**

- Cloning on ElevenLabs, MiniMax or Qwen.
- Putting samples in a script export, or reading them on import (slice 3).
- Playing a kept sample on the Voices tab.
- Trimming or transcoding samples.
- Keeping the transcripts Fish makes of the recordings.

## Slice 3: the export carries voice samples

A private clone exists only on the account that made it (`server/providers/clone.ts:10`), so in
someone else's hands it's a name with nothing behind it. This slice lets the recordings slice 2 keeps
travel with the script. Import still never clones: that's a one-shot upload that needs consent
(`server/routes/endpoints.ts:126`), so it stays a step taken on the Voices tab.

**Off unless asked for, and it says what it hands over.** Export gains one checkbox, **Include voice
samples**, unticked every time. Recordings of a person are not a setting to remember. Under it, one
line lists what ticking it adds: _Recordings of 3 voices (Mira, Kael, Vex) · 41 MB. Share them only
with someone the voice's owner agreed to._ It appears only when some voice has samples: a speaker's
`VoiceRef` is split into endpoint and voice id and looked up in slice 2's `cloned_voices`, and
samples still waiting with a speaker from an earlier import (below) count too. When ticked, the zip
gains `voices/<slug>/sample-N.<ext>`, and that speaker's `cast.json` entry names the folder
(`"samples": "voices/vex/"`) beside the voice hint. Samples a book received from an import and has
not yet cloned are carried again, with their original consent.

**Consent travels as a record, not as permission.** Each voice folder has a `consent.json` with the
statement slice 2 recorded when the voice was cloned: what was agreed to, and when. The import report
shows it on the speaker's row (_Consent recorded 12 Sep 2026: "This is my voice, or…"_). It never
ticks the recipient's box. The clone form's consent checkbox (`src/views/endpoints/VoicesTab.vue:524`)
starts unticked whatever the file says, and the route still refuses without `consent=yes`.

**The import row gains a line, not an action.** A speaker whose file voice is a private clone not on
this install keeps the two choices slice 1 gives it, **Keep** and **Replace…**. When the file carried
samples for that voice, the row adds _Samples included · 3 recordings, 12 MB · Clone on the Voices
tab →_. If no endpoint can clone (`canCloneVoices` is Fish-only, `src/lib/endpointShapes.ts:244`),
the line says _Add a Fish endpoint to clone this voice_ and the samples are kept anyway.

**Samples wait with the speaker, not with a voice.** An imported sample has no voice row yet, because
no provider has made one. It is stored against the **speaker** instead: a `speaker_samples` row per
voice (book, speaker name, voice title, consent document), with a foreign key to `characters(book_id,
name)` using `ON UPDATE CASCADE ON DELETE CASCADE`. A rename carries the samples, as it carries the
lines (`server/db/schema/cast.ts:17-23`). The files live in `<AUDIO_DIR>/<bookId>/samples/`, named by
a hash of their bytes, as covers are (`server/covers/files.ts:3-6`). Removing the book removes them,
and nothing else has to remember them. Once the voice is cloned they move into slice 2's store, and
the row is dropped.

**The link fills the form; it doesn't submit it.** The link opens the clonable endpoint's Voices tab with
`?samples=<id>`, and the tab fetches the recordings from `GET /api/books/:id/speaker-samples/:sampleId/files` as `File`s and sets
`clone.title` and `clone.clips` (`VoicesTab.vue:185-206`). The person still reads the form, ticks
consent and presses **Make voice**.

**After cloning, the voice goes to the speaker (recommended).** The link came from one speaker, so a trip back to Replace…
adds no decision. When the clone succeeds, the voice is assigned to that speaker, but
only if the speaker's voice is still what it was when the link opened. A toast offers Undo. Otherwise it's only added to the endpoint, and the toast says why.

**Audio has its own limits inside the zip.** The shared zip guard from slice 1 treats `voices/**`
entries as carried rather than parsed. They are held to the clone route's own limits: 20 MB per
recording, at most 20 per voice, 100 MB per voice (`server/routes/endpoints.ts:39-40`,
`MAX_CLONE_CLIPS`). Each is checked with `sniffRecording` (`clone.ts:83`). A file that isn't
recognised audio is refused, and so is a voice over its limits: the report names it, and the lines and
cast still import. Audio barely compresses, so the script import needs an upload ceiling of its own,
separate from the EPUB's `MAX_UPLOAD_MB` of 64 (`server/env.ts:40`). I suggest `MAX_SCRIPT_UPLOAD_MB`
set to 512.

**Deleting samples is a plain removal.** The speaker row has **Discard samples**. The files and the
row go, and the import line goes back to Keep and Replace alone. If the files are gone from disk, the link is disabled
with _The samples are missing_.

**Tests.**

- Export with the option off writes no `voices/`. With it on, the zip holds the files and the consent
  record, and cast entries point at them.
- Import stores the samples against the speaker, a rename carries them, and removing the book removes
  them.
- A cloner that fails on any call proves import never clones.
- The guard refuses a mislabelled file, a recording over 20 MB and a voice over 100 MB, without
  refusing the chapters.
- The prefilled form starts with consent unticked.
- Auto-assign happens only when the speaker's voice is unchanged, and Undo restores it.

**Not in this slice.** Cloning inside import; cloning on any provider but Fish; checking that the
same voice already exists on the recipient's account; carrying the samples of voices that are not
clones; editing or trimming samples before cloning.
