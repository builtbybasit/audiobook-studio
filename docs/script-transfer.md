# Script export and import

[Back to README](../README.md) · [Backend](backend.md) · [Script history](scripting.md#chapter-script-history) · [Endpoints](endpoints.md)

A book's script is the most expensive thing in it after the audio: paid scripting runs, then an
afternoon of corrections to speakers, expression tags and pauses. Export writes it into a file a
person can **share**, **carry to a newer EPUB of the same book**, **move to another install**, or
**edit outside the app**. Import brings it back without costing the target book a chapter, a voice
or a clip it already had: it reads, matches and shows first, and writes nothing until you apply.

## Decisions

|                         | Decision                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Format**              | `<book>.script.zip`: `manifest.json`, `cast.json`, `lexicon.json`, one `chapters/NNNN-slug.json` per scripted chapter, and `voices/<slug>/` only when asked for. A lone chapter `.json` also imports.  |
| **In the file**         | Lines with their expression tags inline as `{tag}`, the cast with voice hints, the dictionary; voice samples only when asked for. Never clips, charges, listener flags, history, endpoints or keys.    |
| **Where it imports**    | Only into a book already imported from the reader's own EPUB. The file never creates a book.                                                                                                           |
| **Chapter matching**    | By a fingerprint of the chapter's **source** words, never its title or number. A chapter whose source words changed is refused.                                                                        |
| **Choosing chapters**   | Export writes the whole book; import lists the matched chapters and you tick which to apply.                                                                                                           |
| **Word edits**          | Accepted as corrections, and those lines' clips go stale. A chapter whose lines drift more than 2% from its source is refused.                                                                         |
| **Cast and dictionary** | Missing entries added, existing ones kept, aliases unioned. Each difference offers **Use the file's**, and **Replace all**.                                                                            |
| **Voices**              | Chosen per speaker, with a tick for all. Ticked by default only where the speaker has no voice. A public voice can be added; a private clone offers **Keep** or **Replace…**.                          |
| **Voice samples**       | Cloning keeps its samples. Export carries them only when **Include voice samples** is ticked. Import never clones: the samples wait with the speaker, and a link fills in the Voices tab's clone form. |

## The file and the export

**A zip of small files, not one big one.** A 200-chapter book as one JSON document is a file nobody
edits by hand. One file per chapter means fixing the speakers in one chapter is opening one file.
The extension stays `.zip` so Finder opens and recompresses it; what the file _is_ is read from its
`format` field, never from its name. Every JSON file is indented, since a person opening it is one
of the reasons it exists.

```
The Gate.script.zip
├── manifest.json
├── cast.json
├── lexicon.json
├── chapters/0012-at-the-gate.json
└── voices/mira/                  only with "Include voice samples"
    ├── consent.json
    └── sample-1.wav
```

`manifest.json` is a table of contents; where it and a chapter file disagree, the chapter file wins,
and import finds chapters by scanning `chapters/*.json` rather than trusting the list.

```json
{
  "format": "audiobook-studio/script",
  "version": 1,
  "title": "The Gate",
  "author": "…",
  "chapters": [
    {
      "file": "chapters/0012-at-the-gate.json",
      "title": "At the Gate",
      "sourceHash": "sha256:…",
      "words": 3412
    }
  ]
}
```

**A chapter file stands alone.** It repeats `format` (`audiobook-studio/script-chapter`), `version`,
`title`, `sourceHash` and `words`, so one chapter dragged out of the zip, edited and imported on its
own is still a complete document. Its name is its place in the export, zero-padded to four digits,
then a slug of its title (`chapterFileName` in [scriptFile.ts](../src/lib/scriptFile.ts)): numbered
so a folder lists in reading order, named so a person can find the chapter. Nothing matches on it.

```json
{
  "format": "audiobook-studio/script-chapter",
  "version": 1,
  "title": "At the Gate",
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
scripting model drops the quotation marks around dialogue and squashes whitespace, its answer is
accepted with 2% of words missing or added, and the reader's rewrite changes words on purpose. So
`sourceHash` is `sha256:` and the hex sha256 of the chapter's own words in reading order,
`wordsOf(plainText(body))` joined by single spaces, and `words` is their count, for display. Going
through `wordsOf` means a re-imported EPUB that differs only in markup, curly quotes or spacing
still matches, and one corrected typo does not. One function computes it, `sourceHash` in
[server/script/transfer.ts](../server/script/transfer.ts), and export and import both call it: two
copies of the normalisation would drift until every chapter was refused.

**A line carries the script and nothing about this install.** Each line is `speaker`, `type` and
`text`, with `direction`, `pause`, `sep`, `edited` and the `fallback`, `fallbackCount`,
`fallbackMismatch` trio when set: what `scriptOnly` keeps
([scriptHistory.ts](../src/lib/scriptHistory.ts)), minus the id. There are no segment ids or
positions, because they are local; import numbers lines afresh. A chapter exported and imported
back has the same `scriptSignature`, the test history already trusts for "nothing changed".

**Expression tags travel inside the text.** An annotation is stored as a UTF-16 offset into the
line, and an offset is silently wrong after the first hand edit. In the file a tag is a marker at
its place:

- `{sigh}` is the tag whose shared `id` is `sigh`, never a provider's token: each provider writes
  tags its own way, and the file must not care which one rendered it. `annotationId`, `label`,
  `token` and `kind` are not written.
- `{sigh!}` is an omitted tag, `{sigh?}` one awaiting review and `{sigh!?}` both: the suffixes
  `exprSignature` uses.
- A literal `{` in the book is written `{{`. A lone `}` needs no escape, because only `{` opens a
  marker. Inside a marker a backslash escapes `{ } ! ? \`, since a tag id is whatever was typed when
  the tag was configured: `{huh\?}` is the tag `huh?`, where `{huh?}` is the tag `huh` awaiting
  review.
- A marker that starts a word, at the start of the line or after whitespace, is written with one
  space after it, and reading takes that space back: `{sigh} Don't move.` is the line `Don't move.`
  with the tag before its first word, and `{sigh}Don't move.` reads the same. Glued to a word,
  `move{sigh}.`, a marker takes no space.

`writeMarkers` and `readMarkers` are pure and live in [src/lib/scriptFile.ts](../src/lib/scriptFile.ts)
so the browser and the server share one copy. `readMarkers` is a scanner, not a strip-by-regex: it
returns the plain text and the markers with their positions in it, and refuses an unclosed `{` or
an empty marker rather than import a tag's name to be read aloud.

**The cast and dictionary go whole.** `cast.json` is an array of speakers: `name`, `aliases`,
`gender`, `description`, `style`, `color`, `major`, and when the speaker has a voice, a hint
`voice: { endpoint, provider, voiceId, voiceLabel }`, which is the endpoint's name, the host of its
base URL, and the voice's id and label. A `VoiceRef` is never written, because its endpoint id is a
key local to this database; a voice its endpoint no longer lists writes no hint. `samples` names
the speaker's voice folder when the export carries one. `lexicon.json` is an array of `term`, `say`
and `enabled`, with `ipa`, `note` and `matchCase` when set.

**The schemas are the parser's contract.** `ScriptManifestSchema`, `ScriptChapterSchema`,
`CastFileSchema` and `LexiconFileSchema` in [server/lib/schemas.ts](../server/lib/schemas.ts) are
valibot, so a hand-edited file that breaks is refused with the path of what broke. They are loose
objects: a field someone added is ignored, not an error. `version` must be `1`. The TypeScript
shapes are in [src/types/scriptFile.ts](../src/types/scriptFile.ts).

**Every chapter with a script is written, excluded or not.** Exclusion is the importing book's
decision, made on its own Contents page, and a script left out here could not be got back there. A
chapter with no script writes no file; one whose run is still going is written as it last stood.

**Where it starts.** **Export script** in the book menu
([BookMenu.vue](../src/views/library/BookMenu.vue)), and in the Scripting page's "Script file"
line, downloads `GET /api/books/:id/script-export`
([server/routes/transfer.ts](../server/routes/transfer.ts)). The zip is built on each request,
because it is small and never stale, and served with `content-disposition` the way a built
audiobook is. It lives beside the book's other whole-book actions rather than on the Export page,
which is about audiobooks.

## Import

**Import script…** in the book menu or the Scripting page opens `/book/:id/script-import`
([ScriptImportView.vue](../src/views/ScriptImportView.vue)). You choose a `.script.zip` or one
chapter's `.json`, the server answers with a plan, and nothing is written until you apply it. What
is written then goes through the paths a restore already uses, so history, Undo and stale audio
behave the way they already do.

### Reading the file

`POST /api/books/:id/script-import` takes the file as multipart `file` and answers with the plan
(`planScriptImport` in [server/script/importPlan.ts](../server/script/importPlan.ts)). It never
writes. The upload is held to `MAX_SCRIPT_UPLOAD_MB` (default 512), apart from the EPUB's
`MAX_UPLOAD_MB`, because a script carrying voice samples is mostly recordings, which barely
compress.

**One zip guard, shared with the EPUB import.** `readArchive` in
[server/lib/zip.ts](../server/lib/zip.ts) refuses an archive that unzips past its limits or lies
about its sizes, and the EPUB import's `checkArchive` calls the same function with its own document
pattern and wording. For a script file the limits are `MAX_UNZIPPED_MB` in all and
`MAX_DOCUMENT_MB` for each `.json`. A recording over 20 MB is refused by its stated size without
being inflated, and the plan holds only the first few kilobytes of each recording: enough to know
it is audio.

**Tolerant of a hand-made zip.** Finder's Compress wraps everything in a folder and adds
`__MACOSX/`; editors leave `.DS_Store` and `._*`. Those are skipped without a word. The reader takes
the **shallowest** `manifest.json` and reads every other path relative to it; no manifest, or two
at the same depth, refuses the file. Anything else it does not read, including a `voices/` folder
no speaker names, is listed as ignored; a dropped EPUB is a zip with no manifest, and is refused
saying so. A file that is not a zip is read as JSON: a chapter file
(`format: "audiobook-studio/script-chapter"`) is a one-chapter import with no cast or dictionary, a
lone manifest is refused as having no chapters, and anything else is refused as not a script file.

**What refuses what.** A chapter file that is not valid JSON, fails its schema, holds a marker that
does not parse, or could not be unzipped is refused **by name**, with the path that broke, and the
rest of the import goes on. A manifest, `cast.json` or `lexicon.json` that does not read refuses
the whole file.

### Matching chapters

**Into a book you already have, by the words of its source.** The server computes each chapter's
`sourceHash` with the same function the export used and pairs file chapters by equal hash. Never by
title and never by number: numbers move when a book is renumbered, and titles are the one thing a
re-release tidies. Two chapters with the same hash (two identical author's notes, say) pair in
reading order. A file chapter with no partner is refused as `unmatched`, listed with its title and
word count, which is how an EPUB that changed a chapter, even by one typo, shows up.

**A sanity check on the lines.** A matched chapter's lines, markers stripped, must pass `fidelity`
([chatScripting.ts](../server/providers/chatScripting.ts)) against the chapter's plain text: at
most 2% of words missing or added. That is the bar a model's answer clears, so an honest correction
passes, and a file that rewrote a scene is refused as `fidelity` with examples of the missing words.

**Lines become segments.** Each matched chapter's lines are parsed into segments with fresh ids
`1…n` (`editScript` refuses a repeated id) and no audio. The file carries only a tag's shared id, so
`fromFileLine` fills each annotation's `label`, `token` and `kind` from the tags of the endpoint
that will speak the line; a tag that endpoint does not offer is kept, arriving as needing review,
the way a model change already leaves one.

The plan also carries the cast and dictionary differences, one voice row per speaker whose voice
the file names, and the ignored entries.

### The import page

It is a page rather than a dialog because it has several things to say, and it reads top to bottom
in the order they are decided. The header names the file, the book it was scripted for, and how
many chapters matched and were refused.

- **Chapters**: every matched chapter, in this book's order and grouped by volume when there are
  several, ticked, with a tick for all, one per volume, and shift-click for a range. Beside each is
  what applying it does, worked out with the same plan the write will use: _identical — nothing to
  do_, or _38 lines change · 4 lines with corrected words · 4 clips go stale · 30 clips kept_. The
  file's title shows when it differs from the book's. A chapter with a run in flight is unticked,
  cannot be ticked, and says to cancel the run first.
- **Refused**: each refused chapter with its reason and detail.
- **Voices**: see [below](#voices).
- **Apply N chapters** names the work, with the number of voices beside it. It is disabled at zero
  chapters, so voices are applied only with at least one chapter.

After applying, the page becomes the report: how many chapters were imported and which were skipped
(identical, a run started meanwhile, or no longer in the book), the speakers added and the ones not
added, terms added, voices set, the voice samples now waiting, what was refused or ignored, and the
cast and dictionary differences the book kept. **Another file** puts the plan aside.

### Writing the script

**The restore path, not a new one.** For each ticked chapter the store
([src/stores/transfer.ts](../src/stores/transfer.ts)) does what restoring a version does:
`planRestore` ([scriptHistory.ts](../src/lib/scriptHistory.ts)) carries every rendered clip across
line by line and re-judges it, and the chapter is written through `PUT …/script` into `editScript`
([server/script/ops.ts](../server/script/ops.ts)) with the revision it was read at, so a script
that moved meanwhile is a 409, not an overwrite. The server keeps the current script in the
chapter's history first, and a chapter whose `scriptSignature` is unchanged adds no entry.

**Changed words are corrections.** A restore would leave a line with new words without a clip; an
import's corrected line is a rewrite of the line it replaces, so `planImport` carries the old clip
across to it and marks it stale, there to play until the line is narrated again, the way an edit in
the reader leaves it.

**The history says where it came from.** The version origin is
`{ kind: "imported", file, chapters }`: labelled "Imported from The Gate.script.zip", badged
"imported", with the note "38 chapters in one import".

### Cast and dictionary

**Add what's missing, keep what's there.** A speaker the book lacks is added with the file's
details, but only when an applied line uses them; the rest are reported as not added. A speaker a
line names that neither the book nor the file has (a lone chapter file carries no cast) comes in the
way a restore brings one, unreviewed, for the Cast page to merge. A speaker the book has keeps its
own details; only **aliases are unioned**, which adds matches and loses nothing. Dictionary terms
the book lacks are appended; a term it has keeps the book's pronunciation.

**Replacing is offered, not assumed.** The report lists each speaker and term that differs, the
book's value beside the file's, with **Use the file's** per row and **Replace all N** when there
are several, each an undoable toast. Replacing a speaker changes gender, description and style;
replacing a term changes `say`, `ipa`, note, match-case and enabled. The dictionary is written whole,
so the clips a term change stales are staled and restored the way a dictionary edit already does.

### Voices

**Chosen per speaker, because voices are the part of a book most tuned by hand.** One row per
speaker whose voice the file names: the book's voice now, the file's, and a tick, with a tick for
all at the top. A row starts ticked only for a speaker the import adds or one on the Narrator's
voice (`voice: null`), and only when the voice can be used; a voice you chose starts unticked.

**A voice applies only when it is plainly the same voice.** The hint names a voice by host, id and
label; an endpoint id means nothing on another install. A row is usable when an **enabled**
endpoint whose base URL has that host lists a voice with that id **and** that label: a label that
differs is some other voice that happens to share an id. Several such endpoints offer a choice.

**A public voice not here yet is offered for adding.** The server asks each same-host endpoint
through the voice lister ([server/providers/voices.ts](../server/providers/voices.ts)): the
`library` source answers a provider's own voices (OpenAI's, Gemini's prebuilt, Qwen's system
voices) without a request, and a Fish endpoint also searches its `public` catalogue for the id.
Found, the row reads _Add to <endpoint> and use_, and applying adds the voice to that endpoint
first. Every lookup in one plan shares a 15-second deadline.

**A private clone offers Keep or Replace.** A clone lives on someone else's account and cannot be
fetched. Its row names the voice the file expected, _a private voice on another account_, and
offers **Keep** (the current voice, or the Narrator's for a new speaker) or **Replace…**, the voice
picker over this install's voices. A provider that could not be asked in time, or refused, is not
called private: the row says it could not check the host and why, and offers the same two choices.

### One Undo for the whole import

The toast's Undo writes each chapter's previous script back, puts back the voices and aliases it
changed, takes any public voice it added off its endpoint, restores the dictionary, sets aside the
voice samples it kept (bringing back any it replaced), and then removes the speakers it added unless
a line still uses them. The scripts go first, so a speaker removed while the server's script still
names them does not hand their lines to the Narrator.

## Voice samples

A private clone exists only on the account that made it, so in someone else's hands it is a name
with nothing behind it. Carrying the samples it was made from lets the recipient make the voice
again on their own account, with their own consent.

### Kept when a voice is cloned

An export can only carry what the server kept, so cloning keeps its samples: once the provider
answers, the samples are written under `VOICE_DIR` beside a `cloned_voices` row holding when
consent was given and the sentence that was agreed to, a `voice_samples` row per sample holding its
transcript when the person gave one. A transcript does not yet travel in a script file:
`consent.json` lists only each sample's file, name and format, and the import's
`speaker_sample_files` table has no column for one; when a kept row does carry a transcript, the
clone form's prefill fills it in.
[The providers](backend.md#the-providers-and-where-a-key-lives) describes which providers clone,
the limits, the tables and the routes under `/api/endpoints/:id/voices/:voice/samples`. On the
Voices tab a voice with kept samples says **N samples kept**, and **Forget** drops them and keeps
the voice, with Undo.

**Older clones can be given samples.** Nothing marks a voice on the account as a clone, so the
server cannot tell a voice cloned before samples were kept from any other. Every voice without kept
samples on an endpoint that clones offers **Keep its samples…**, which takes the same picker,
limits and consent tick as cloning and sends nothing to the provider. The alternative, re-cloning,
would leave a duplicate private voice on the account.

**Reconciled on save, not cascaded.** A save of the endpoints replaces every voice row, so a
foreign key from the sample tables to `voices` would empty them on every save. `reconcileClones`
([server/db/voiceSamples.ts](../server/db/voiceSamples.ts)) lines them up with each saved
configuration in the same transaction instead. A clone whose voice has left is marked missing
rather than deleted, because removing a voice or an endpoint offers Undo and a settings import can
drop a voice and bring it back; a clone the page has not saved yet is spared, because the clone
answers before the page saves the voice it made. Either goes on the first save a day later, as a
forget does. Removing a voice removes its samples in the end on purpose: keeping someone's
recordings after the voice itself is gone is exactly what the consent never covered.

### In the export

**Off unless asked for, and it says what it hands over.** When some speaker's voice has samples
the export can carry, **Export script** in the book menu becomes **Export script…** and opens one
checkbox, **Include voice samples**, unticked every time: recordings of a person are not a setting
to remember. Under it, one line says what ticking it adds, from
`GET /api/books/:id/script-export/samples`: _Recordings of 3 voices (Mira, Kael, Vex) · 41 MB.
Share them only with someone the voice's owner agreed to._ The download is then
`GET …/script-export?samples=1`. The Scripting page's link always exports without samples.

A speaker's samples are those of the clone they are voiced by, unless its samples were forgotten or
the voice has left the saved configuration; failing that, samples still waiting with the speaker
from an earlier import, carried again under their original consent. A recording gone from disk is
left out, and a voice with none left is not carried.

**The folder.** Each carried voice gets `voices/<slug>/`, the slug from the speaker's name (with
`-2`, `-3` for a clash), and that speaker's `cast.json` entry names it: `"samples": "voices/mira/"`.
The recordings are `sample-1.<ext>`, `sample-2.<ext>` and so on, stored uncompressed because audio
barely compresses, byte for byte as they were kept. Beside them `consent.json` says what they are
and what was agreed to:

```json
{
  "format": "audiobook-studio/voice-samples",
  "version": 1,
  "title": "Mira",
  "consentAt": "2026-09-12T10:04:31.000Z",
  "consentText": "This is my voice, or …",
  "samples": [{ "file": "sample-1.wav", "name": "mira-take-2.wav", "format": "wav" }]
}
```

`title` is the voice's name where it was kept, `consentAt` when the box was ticked, `consentText`
the sentence it said, and each sample's `name` the name it was picked under. `format` is one of
`wav`, `mp3`, `m4a`, `opus`, `flac`.

### In the import

**Judged a folder at a time, against the clone limits**
([server/speakerSamples/folder.ts](../server/speakerSamples/folder.ts)). A folder is usable when
its `consent.json` reads and every recording it names is there, is audio by its first bytes
(`sniffSample`, whatever its name says), and fits the limits a clone is held to: 20 MB a recording,
100 MB a voice, at most 20 recordings. A folder that fails is refused whole and says why; the
lines, the cast and every other voice still import.

**A record of consent, not permission.** On a voice row that is private or could not be checked,
the plan adds _Samples included · 3 recordings, 12 MB · consent recorded 12/09/2026: "This is my
voice, or …"_, or _Samples not kept_ with the reason. It never ticks the recipient's box.

**They wait with the speaker, not with a voice.** An imported sample has no voice to belong to,
because no provider has made one here. When the import is applied, the page sends the same file to
`POST /api/books/:id/speaker-samples` with the speakers whose samples to keep, and the server reads
and judges it again, since the plan route wrote nothing and a request is not trusted to say what a
file holds ([server/speakerSamples/store.ts](../server/speakerSamples/store.ts)). Each speaker gets
a `speaker_samples` row (book, speaker, voice title, consent, source file name) with a foreign key
to `characters(book_id, name)` that cascades on update, so a rename carries them the way it carries
the lines, and a `speaker_sample_files` row per recording. The files live in
`<AUDIO_DIR>/<bookId>/samples/`, named by a hash of their bytes, so removing the book removes them
with nothing else to remember. A second import that carries samples for the same speaker sets the
earlier ones aside, and its Undo brings them back. A merge moves a speaker's samples to the speaker
merged into; removing a speaker discards them.

The rest of `/api/books/:id/speaker-samples` is a `GET` of the waiting samples, `GET
…/:sampleId/files/:file` for one recording, `DELETE …/:sampleId` to discard and `POST
…/:sampleId/restore` to take a discard back
([server/routes/speakerSamples.ts](../server/routes/speakerSamples.ts)).

**On the Cast page.** A speaker with samples waiting shows them on their record (_3 recordings of
"Mira", 12 MB · from The Gate.script.zip_), with **Clone on the Voices tab →** and **Discard
samples**. A discard hides them at once and is final a day later, the way a forget is on the Voices
tab, so the toast offers Undo. The import report shows the same link.

### Cloning from them

**Import never clones.** Cloning is a one-shot upload that needs the person's own consent, so it
stays a step taken on the Voices tab.

**The link fills the form; it does not submit it.** The link opens the Voices tab of the enabled
endpoint that takes the samples best: one that takes every sample as it is, else one that takes
each sample's format and size but fewer of them, else the first that clones at all, where the tab
says what stands in the way. When nothing can clone, the link is replaced by one to the Endpoints
page. The tab fetches the recordings as files and fills the clone form's name and samples, cut to
what that provider takes. It shows the file's consent record as someone else's, and the consent box
starts unticked whatever the file says; the person reads the form, ticks it and presses **Make
voice**. The speaker comes from the server's row, not the address, so a rename after the link was
made still finds them.

**After cloning, the voice goes to the speaker.** The link came from one speaker, so a trip back to
**Replace…** would add no decision. When the clone succeeds, the voice is assigned to that speaker,
with Undo, but only if the speaker's voice is still what it was when the link was opened; otherwise
it is only added to the endpoint, and the toast says why. Either way the waiting samples are set
aside: the clone has kept them now.

## Not supported

- Importing into a book that does not exist yet.
- Choosing chapters on export: export always writes the whole book.
- Cloning inside import, or checking whether the same voice already exists on the recipient's
  account.
- Carrying the samples of voices that are not clones with kept samples.
- Trimming, transcoding or editing samples, or keeping the transcripts a provider makes of them.

## Tests

- [tests/scriptFile.test.ts](../tests/scriptFile.test.ts): markers written and read back, with
  suffixes, braces, escaped ids and two at one place, and malformed ones refused; chapter file
  names; a chapter round trip keeping its `scriptSignature`; a tag the endpoint lacks arriving as
  needing review.
- [tests/server/scriptExport.test.ts](../tests/server/scriptExport.test.ts): `sourceHash` across
  markup and one changed word; the zip's manifest, cast with voice hints, dictionary and one file
  per scripted chapter; voice samples only when asked, with their consent, and when a clone's are
  left out.
- [tests/server/scriptImport.test.ts](../tests/server/scriptImport.test.ts): reading a hand-made or
  broken zip and a lone chapter; matching by source, the fidelity check, duplicate hashes; cast and
  dictionary differences; voice matching, lookups and default ticks; voice folders judged and
  refused; that the route writes nothing.
- [tests/server/speakerSamples.test.ts](../tests/server/speakerSamples.test.ts): keeping waiting
  samples, a rename, a merge, a removed speaker or book, discard and its purge a day later.
- [tests/server/voiceClone.test.ts](../tests/server/voiceClone.test.ts) ("the recordings a voice was
  made from"): samples kept byte for byte with their consent, a keep that fails, a removal and its
  grace period, keeping samples for an older voice.
- [tests/cloneForm.test.ts](../tests/cloneForm.test.ts) ("where a clone link opens"): which endpoint
  the clone link picks.
- [tests/history.test.ts](../tests/history.test.ts) ("importing a script file", "voice samples a
  script file carries"): a round trip adds no history, a corrected word stales one clip, a busy
  chapter is left alone, one Undo takes everything back, **Use the file's**; samples waiting,
  replaced and restored, and a cloned voice assigned only when the speaker's voice has not moved.
