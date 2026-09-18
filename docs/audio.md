# Audio review, expressions and playback

[Back to README](../README.md) · [Bulk re-narration](scripting.md#bulk-re-scripting-and-re-narration) · [Export](exports.md)

Seeded clips have no generated audio files: playback is timed and waveforms are illustrative. Browser voice previews can use speech synthesis. The behavior below describes the interactive prototype, not a real TTS integration.

## Audio review and segment boundaries

The two things a listener cannot do without once the pipeline runs end to end. A request that succeeds
can still produce bad audio, and the model's idea of where one segment ends is not always right.

**Audio review and retakes** (narration ledger). Any rendered row can be flagged — _wrong
pronunciation_, _bad delivery_, _awkward pause_, _something else_ — with a note (`f`, or the ⚑ button;
`⚑ Retake flagged (n)` does the whole chapter at once). `↻` (or `t`) queues a **retake**, which renders
into `segment.candidate` — a clip of its own, standing _beside_ the one in the book. Nothing else in the
app reads it: while it renders and while it waits, the chapter still plays, still times and still exports
the accepted clip, so **nothing is applied until you choose**. The row opens a compare panel with both —
play either, see what differs (direction, voice, style, pronunciation, or the line itself) — and
`Keep take 2` / `Keep take 1` (`a` / `x`) decides. Keeping the new one moves it into `segment.audio` and
pushes the old clip into the take list; keeping the old one drops the candidate, marks it rejected in the
list, and leaves the flag up, because the complaint is still true. A kept clip is then re-checked against
the script: if it went out of date while the retake rendered, it says so instead of passing as current.
Every take stays in the row's details panel with its own play button. Flags also show on the line in the
script reader — a mispronunciation is usually fixed there, not by rendering again.

The ledger row was compacted to make room for all this: the line itself gets the space, speaker / voice
/ endpoint share one column, and every action is one icon size in a fixed slot — ▶ stays, `⇥ ↻ ⚑`
appear on hover or keyboard focus (always on touch), so a raised flag is the only standing mark.
The flag popover and the row's details link to the line in the reader (`e` on a focused row does
the same), because a wrong speaker, direction or word is fixed in the script, and a retake would
only read the same request again.
Clicking a row (no `i` button) opens its details: one strip of labelled facts — voice, endpoint, model,
type, time, latency, cost, then style and direction last, where a whole-phrase direction can run as long
as it needs to — then, only when they apply, an amber line saying how the
script has moved since the clip with `Render it again` next to it, the failure with its response body,
every take as a play chip with the one in the book marked, and the per-request cuts folded away.

**Segment boundary corrections** (script reader). Open any line and use **Boundaries**: `⁄ Split…`
(`s`) turns the text into clickable word gaps — sentence ends are marked `⁄`, click a gap to cut there
— and `⌃ Join up` / `⌄ Join next` (`m`) fold a line into its neighbour, the tooltip naming the
neighbour and warning when the speakers differ. A split keeps speaker, type and direction on both
halves and opens the second one, which is usually the half that needs a different speaker; a join keeps
the first line's attributes and carries over any flag. An unverified chunk can be split by hand as well
as re-split by the model — doing so drops the "unverified" mark, since the boundaries are yours now.
Both actions are undoable (toast, `⌘Z`) and both invalidate the audio they touch: the line that changed
goes stale, a new half has no audio at all, and `↻ Re-narrate changed` covers both. The whitespace a cut
falls in is prose, not padding: a split records it on the first half (`segment.sep`) and the join that
undoes it puts it back, so a paragraph break survives the round trip character for character.

`pnpm test` covers the store side of all of this in [tests/segments.test.ts](../tests/segments.test.ts): the prose survives a
split (paragraph break included, and the join restores it), halves and joins carry the right state, a
retake leaves the book's clip and the chapter's length alone while it renders and after it lands, and
dropping one leaves the kept clip exactly as it was — with its audit trail, and marked stale if the
script moved under it meanwhile.

## Pronunciation and pacing

Both change how the book _sounds_ without changing a word of it, and they sit next to the voices they
affect — Narration → **Pronunciation**.

