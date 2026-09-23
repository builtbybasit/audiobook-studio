# Export planning and updates

[Back to README](../README.md) · [Demo scenarios](demo.md) · [Pacing and playback](audio.md)

In demo mode builds, files, paths, loudness measurements and downloads are simulated, and references below to a version "on disk" describe the modeled workflow rather than a file. **With a server answering they are not simulated** — see [with a server](#with-a-server) at the end.

## Building and maintaining an audiobook

Export was built for the small case — one M4B, a chapter list in a 300px rail, a gap control that
quietly disagreed with the book's own pacing, and "rebuild" as the only word for keeping a finished
audiobook current. A 200-chapter serial breaks all four. The page is now two jobs on two tabs:
**Build** (what goes in, what comes out) and **Audiobooks** (what you have made, and whether it still
matches the book).

**One plan, one truth.** [src/lib/exports.ts](../src/lib/exports.ts) is pure: given the selected chapters, the volumes and
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
entire seeded world, abandoning running work; see [Demo tools](demo.md#demo-tools).

[tests/exports.test.ts](../tests/exports.test.ts) covers the plan (grouping, names, track widths, MP3's missing marks, and that
the file totals equal the plan totals), the blockers (nothing dropped, stale accepted on purpose,
partial ≠ failed), loudness (deterministic, gain closes to target), and the store: a build refuses
what it cannot use, replaces the version it supersedes, keeps the finished version when the next one
fails or is cancelled, and reuses exactly the chapters whose fingerprints have not moved.

## With a server

In backend mode a build is a job the server runs, and the file at the end of it is real: the
rendered clips are stitched together with the book's pacing inside each chapter and the export's
gap between two, written to disk, and handed back by a download. Everything above still describes
the page — the plan, the blockers, the versions, "needs an update" — because the server is asked
the same questions by the same functions. Three differences are worth knowing.

**The build refuses rather than trims, and says so in these words.** `reviewOf` is what the server
asks too, so a chapter with no usable audio, one still being narrated, or a stale one without
_use stale audio_ comes back as the blocker panel's own title and detail. Nothing is queued and no
version goes up for an audiobook that was never going to be built.

**One build at a time per book.** The browser allows two audiobooks of one book to build at once;
the server does not, because a build reads every clip the other one might be replacing. A second
press while one is running is refused, naming the one that is going.

**What it writes depends on the encoder it was started with.** `EXPORT_ENCODER=wav` is the default
and needs nothing installed: it stitches the clips into one real, playable WAV per output file. It
is not an M4B and it writes no chapter marks, so rather than name a file `.m4b` that is not one it
writes `.wav`, reports no markers, and says both in the job's log. `EXPORT_ENCODER=ffmpeg` writes
the format the settings actually asked for, with the chapter marks a player reads and loudness
measured and corrected to the target rather than invented — and, because a span of AAC cannot be
spliced beside audio encoded in the same run, it re-encodes every chapter on an update instead of
carrying unchanged ones over. Under the stitcher carrying over is literal: the bytes of an
unchanged chapter are copied out of the version on disk. [Backend](backend.md#export) has the rest.

**Clips narrated in MP3 or Opus need ffmpeg.** The stitcher joins WAV and nothing else, so a book
with an MP3 or Opus clip in it is refused before anything is written, naming the chapter and the
two ways out: restart with `EXPORT_ENCODER=ffmpeg`, or narrate again with the endpoint set to WAV.
ffmpeg decodes each such clip to WAV in its work directory, so a book narrated partly in one format
and partly in another builds as one; one sample rate a file still applies, with Opus at 48 kHz. The
file is written at the clips' rate — loudness correction resamples inside, and left to itself the
encoder then wrote 96 kHz AAC from 44.1 kHz speech — and a book that is all silence is written
unlevelled, since there is nothing in it to measure.
