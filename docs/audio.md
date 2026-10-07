# Audio review, expressions and playback

[Back to README](../README.md) · [Bulk re-narration](scripting.md#bulk-re-scripting-and-re-narration) · [Export](exports.md)

Every clip is a real audio file the server wrote and serves through its `url`: rendered by your speech endpoints in your library, and in the demo a tone at the speaker's pitch, made the first time something plays or builds it ([the demo](demo.md#demo-tools)). Retakes, the dictionary and pacing below behave the same in both.

## What is read aloud

A script holds every word of its chapter, including the words that are not the story: a site's boilerplate marked `watermark` and translator's or author's notes marked `note` ([site text](scripting.md#site-text-and-translators-notes)). Only the lines that are read aloud are rendered, timed and billed. A watermark is never read. A note is read only when the book's **Read translator's notes aloud** is on, which it is not by default. `isSpoken` in [src/lib/siteText.ts](../src/lib/siteText.ts) decides this for every part of the app that deals in audio. A narration run never sends a line that is not read and says how many it skipped. The estimate prices only the lines that are read. A chapter's running time, the player and the ledger's scrubber leave those lines out, and a chapter counts as narrated without them.

A clip rendered before its line was marked as site text is kept but not heard. Marking the line back as story plays the same clip again, with nothing rendered twice, because whether a line is heard depends on its type and not on its clip. A line that becomes read, such as a note after the book turns its notes on or a watermark accepted back as narration, has no clip yet, and **Re-narrate changed** picks it up with the rest.

## Audio review and segment boundaries

A request that succeeds can still produce bad audio, and the model's idea of where one line ends is not always right. These are the two fixes a listener needs.

**Audio review and retakes** (narration ledger, [src/views/narration/JobLedger.vue](../src/views/narration/JobLedger.vue)). Any rendered row can be flagged — _wrong pronunciation_, _bad delivery_, _awkward pause_, _something else_ — with a note (`f`, or the ⚑ button, [FlagPopover.vue](../src/views/narration/FlagPopover.vue); **⚑ Retake flagged (n)** does the whole chapter). A flag is written to its line alone rather than with the whole script, so it names no revision and a run landing clips in the same chapter cannot refuse it: flagging while the chapter narrates keeps the flag. `↻` (or `t`) queues a **retake**, which renders into `segment.candidate`, a clip standing _beside_ the one in the book. Nothing else reads it: while it renders and waits, the chapter still plays, times and exports the accepted clip, so **nothing is applied until you choose**. The row opens a compare panel ([TakeCompare.vue](../src/views/narration/TakeCompare.vue)) with both takes — play either, see what differs (direction, voice, style, pronunciation or the line itself) — and **Keep B** / **Keep A** (`a` / `x`) decides. Keeping the new take moves it into `segment.audio`, pushes the old clip into the take list and clears the flag; keeping the old one marks the candidate rejected in the list and leaves the flag up, because the complaint is still true. A kept clip is re-checked against the script, so one that went out of date while the retake rendered says so. Every take stays in the row's details with its own play button, and flags also show on the line in the script reader.

A mispronunciation, a wrong speaker or a wrong direction is fixed in the script, not by rendering again — a retake would send the same request. So the flag popover and the row's details link to the line in the reader (`e` on a focused row does the same). In the ledger row the line gets the space, speaker / voice / endpoint share one column, and every action sits in a fixed slot: ▶ stays, `⇥ ↻ ⚑` appear on hover or keyboard focus (always on touch), so a raised flag is the only standing mark. Clicking a row (or `i`) opens its details ([RenderDetails.vue](../src/views/narration/RenderDetails.vue)): voice, endpoint, model, type, time, latency, cost, then style and direction; and, only when they apply, an amber line saying how the script has moved since the clip with **Render it again**, the failure with its HTTP status (or "no HTTP status" when no answer came back) and its redacted response body, every take as a play chip with the one in the book marked, and the per-request cuts folded away. **Copy clip record** copies what the clip recorded about its request — endpoint, model, voice, the text and instructions sent, the cuts, the receipt and any failure — as JSON. The request body itself is not recorded, and each provider shapes its own, so none is made up; the endpoint's own requests are on its Activity tab ([endpoints](endpoints.md)).

The Narration page draws nothing from the stores until what it reads has been read: the cast, the open chapter's script, every scripted chapter's script (the run plan, line counts, the dictionary's uses and the book's retakes read across all of them) and the endpoint configuration ([useNarrationData.ts](../src/views/narration/useNarrationData.ts)). Until then the tabs, the run strip and the ledger say they are reading, and a read that failed says so with **Retry** — never "0 clips", "no voices" or "no endpoint configured" standing in for something not read yet.

**Segment boundary corrections** (script reader). Open a line and use **Boundaries**: **Split…** (`s`) shows the line's word gaps — click one to cut there — and **Join up** / **Join next** (`m`) fold a line into its neighbour, naming it and warning when the speakers differ. A split keeps speaker, type and direction on both halves and opens the second, which is usually the half that needs a different speaker; a join keeps the first line's attributes and carries over any flag. Splitting an unverified chunk by hand drops the "unverified" mark, since the boundaries are yours now. Both are undoable (toast, `⌘Z`) and both invalidate the audio they touch: the changed line goes stale, a new half has no audio, and **Re-narrate changed** covers both. The whitespace a cut falls in is prose, not padding: a split records it on the first half (`segment.sep`) and the join that undoes it puts it back, so a paragraph break survives the round trip.

[tests/segments.test.ts](../tests/segments.test.ts) covers splits, joins and deletions and the audio they invalidate; [tests/server/narration.test.ts](../tests/server/narration.test.ts) covers a retake and its verdict, and [tests/server/scriptEdit.test.ts](../tests/server/scriptEdit.test.ts) and [tests/jobsBackend.test.ts](../tests/jobsBackend.test.ts) a flag raised while the script's revision moves under it.

## Checking by ear

A clip can render without error and still say the wrong thing: a dropped sentence, a word read
twice, a line from somewhere else. A **check by ear** hears each clip back on a transcription
endpoint ([endpoints](endpoints.md#transcription-endpoints)) and compares what it heard with the
line, word by word, without anyone listening.

- **What runs.** A `check` job per chapter (`POST /api/books/:id/chapters/check`,
  [server/jobs/check.ts](../server/jobs/check.ts)) on the first transcription endpoint switched on,
  up to its concurrency at once, with the cast's names sent as hints — left out, and said in the
  job's log, for a server that gives no answer to a request that has them. It hears every spoken line's
  clip in the book that has not been heard as the line now reads, so a second check of an unchanged
  chapter does nothing, and a line edited or rendered again since is heard again. **Check again**,
  on the toast that says a chapter was already heard, hears every clip of it once more (`again`),
  so a chapter heard before the comparison changed is heard by the new one. With none
  switched on, the request is refused. Each request is priced against the book by the minute of
  audio sent, and a failed one is counted while the rest of the chapter is still heard.
- **When.** When asked, and after every narration of a chapter whose book has **Check by ear**
  on (`Book.checkByEar`); a check that cannot be queued then — the budget, a check already queued —
  is said in the narration's log and never fails it.
- **What is flagged.** The line and what was heard are compared in their spoken form
  ([src/lib/heard.ts](../src/lib/heard.ts)): numbers as their words ("42" and "forty-two", "IV"
  and "four", "2nd" and "second" alike), Mr/Mrs/Dr in full, and case, punctuation, apostrophes and
  a doubled letter left out ("Umm" and "Um" alike). The score is the share of the line's letters
  heard wrong, each stretch that differs costing its longer side — "gray" heard "grey" is one
  letter, "TV" heard "T V" none, a word read out letter by letter many. A line is a mismatch past
  0.15 with at least four letters wrong, so a dropped "the" in a long line, or an "Ah" heard "Uh",
  passes. A mismatch flags the line `heard`, quoting what was heard; a later check that hears it
  right takes that flag down. A flag a person set is never replaced or taken down, and a check
  never touches a clip. A line whose clip was sent through the pronunciation dictionary is also
  set against what was heard as it was sent — "Siobhan" sent as "Shiv-awn" may be written either
  way — and the closer of the two stands; a clip sent before the dictionary last changed is
  compared as written. A year heard as words ("nineteen ninety" against "1990") still differs.
- **What is stored.** What was heard, kept by the clip's file in `heard`
  ([backend](backend.md#what-was-heard-is-kept-by-file)), and served for the chapter's clips in the
  book (`GET …/chapters/:n/heard`): the line as checked, what was heard, the score, and the offsets
  in the line and times in the clip of each word heard, which the Listen page lights as it plays.
  Word times are the endpoint's own, never estimated: a server that gives none (`gpt-4o-transcribe`)
  gives a score and no marks. Up to three words in a row heard as something like them ("gray"
  heard "grey", "TV" heard "T V") take the time of what was heard in their place, each word the
  heard words its letters line up with, when at least half their letters agree; a word heard as
  nothing, or as something unlike it, has no mark. On a real chapter that left 4 of 1,547 words
  unlit, where matching words alone left 24.

[tests/heard.test.ts](../tests/heard.test.ts) covers the comparison and
[tests/server/checkByEar.test.ts](../tests/server/checkByEar.test.ts) the job.

## The thought effect

A character's thoughts are narrated in the same voice as what they say aloud, so a `thought` line
is given a sound of its own as its clip lands: a little rumble and air taken off, the presence
softened, gentle 2:1 compression and a short room around it
([server/audio/thoughtEffect.ts](../server/audio/thoughtEffect.ts)).

- **On by default**, per book: **Thought effect** on the book page's Reading card
  (`Book.plainThoughts` switches it off).
- **Kept in the file.** It is put on once, as the clip arrives, so the player, the Listen page, a
  check by ear and a build all hear the same clip. A clip that has it says so
  (`SegmentAudio.effect: "thought"`) and is always a WAV at the rate the voice came back at. Lines
  narrated before the switch changed keep the sound they were made with; a retake makes them again.
- **Never in the way.** The endpoint's slot is given back as soon as a line's audio is in, so the
  effect runs while the next line is already out, and generation is no slower. One that fails keeps
  the clip the voice made and says so in the run's log; the line never fails over it.
- **Needs ffmpeg** (`FFMPEG_BIN`), found at boot whatever the export encoder is. Without one the
  boot log says so and thoughts are narrated plain. ffmpeg has no Freeverb, so the room is three
  quiet early reflections (`aecho`).

[tests/server/thoughtEffect.test.ts](../tests/server/thoughtEffect.test.ts) covers it.

## Pronunciation and pacing

Both change how the book _sounds_ without changing a word of it, and both sit beside the voices they affect: Narration → **Pronunciation** ([LexiconPanel.vue](../src/views/narration/LexiconPanel.vue)).

**Per-book dictionary.** `term → say it as`, applied to every request on its way out; the script keeps the author's spelling. The longest term wins (`Ji Ning` over `Ning`), matching is whole-word and case-insensitive unless you tick _match capitals exactly_ (for `Qi` vs `qi`), a replacement is never itself re-matched, and an entry can be switched off without losing it. Each row shows how often the term occurs in the scripted chapters and previews a real line, before and after. Rewritten words are underlined in the reader (hover for the respelling). A rendered clip records what was actually sent (`said`), so the ledger can tell "the script changed" from "the dictionary changed". Editing an entry marks exactly the clips rendered with the old spelling stale — one undoable toast, with **↻ Re-narrate them** for the whole book — and a line still in flight when the entry changed lands stale rather than passing as current. `clipDrift` in the narration store is the one definition of "this clip no longer matches", shared by the ledger's amber line, a kept retake and a restore.

Reach it from where the problem is heard: flag a clip as _wrong pronunciation_ and the popover offers the likely word with **Add to dictionary**, which opens the tab with it in the box.

**Pacing.** Silence is stitched between clips, not rendered, so it costs nothing and invalidates nothing. The book has two defaults — after a line, and when the speaker changes — and any line can override them from the reader's **Pause after** row (`book · 0.7s`, `run on`, `0.25s` …, or `[` / `]` to nudge). A line that holds shows the gap where it falls in the prose, the chapter's length includes it everywhere it is quoted, and the ledger's scrubber draws the silence between clips. Export edits the same pacing rather than a copy ([exports](exports.md)).

[tests/speech.test.ts](../tests/speech.test.ts) covers the matcher (whole words, longest first, match case, no cascade), the gap rules, a term change staling only the clips that used it with undo putting them back, and a pause re-timing a chapter without touching a clip.

## One player across the app

Reviewing a book means listening _while_ fixing the script, the cast or the dictionary, for hours, so the player is a **singleton** ([src/composables/usePlayer.ts](../src/composables/usePlayer.ts)) rather than something a page owns. Its unit is not a file but a **queue**: clips with the stitched silence between them (`pauseAfter`), the timeline the ledger draws. It owns the layout, the gaps and the playhead; an `<audio>` element is only the sound source, with its reactive state (`currentTime`, `rate`, `waiting`, `ended`) from VueUse's `useMediaControls`. No player library models a timeline of many short clips with computed silence, so none is used.

- **It survives navigation.** The state is module-scope, and [MiniPlayer.vue](../src/components/MiniPlayer.vue) follows you off the page that started it — transport, speed, elapsed and a link back. It hides on that page, which has a better player of its own.
- **Listening controls.** Speed up to 2×, ±10 s, previous / next _line_ (previous restarts the line unless you only just started it), `space` to play or pause anywhere except while a button or link has focus, and OS media keys and lock-screen metadata through the MediaSession API.
- **A chapter boundary is not a stop.** A queue carries a `next()`; the ledger's continues into the following narrated chapter and moves `?ch=` with it, so the ledger follows the player.
- **Clips carry a `url`** (`SegmentAudio.url`, `Take.url`), which the element plays. A queue with no url in it is timed in silence instead — same timeline, scrubber and gaps — and the bar says "timed, not heard". Every clip the server keeps has a url; the Audiobooks tab's **Listen** is the one place that still plays such a timeline ([exports](exports.md#building-and-maintaining-an-audiobook)).

**Waveforms in the retake compare panel** ([src/components/Waveform.vue](../src/components/Waveform.vue), [wavesurfer.js](https://wavesurfer.xyz) v7). Judging two takes is partly a thing you see: dead air, a clipped ending, a flatter read. wavesurfer decodes each take's file and is used directly, not through a Vue wrapper, because this component _draws_ and does not _play_: the app has one playback engine, so a click is reported as a seek request and the playhead is pushed in with `setTime`. `usePlayer().clipProgress(id)` answers "how far through this clip is the playhead", so a view can ask about any clip it drew without knowing where it sits in the queue. The library is a lazy chunk fetched the first time a compare panel opens.

[tests/player.test.ts](../tests/player.test.ts) fakes the clock and covers the sequencer: the gap is part of the queue but no clip, the playhead runs through it into the next line, speed scales the clock, a queue that runs out continues into the next (or stops), and scrubbing a chapter that isn't loaded parks the playhead without starting it.

## Model-specific expressions

Speech endpoints have an **Expressions** tab with two questions and a list. **Brackets**: which of `( )`, `[ ]` and `< >` the model's tags are written in — several at once for a model such as MiniMax 2.8, which takes `(laughs)` and `<#0.5#>`, and none for a model that takes no tags. **Tags**: a _fixed list_, where a line takes only the listed tags, or _any words_, where the list is suggestions and a tag can be typed on the line itself (Fish S2, ElevenLabs v3 and Gemini 3.8 take tags in words of your choosing). The tags are chips, each named by its words; typed words go in the first bracket chosen, and changing the brackets moves the tags into them. The tab starts from what the provider's docs show ([src/lib/providers/](../src/lib/providers/)): square brackets and any words for Fish S2 and ElevenLabs v3, angle brackets and any words for Gemini 3.8 (vocal sounds only — delivery goes in the direction), parentheses for Fish S1, parentheses and square brackets for BreezeBlue, angle and square for Cartesia, and no brackets for OpenAI, Qwen and Gemini's older previews, where a tag would be read out as words. The choice is the person's, so a new model can be set up before this app knows it. Support starts unknown and is bound to the configured model and base URL; changing either means confirming again. A configuration saved before brackets were asked for reads as the provider's (`withBrackets` in [src/lib/expressions.ts](../src/lib/expressions.ts)). The demo's Fish endpoint ships with a dozen illustrative tags (`EXPRESSION_TAGS` in [server/demo/seed/fixtures/endpoints.ts](../server/demo/seed/fixtures/endpoints.ts)); that does not verify the real model supports them.

Annotations are separate from prose: bracketed text already in a line is never interpreted as a control. Nor can a voice take it for one: what a voice is sent is a whitelist, applied just before it is sent, after the dictionary and before any tag goes in ([`sayable`](../src/lib/speech.ts)). Latin letters and digits, the punctuation that shapes a reading, the symbols a voice says (`+5`, `10%`, `$3`, `94/100`) and round and angle brackets go through. Everything else does not: asterisks (`*Sip*`), kaomoji and emoji (`(￣▽￣)ノ`, `♡`), HTML tags (a stat sheet's `<p><strong>Level 1</strong>` is sent as "Level 1.", a block's end read as a sentence's), footnote references (`[1]`), a bracket left with nothing said in it, single quotes around a whole line (a thought), and square and curly brackets — nobody says them, and Fish reads `[…]` as its own tag — with the words inside them sent. Round and angle brackets are taken out only where the voice reads them as its own tags — `( )` and `< >` for MiniMax 2.8 — from the Expressions tab once confirmed, or until then from the provider's docs, since the model reads them either way; the words inside are sent. A line with nothing left to say is sent as written. Sent as written, Fish read `'Let me die faster.'` as "Let me die F A S T E R punct apostrophe" and turned `[…]` lines and `*Sip*` into other words entirely. What the dictionary made of the line (`pronounced`, which drift compares) is kept with its marks, so no clip already made turns stale. Splitting, joining and editing keep annotation positions where they can and ask for review when an edit moves an anchor, and request splitting keeps each tag whole. The line's editor previews the exact outgoing text after pronunciation replacements.

Narration and retakes check compatibility before queuing, and the server checks again as each line goes out, failing a line whose tags its endpoint cannot say rather than sending it ([server/jobs/narration.ts](../server/jobs/narration.ts)). A review dialog resolves unsupported annotations or omits them explicitly; an omission is saved and reversible, never silent. Changes invalidate the affected audio, and take snapshots and job events keep the expressions actually rendered. [tests/expressions.test.ts](../tests/expressions.test.ts) and [tests/tagSyntax.test.ts](../tests/tagSyntax.test.ts) cover the rules and the syntaxes.

## Editing a line in place

Placing an expression and cutting a line use one gesture: the gaps between words ([src/lib/gaps.ts](../src/lib/gaps.ts), [src/components/WordStrip.vue](../src/components/WordStrip.vue)). **Add expression** ([ExpressionEditor.vue](../src/components/ExpressionEditor.vue)) turns the line into a strip with its gaps as ticks, darker where a sentence ends; click a gap and a searchable picker opens under it with the model's tags, sounds and delivery apart; on a model set to _any words_, typing words that match no tag and pressing Enter places them as a tag of their own, sent as typed. The chips on the line are the controls — click one to replace, move (back to the gaps), omit or remove it. **Split…** sits beside the joins in the editor and shows the same strip, quotes and chips kept; hovering a gap shows both halves as they would come out, and hovering a join shows the merged line and who would read it. ← → walk the gaps, Enter cuts or places, Esc leaves; `s` and `m` still split and join from the reader. When the model has no tags configured the button reads **Set up expressions for gpt-4o-mini-tts** (the endpoint's model) and opens the configuration in place.

In the demo, **Expressions placed in a line** opens the reader on a line that has some, one of which needs its position chosen again. [tests/reader.test.ts](../tests/reader.test.ts) covers the gaps and the seeded Fish tags.