**Per-book dictionary.** `term → say it as`, applied to every request on its way out; the reader, the
export source and script text keep the author's spelling. Longest term wins (`Ji Ning` over `Ning`),
matching is whole-word and case-insensitive unless you tick _match capitals exactly_ (for `Qi` vs
`qi`), a replacement is never itself re-matched, and an entry can be switched off without losing it.
Each row shows how many times it occurs in the scripted chapters and opens a preview of a real line,
before and after. Words the dictionary rewrites are underlined in the reader (hover for the
respelling); a rendered clip records what was actually sent (`said`), so the ledger can show `sent …`
in its details and tell "the script changed" apart from "the dictionary changed". Because a clip
rendered with the old spelling is now wrong, editing an entry marks exactly those lines stale (one
undoable toast, with `↻ Re-narrate them` for the whole book) — including a request that was still in
flight when it was edited, which lands stale instead of passing as current. Every render is checked
against the script the moment it comes back (`clipDrift` in the store is the single definition of "this
clip no longer matches", shared by the ledger's amber line, a finished render and a rejected retake).

Reach it from where the problem is heard: flag a clip as _wrong pronunciation_ and the popover offers
the likely word with **Add to dictionary**, which opens the tab with it already in the box. A retake
alone would read the same spelling again.

**Pacing.** Silence is stitched between clips, not rendered, so it costs nothing and invalidates
nothing. The book has two defaults — after a line, and when the speaker changes — and any single line
can override them from the reader's **Pause after** row (`book · 0.7s`, `run on`, `0.25s` … , or
`[` / `]` to nudge). A line that holds shows the gap where it falls in the prose, the chapter's length
includes it everywhere it is quoted, and the ledger's scrubber draws the silence between clips.

[tests/speech.test.ts](../tests/speech.test.ts) covers the matcher (whole words, longest first, match case, no cascade), the
gap rules, and the store: the endpoint gets the respelling while the script does not, a term change
stales only the clips that used it and undo puts them back, and a pause re-times a chapter without
touching a single clip.

## One player across the app

The player was a per-view timer: `usePlayer()` returned fresh state to every component that called
it, so leaving the narration page stopped the audio, and a chapter was one undifferentiated block of
`total` seconds. Reviewing a book is the opposite of that — you listen _while_ fixing the script, the
cast or the dictionary, and you listen for hours.

[src/composables/usePlayer.ts](../src/composables/usePlayer.ts) is now a **singleton sequencer**. Its unit is not a file but a
**queue**: clips with the stitched silence between them (`pauseAfter`), the same timeline the ledger
already drew. It owns the layout, the gaps and the playhead; an `<audio>` element is only the sound
source, and the reactive media state around it (`currentTime`, `rate`, `waiting`, `ended`) comes from
VueUse's `useMediaControls`, which was already a dependency. No player library models a timeline of
many short clips with computed silence, so none was added.

- **It survives navigation.** The state is module-scope, and [components/MiniPlayer.vue](../src/components/MiniPlayer.vue) follows you
  off the page that started it — transport, speed, elapsed, and a link back to where it came from. It
  hides on that page, which has the better player of its own.
- **Listening controls.** Playback speed to 2×, ±10 s, previous / next _line_ (prev restarts the line
  unless you only just started it, as every media player does), `space` to play or pause anywhere
  except while a button or link has focus, and OS media keys / lock-screen metadata through the
  MediaSession API.
- **A chapter boundary is not a stop.** A queue carries a `next()`; the ledger's continues into the
  following narrated chapter and moves `?ch=` with it, so the ledger follows the player.
- **Clips carry a `url`.** `SegmentAudio.url` and `Take.url` are the seam: with a file the element
  plays it, without one the clip is _timed_ rather than heard — same timeline, same scrubber, same
  gaps, silent. The prototype renders no files, so the bar says "timed, not heard" rather than
  pretending. Give the clips urls and the same code path plays them.

**Waveforms in the retake compare panel** ([components/Waveform.vue](../src/components/Waveform.vue), [wavesurfer.js](https://wavesurfer.xyz)
v7). Judging two takes of a line is partly a thing you see: dead air, a clipped ending, a flatter
read. wavesurfer is used **directly**, not through a community Vue wrapper, for the reason Unovis is
on the endpoints page — and here a wrapper would be in the way, because this component _draws_ and
does not _play_. The app has one playback engine, so the element stays out of wavesurfer's hands:
`interact` reports clicks as seek requests and the playhead is pushed in from outside with
`setTime`, which works with no media attached because `getDuration()` falls back to the decoded
peaks. `usePlayer().clipProgress(id)` answers "how far through this clip is the playhead", so a view
can ask about any clip it drew without knowing where in the queue it sits.

With a `url` wavesurfer decodes the real file. Without one there is nothing to decode, so
[lib/peaks.ts](../src/lib/peaks.ts) invents a speech envelope — syllables about four a second, a breath or two, seeded by
the clip's identity so a take's shape is stable across redraws and two takes look related but not
identical — and the panel says **waveform illustrative** next to what differs. Invented, and marked
as invented, like every row `FixtureEndpointService` produces. The library is a lazy chunk
fetched the first time a compare panel opens, not part of the entry bundle.

[tests/player.test.ts](../tests/player.test.ts) fakes the clock and `setInterval` and covers the sequencer: the gap is part of
the queue but is no clip, the playhead runs through it into the next line, speed scales the timed
clock, a queue that runs out continues into the next one (and stops when there isn't one), and
scrubbing a chapter that isn't loaded parks the playhead without starting it.

## Model-specific expressions

TTS endpoints have an **Expressions** tab for explicitly configuring supported names, exact bracket
syntax, and whether each tag is a vocal sound or delivery instruction. Support starts unknown and is
bound to the configured model and base URL; changing either requires confirming support again.
No provider capabilities are inferred from its name. Some fixtures explicitly seed illustrative support for testing; this does not verify that the named real model supports those tags.

Expanded script lines offer a searchable expression picker, placement controls,
inline annotations, and an exact outgoing-text preview after pronunciation replacements. Annotations
are separate from prose: existing bracketed text is never automatically interpreted as a control.
Splitting, joining, and editing preserve annotation positions where possible and request review
when an edit affects an anchor. Request splitting keeps each expression token intact.

Narration and retakes check compatibility before queuing and again before dispatch. A review dialog
lets the user resolve unsupported annotations or explicitly omit them; omission is saved and
reversible, never silently applied. Changes invalidate affected audio, and take snapshots and job
events retain the expressions actually rendered. These workflows use the existing simulator; no
real speech or provider capability verification is performed. Book annotations remain in memory.

## Editing a line in place

Placing an expression used to mean a form: a tag
from one dropdown, a position from another whose options were fragments of the sentence, then
Insert; every placed expression was a card of its own, and on the seeded models the button led to
a grey box saying the model had no tags. Cutting a segment hid its cut points until hovered,
dropped the quotes and chips from the line while cutting, and lived outside the editor the joins
lived in. Both now use one gesture, the gaps between words ([src/lib/gaps.ts](../src/lib/gaps.ts),
[src/components/WordStrip.vue](../src/components/WordStrip.vue)): **Add expression** turns the line into a strip with its gaps
showing as ticks, darker where a sentence ends; click the gap and a picker opens under it with the
model's tags, searchable, sounds and delivery apart. The chips on the line are the controls —
click one to replace, move (back to the gaps), omit or remove it. **Split…** sits beside the
joins in the editor and shows the same strip, with the quotes and chips kept; hovering a gap shows
both halves as they would come out, and hovering a join shows the merged line and who would read
it, inline rather than in a tooltip. ← → walk the gaps, Enter cuts or places, Esc leaves; `s` and
`m` still split and join from the reader. When a model has no tags the button reads **Set up
expressions for gpt-4o-mini-tts** and opens the configuration in place. The seeded OpenAI endpoint
ships with a dozen illustrative tags (`EXPRESSION_TAGS` in [src/mock/fixtures/endpoints.ts](../src/mock/fixtures/endpoints.ts)), and the Demo tools
row **Expressions placed in a line** opens the reader on a line that has some, one of which needs
its position chosen again. [tests/reader.test.ts](../tests/reader.test.ts) covers the gaps and the row.
