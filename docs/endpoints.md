# Endpoints and queue activity

[Back to README](../README.md) · [Pricing and usage](pricing.md) · [Store ownership](../src/stores/README.md)

Endpoints, their keys, the usage ledger, budgets and job activity all live on the server and
persist. This page describes them from the user's side: how requests are priced is in
[pricing](pricing.md), and how the server talks to providers and keeps keys is in
[the providers](backend.md#the-providers-and-where-a-key-lives).

**Simulated endpoints.** An endpoint whose base URL is `simulated://…` is answered by the server
itself — a quiet tone per line, or a script read from the prose's punctuation — and never reaches
the network or needs a key. Its requests are priced at its rate card like any other, so a budget
can run out and a cost can be read, but every row is marked simulated and nothing is billed. In the
demo library every endpoint is simulated: each keeps its provider's name and rate card, with
`simulated://` in front of the same host and path.

## Endpoints page

`/endpoints` is app-wide: every scripting, speech and transcription endpoint in one list, across every book. The
per-book panels on the Scripting and Narration pages keep the routing work that belongs beside a
book and link here, and `⌘K` reaches the page and can pause or resume any of them from anywhere.
The route is lazy (`() => import("@/views/EndpointsView.vue")`), which keeps the charting library
out of the entry chunk.

A strip across the top answers four questions: active requests, waiting requests, spend today, and
endpoints needing attention (a button that opens the first one). Searchable cards on the left filter
by All / Scripting / TTS and show name, model, enabled state, observed health, active-over-configured
concurrency and one line of pricing at the rates in force now. The header exports and imports
endpoints, scripting profiles, the default prompt and script settings as JSON, never keys.
Explanations sit behind a **?** beside each label (`UiHint`, one sentence on click); what stays
inline is at most a line, plus warnings and counts.

The selected endpoint fills the right side behind tabs. A scripting endpoint has Overview,
Connection, Requests, Prompt, Pricing & budgets and Activity; a speech endpoint has Voices and
Expressions in place of Prompt. Tab selection, activity filters and unsaved connection edits survive
leaving the page.

### Overview

Throughput, latency, spend and errors over 1h / 6h / 24h / 7d, drawn with
[Unovis](https://unovis.dev) (`@unovis/vue`) along the lines of shadcn-vue's chart recipe: the Vis
components are used directly rather than wrapped, and series colours come from `--chart-*` tokens
in [style.css](../src/style.css), so the SVG and the HTML legend beside it are painted from one
source.

- Queue wait (our side, waiting for a slot) is totalled separately from provider response time; the
  latency chart stacks the two.
- Throughput is tokens per minute for scripting and minutes of audio per minute for speech, over
  the requests that reported usage; the rest show as "N without usage", never as zero. When none
  reported, the tile reads "—" and "usage not reported" and the chart plots requests per minute.
- Outcomes separate first-attempt success from eventual success and count rate limits, retries and
  failures.
- Clicking a bar filters the Activity tab to exactly the requests in that bucket; chart and list are
  folded from one array of records.
- SVG bars cannot hold focus, so the plot is a keyboard control: focus it, `←`/`→` walk the buckets,
  `Enter` picks one, `Esc` clears, and the readout under the chart is a live region that announces
  each one.

### Connection

**Start from a preset…** fills in the base URL, model, prices and limits; every field stays
editable, and the picker copies what it fills in, so editing an endpoint's prices never changes the
preset. Presets are grouped by provider and live in `SCRIPTING_PRESETS` and `TTS_PRESETS` in
[lib/presets/](../src/lib/presets/), re-exported by `lib/endpoints.ts`. Hosted rates are the
providers' published cards on 28 September 2026; a preset's schedule and promotion dates are in UTC.

- **Simulated (free)** comes first in both lists, base URL `simulated://local`, rates at zero. The
  speech one comes with its six voices, so it can render before anything is fetched; it answers WAV
  only, one line at a time, cannot clone, and its failures are retryable server errors. With a
  simulated base URL the tab shows no request path, credential or key field, and typing one over a
  hosted URL turns the key off.
- **Speech:** Fish Audio S2.1 Pro and S2.1 Pro Free; OpenAI gpt-4o-mini-tts, tts-1 and tts-1-hd;
  Gemini 3.8 Flash TTS and Flash-Lite TTS, and the legacy 3.1 Flash TTS; ElevenLabs Eleven v3,
  Multilingual v2 and Flash v2.5; BreezeBlue Breeze TTS 2 and 2 Multilingual; MiniMax Speech 2.8 HD
  and Turbo; Cartesia Sonic 3.6; Alibaba Qwen-Audio 3.0 TTS Plus and Flash; and an OpenAI-compatible
  server on your machine, Kokoro or vLLM-Omni.
- **Scripting:** OpenAI GPT-6 Luna, Sol and Astra; DeepSeek V4.1 Flash; Gemini 3.8 Flash and 3.1
  Pro; Claude Opus 5.5, Sonnet 5 and Haiku 4.5 through Anthropic's OpenAI layer; xAI Grok 4.7 and
  4.3; Ollama and LM Studio on your own machine; and, through OpenRouter, the models near the top of
  its Artificial Analysis Intelligence Index list on 28 September (Claude Opus 5.5, GPT-6 Astra and
  Sol, Grok 4.7, Qwen3.8 Max, MiMo-V2.6-Pro).
- **OpenRouter's rates** are its listing, which need not be the provider's own card nor what a
  request is charged: OpenRouter bills at whichever of its providers serves the request and reports
  that cost with each answer, and that is the cost the ledger records. Grok 4.7 was listed at
  $1.60 / $4.80 against xAI's $2 / $6, and served that day only at $3.20 / $9.60.
- **Provider quirks the presets carry:** DeepSeek's weekday peak hours are a schedule on the Pricing
  tab over an off-peak card. Gemini 3.8 Flash's 2026 price, for scripting and speech, is a promotion
  that ends when its 2027 card applies. Gemini 3.8's speech presets start with Google's recommended
  vocal tags (`<laugh>`, `<sigh>`, `<short pause>` and the rest) on the Expressions tab.
  BreezeBlue's bill the text but not the instructions beside it. gpt-4o-mini-tts is cut at 1,500
  characters, since the model reads at most 2,000 input tokens, and MiniMax at 3,000, above which
  it recommends streaming.

On this tab a picked preset is staged with the connection edits, prices and limits included: Save
applies all of it, Discard drops all of it, and its note goes when another endpoint is selected.
The Scripting page's endpoint manager has the same picker (`usePresetPicker`) and writes onto the
profile at once, as all its fields do.

The tab keeps apart three things that usually get confused:

- **the model configuration** — this endpoint: its name, model, limits and prices;
- **the provider connection** — base URL and credential, which several configurations may share;
- **the shared quota group** — endpoints on one provider account, whose rate limits and spend add
  up together.

**The key is the server's.** The key field saves it there at once and afterwards shows "Key saved
on the server"; the key never comes back to the page. A named credential only says which account
an endpoint uses, so several endpoints can show they share one; the server keeps one key per
endpoint. See [the providers](backend.md#the-providers-and-where-a-key-lives).

**Edits are staged and applied deliberately.** Changing base URL, model or credential while jobs are
unfinished asks first and says that queued jobs keep the connection they were created with.

**The connection test** sends one small request with the saved settings and key, touching no book
and queuing no job. The tab states its scope and cost before you press it, and both that estimate
and the figure the test reports are priced through the shared engine at the rates in force now, so
a probe inside an off-peak window or under a promotion is quoted at what it will be charged. A
simulated endpoint answers without a request. A server that implements the
[batch speech API](speech-batch-api.md) is asked what it can do when it is tested.

### Voices

Speech endpoints only: the endpoint's voice catalogue, the one place voices are added, edited or
removed. Each voice shows how many speakers across the library use it.

- **Fetch from server** asks the server for the voices the saved key can see, from each provider's
  own listing, and adds the ones not already listed. A voice can also be added by its id.
- **Public voices** (Fish Audio only): search Fish's public catalogue by title or paste an id,
  filter by language, page through, and add one with a click. ▶ on a result plays Fish's own
  recording of the voice, a free file on Fish's CDN; a voice with none is rendered like a listed
  one.
- **▶ on a listed voice** plays the provider's own recording of it where the provider keeps one,
  free. Otherwise the saved endpoint says a sample sentence: a real request, billed once and listed
  under Activity, then kept on the server and replayed from there. A simulated endpoint plays its
  tone and bills nothing.

**Clone a voice** appears on an endpoint whose provider clones — Fish Audio, ElevenLabs,
BreezeBlue, Cartesia, MiniMax, or Qwen on `qwen3-tts-vc-2026-01-22`; a Qwen endpoint on another
model names the model to switch to. An OpenAI-compatible server clones only once its **Make voices
on this server** switch is on (`makesVoices`, off by default — the OmniVoice preset turns it on):
the app cannot tell a server that makes voices from one that does not, and sends one recording and
its transcript to the batch speech API's [`POST /audio/voices`](speech-batch-api.md#voices). It makes a voice from uploaded samples of one person speaking — any audio
file of that one voice:

- The form takes a name and the samples the provider takes; the button is ready once both are.
- The picker offers only the provider's formats and says the limits in one line — Fish and
  ElevenLabs take up to 20 samples, the others one — and lists each sample with a play button, its
  waveform (click to seek), its length and its size. A pick past that keeps the first and says so,
  and a file too large or in a format the provider does not take blocks the button by name.
- **Trim** on a sample selects part of it on the waveform: drag the selection or type its edges,
  **Trim silence** selects from where speech starts to where it ends, and **Play selection** plays
  just that. **Apply** replaces the sample with the selection as a mono WAV at the file's own sample
  rate, faded in and out over 10 ms so a cut mid-sound does not click; a transcript already typed
  for it stays, with a note to check it still matches. A file the browser cannot decode plays where
  it can but has no waveform or trim.
- Where the provider takes a transcript of a sample — Fish Audio and Qwen do, as an option — each
  listed sample has a one-line field for what is said in it. Fish is sent them only when every
  sample has one and transcribes the samples itself otherwise; Qwen uses it to improve the clone.
  The transcript is kept with the sample. Cartesia, ElevenLabs and BreezeBlue take none, and
  MiniMax's text field is a check that refuses a clone whose transcript does not match, so it is
  not offered.
- The provider's advice sits behind the ? beside the picker; what it charges is one line above
  the form, and a clone fee is a row in the Activity list.
- The request is sent once and never retried, so a failure never leaves a second copy on the
  account. The provider keeps the voice as a private voice, and it is added to the list and spoken
  by its id from then on. A provider that asks for the voice to be verified first says so in the
  toast.

**Kept samples.** The server keeps a clone's samples beside the voice, each with its transcript
when one was given, so the voice can travel with a book's script
([script export](script-transfer.md#kept-when-a-voice-is-cloned)). The voice's row then says
**N samples kept**; **Forget** drops them and keeps the voice, with Undo. A voice with none offers
**Keep its samples…**: the same picker and limits, with nothing sent to the provider.
Removing a voice or its endpoint keeps its samples for a day, so the removal's Undo, or a settings
import that brings the voice back, finds them; the first save after that removes them.

Cloning mechanics are in [the providers](backend.md#the-providers-and-where-a-key-lives).

### Requests

- **Concurrency** is an exact number with a slider whose range grows to fit what you type (2,500 is
  as easy to set as 4), with three readouts: configured, in flight now, and the effective limit in
  force (zero while paused, cooling down or missing a key).
- **Batches** (OpenAI-compatible speech servers only): a switch, on by default, and what the saved
  endpoint's server says, asked afresh each time — "Sending up to 16 lines a request, the server's
  limit — up to 32 at once", "This server doesn't take batches", or why it could not be asked,
  with **Check again**. Off, a run sends one line a request whatever the server takes
  (`batch: false`). The
  [batch speech API](speech-batch-api.md) is what a server answers to take them; the **OmniVoice
  server** preset points at [omnivoice-fastapi](https://github.com/builtbybasit/omnivoice-fastapi)
  on `:8000`.
- **Timeouts, retry limit and rate-limit cooldown.** The cooldown is read on every 429, and holds
  off the whole endpoint, not only the request refused.
- **Maximum characters and cut boundary** (zero means a whole chapter), and for scripting the
  output-token ceiling and the reasoning level. The split preview runs the real splitter and checks
  that the pieces rejoin the source character for character.
- **Audio** (speech only): the format every new line is asked for and kept in, the bitrate where
  the format has one, and the sample rate, each narrowed to what this endpoint's API can be asked
  for (`speechFormats` in `lib/endpointShapes.ts`). Fish Audio, for example, offers WAV (16–44.1
  kHz), MP3 (32 or 44.1 kHz; 64, 128 or 192 kbps) and Opus (48 kHz, automatic bitrate only: asking
  it for 24 or 32 kbps came back at about 272 kbps); OpenAI offers the same three with no rate or
  bitrate. A change that leaves a rate or bitrate the new format does not have resets it and says
  so, as does a base URL saved onto another API. MP3 and Opus are about a tenth of WAV's size,
  building an audiobook from them needs `EXPORT_ENCODER=ffmpeg`, and clips already rendered keep the
  format they were made in.
- **Simulated answers** (simulated speech endpoints): how long each answer takes, in milliseconds,
  and the share that fail, in percent (stored as `latency` and `failRate`, 0–1), so a run on it
  moves and fails like one on a real provider. A simulated scripting endpoint has neither: it
  answers each chunk in a tenth of the time its run estimate allows a chunk (`secPerChunk`), and
  never fails.

One line at the foot says when the settings apply: on a scripting endpoint, everything to the
next run, and a run already queued keeps the settings it started with; on a speech endpoint,
concurrency, timeouts, retries and cutting to the next line, and format and sample rate to the next
job. Pause, resume and concurrency are read before every request, so lowering concurrency mid-run
narrows the next batch.

### Expressions

Speech endpoints only: the brackets this model's tags are written in, whether it takes any words in
them or only a fixed list, and the tags themselves as chips; see
[model-specific expressions](audio.md#model-specific-expressions).

### Pricing & budgets

The endpoint's rate card: input and output prices per million tokens for scripting, with optional
cached-input and cache-write rates; for speech, a **billing model** — per 1M characters, per 1M
UTF-8 bytes, per 1M input text tokens, input text tokens plus output audio tokens, per audio minute,
or per request — showing only the fields that model uses, with a worked example priced at the rates
in force now. Both kinds share a peak/off-peak schedule and promotions, behind disclosures that
stay shut on an endpoint that has neither. A blank rate means unknown, never $0. The rules are in
[pricing, usage and budgets](pricing.md).

The tab sets the endpoint's scope beside the books' scope:

- **Daily limit** (one endpoint, all books) is what the endpoint may be charged since local
  midnight, shown against today's spend; blank is no limit. A run bigger than the limit is still
  queued, since a long run spans days, and is refused only when the limit cannot cover its first
  request. Before each request the server adds what was spent today, what requests out now hold
  and this request's worst case; one that would pass the limit stops the run the way a book
  budget does, and the chapter fails naming the endpoint and its limit. Voice samples and clone
  fees count against it too.
- **Book budgets** (one book, all endpoints) are listed with what each book has spent and any
  scripting sub-cap, and are set on each book's overview. When the remaining budget cannot cover
  another request, the run stops dispatching: requests in flight land and are recorded, nothing
  queued is sent, and the chapter fails with the reason.

### Activity

Request history for this endpoint, filterable by status, book and free text, with book and chapter
links, attempts, queue time, response time, usage and cost; it is read from the server's usage
ledger, with in-flight requests first. A row expands to its receipt, a sanitised error body and
copyable diagnostics; anything key-shaped is replaced with `[redacted]` before it is shown or
copied. A waiting request says why in words: paused, concurrency full, rate-limit cooldown, no
credential, budget exhausted, or waiting its turn behind an earlier chapter. Rows sent to a real
provider are marked apart from simulated ones.

### Pause, cancel and health

**Pause is not Cancel.** Pausing a speech endpoint stops new dispatches and holds the queue:
requests already in flight land and are recorded, queued lines wait, and the run resumes where it
left off. A paused scripting endpoint cannot start a run; one already queued or going carries on.
Cancel stops the jobs, and says first how many it will hit, that in-flight work is kept with its
recorded cost, and that nothing already scripted or rendered is deleted. Removing an endpoint
explains the same ground, and has Undo. Pausing is per endpoint: a sibling that shares the base
URL and credential keeps running. Cancel drops queued requests and puts their chapters back as they
were; nothing is refunded. A connection change saved while jobs are unfinished applies to jobs
started after the save — nothing is re-sent or re-priced.

An unused endpoint is never called "Healthy": it reads **Not tested** until something answers and
**No recent activity** once it falls quiet.

### In the demo

The demo's endpoints are the fixtures in `server/demo/seed/fixtures/`, made simulated by the demo's
seed (`server/demo/`), plus the two Simulated presets. Their history is ordinary ledger rows: what a
situation says an endpoint has been through — recent requests, failures, a 429 and its cooldown —
is written as simulated rows costing nothing, and everything run in the demo is appended like any
other request. A reset or a Demo tools situation seeds the endpoints again.

## Scripting endpoints

The Scripting page has a compact endpoint manager above the reader for the endpoints a book's runs
use. Add named OpenAI-compatible base URLs and model IDs, pick one explicitly with **Use for runs**,
and edit Connection, Requests & chunking, or Token pricing in separate tabs. Each endpoint owns its
input and output USD-per-million-token rates, concurrency, maximum characters, cut boundary, maximum
output tokens and reasoning level. The chunk preview preserves source whitespace and shows estimated
input, output and thinking tokens and cost.

**This run** shows chapter and request counts, separate input and output costs, an approximate
duration, and the book's scripting budget: blank means no cap, zero stops paid requests. Prompt
overhead is estimated from the prompt the run would send. Each request reserves its input cost plus
the maximum output allowance before it goes out, then settles to the usage the provider reported.
Spending is read from the ledger, so it survives removing jobs and counts in the book's total, and
the book's overall cap applies to scripting as well as its scripting budget. The server checks a
run's worst case before queuing it (a run that does not fit queues nothing) and again before each
request.

**Scheduling.** The server's queue runs one job at a time, so a book's chapters are scripted in
order; within a chapter, up to the endpoint's concurrency of chunks go at once. A queued job keeps a
snapshot of its endpoint, model, chunking, prices and prompt, so changes apply to the next run and a
new job never silently switches provider. A paused endpoint cannot start a run.

### The prompt

What a scripting model is told is edited in the app, not in code
([src/lib/prompt.ts](../src/lib/prompt.ts) holds the rules; the page and the job share them, so the
preview is what is sent). Three places may change it:

- **The library's default prompt**: the **Default prompt** entry above the endpoint list on the
  Endpoints page, a system prompt and a user message. It starts as the built-in prompt, and **Reset
  to built-in** puts that back (a default equal to the built-in prompt is stored as none).
- **An endpoint's Prompt tab**: **Notes for this model** (a model's quirk: "keep paragraphs apart"),
  placed wherever the prompt says `{{endpoint.notes}}` and kept whatever the prompt mode; then
  _Default_, which sends the library's prompt, or _Replace_, which sends this endpoint's own prompt
  instead. The replacement's text is kept when you switch back to Default.
- **A book's Overview**, in its **Scripting prompt** card (the Scripting page shows a one-line
  summary and an _Edit on Overview_ link): **Notes for the scripter**, placed wherever the prompt
  says `{{book.notes}}`, and **Use this book's own prompt**, which replaces the whole prompt for
  that book.

Prompt edits on the Endpoints page are not saved as you type, unlike the rest of the page — a
half-typed prompt usually has no `{{excerpt}}` yet — but staged behind an **Unsaved changes** bar,
whose Save stays disabled while the prompt has problems. A book's notes and prompt save a moment
after typing stops. Exported settings carry the default prompt and each endpoint's prompt and
reasoning level; a simulated endpoint ignores both.

A book's own prompt beats an endpoint's Replace, which beats the library default, which beats the
built-in prompt. **Notes go only where a tag puts them**: the built-in prompt has a line for each
(`Notes on this book: {{book.notes}}`, `Notes for this model: {{endpoint.notes}}`), and a prompt you
write decides for itself — a book's own prompt pulls an endpoint's notes in by naming
`{{endpoint.notes}}`. Notes the prompt in use has no tag for are not sent, and the page says so
where they are typed, with a button that adds the tag.

**Tags** are `{{name}}` and are filled in per request: `{{excerpt}}` (the text; required once, in
the user message), `{{excerpt.before}}` (the last paragraphs of the chunk before, up to about 800
characters; empty for a chapter's first request), `{{part}}` / `{{parts}}`, `{{chapter.title}}`,
`{{chapter.number}}`, `{{previous.recap}}` (where the chapter before left off, as its model put
it), `{{cast}}` (the known speakers' names, each with gender and other names), `{{cast.details}}`
(one line per speaker, the description too), `{{book.title}}`, `{{book.author}}`,
`{{book.notes}}`, `{{endpoint.name}}`, `{{endpoint.notes}}`, `{{model}}` and `{{expressions}}`
(the tag names your speech endpoints list on their confirmed Expressions tabs, for a prompt that
asks for [expression tags](audio.md#model-specific-expressions)). A line whose tags all come out empty is left out, so
`Notes on this book: {{book.notes}}` vanishes for a book without notes. An unknown tag, a missing or
repeated `{{excerpt}}` or a message over 20,000 characters stops the save. A tag that changes every
chapter is allowed in the _system_ prompt with a warning: it stops the provider caching the system
prompt, and cached input is cheaper.

**The output format is not editable.** The answer is parsed as `{"lines":[…],"cast":[…],"recap":"…"}`
and its lines held word for word against the prose, so the format and the verbatim rule are added
after the system prompt of every request; the editor shows them read-only. `cast` and `recap` are
what a run [remembers between requests](scripting.md#what-a-run-remembers), and a prompt trial
shows both under the lines. The format also says how to write an expression tag — `[[sigh]]`, or
`<<sigh>>` for an excerpt that already has `[[` or `]]` in it — but only when the instructions ask
for tags; the built-in prompt does not, so a prompt that wants them says so, e.g. "Add a tag for
a sigh, laugh or gasp the prose shows, at most one per line, from: {{expressions}}".

A run snapshots the resolved prompt and the book's notes when it is queued, so editing a prompt
mid-run changes only later runs. The estimate and the budget hold price the prompt's real length.
Each scripted version in a chapter's history says where its prompt came from and a short
fingerprint of it, so two runs with different prompts can be told apart.

### Trying a prompt on one chunk

**Try it on one chunk** sits under a book's prompt (with a chapter to pick, and the endpoint the
Scripting page's runs use) and on an endpoint's Prompt tab (with a book and chapter to pick). It
sends the prompt as it stands in the editor, saved or not, with one chunk of a real chapter cut as
the endpoint cuts it, and shows what came back: the lines, the word-for-word check a run would hold
them to (an answer a run would refuse is shown rather than refused), the time, the input, output and
thinking tokens, the cost, and the two messages exactly as sent. Nothing is written — not the
script, its history or the cast.

The request is real: it is held to the book's budget at its worst case first and recorded in the
ledger as `Prompt trial · part P/T`, beside the chapter it was made on (a simulated endpoint bills nothing). The last result
stays, dimmed, when the prompt, part or endpoint it was made with changes. Cancel stops the request
on the server, though a provider may still bill one that had already reached the model.

### Reasoning level

Each scripting endpoint's Requests tab has a **Reasoning** level. _Model default_ sends nothing;
_Off_, _Low_, _Medium_ and _High_ are sent as the host spells them
([src/lib/reasoning.ts](../src/lib/reasoning.ts), which names the provider docs, read on 29
September 2026, beside each rule):

- `reasoning_effort` for OpenAI, Gemini, xAI, Ollama, LM Studio and unknown gateways;
- `reasoning: {effort}` for OpenRouter;
- for DeepSeek, `thinking: {type: "disabled"}` for off and `reasoning_effort` otherwise;
- through Anthropic's compatibility layer, which ignores levels, only `thinking: {type: "disabled"}`
  for off.

Where a host cannot do what was asked, the nearest level is sent and the page says so under the
select: Gemini 3 and Grok 4.7 cannot turn reasoning off, GPT-6 Astra and Claude Opus 5.5 refuse off,
and DeepSeek has no medium. `temperature` is left out where it is refused or ignored: OpenAI when a
level is set or none is (GPT-6 reasons by default), DeepSeek in thinking mode, and Anthropic's layer
on every request.

A reasoning model's thinking counts against **max output tokens** and is billed as output; a
cut-off answer says to raise the cap or lower the level, and the Test button reports the reasoning
tokens a reply used. **Estimates count the thinking**: each request's reasoning tokens and level are
kept in the ledger, and the endpoint's last 20 requests at its current level that reported any give
its thinking as a share of input tokens, which a run's estimate, the chunk preview and a trial add
to the output ("incl. ~1,240 thinking tokens a chunk, from the last 12 requests at this level").
Until such a request has been made, the estimate says thinking is not counted yet. The budget hold
reserves the whole max-output ceiling, which already covers any thinking.

## Transcription endpoints

A third kind, **Speech to text**, turns audio back into words. It is any server that answers
OpenAI's `POST /audio/transcriptions`: one recording a request, sent as a multipart form with the
model, priced by the minute of audio **sent** (`perMinute`, the Pricing tab's one rate). It has
Connection, Requests (concurrency, timeout, retries), Pricing and Activity tabs, and no voices,
formats or splitting.

What uses it:

- **Clone samples.** Beside each sample's transcript in the Voices tab's clone form, where the
  provider takes one, **Transcribe** sends that sample to the first transcription endpoint switched
  on (`POST /api/endpoints/transcribe`) and fills the box with what it heard, to be corrected by
  hand. The request is priced into the ledger with no book, held to the endpoint's daily limit and
  tried once.
- **Checking by ear.** A `check` job sends each narrated line's clip to the first one switched on,
  with the cast's names as hints, and flags a line whose clip says something else
  ([audio](audio.md#checking-by-ear)); priced against the book, by the minute of audio. A server
  that drops the connection for a request with hints and answers it without them (Fermion 0.2.9,
  whose hotwords fail to load) is sent none from then on, until the app restarts.

**Word times.** Asked for `verbose_json` with `timestamp_granularities[]=word`, a server says when
each word starts and ends. `whisper-1`, Fermion's Phonon and faster-whisper servers do;
`gpt-4o-transcribe` and `gpt-4o-mini-transcribe` answer `json` only, so they give the words
without their times. `prompt` carries names the audio is likely to hold: Whisper reads it as
context, Phonon as words to favour.

**Fermion Phonon, locally.** `pip install fermion-research`, then `fermion serve phonon-2 --port
8010` (its default, 8000, is the OmniVoice server's), and the **Fermion Phonon (local)** preset.
English only, free, and far faster than real time. `/v1/models` lists it by its full name; the
Test button says so and the requests still go through, since the server takes `phonon-2` as an
alias.

A simulated transcription endpoint (`simulated://…`) hears the same fixed sentence in every
recording and gives no word times.

## Queue job activity

Running, queued and finished jobs open a right-side detail panel (full width on mobile) with an
**Activity log** and **Run details**. The server records each job's events as it runs, in the
`job_events` table beside the job:

- scripting logs each request answered, with its characters and lines;
- narration logs each line rendered or failed, with speaker, duration, split parts, response time,
  take and error, and a pause or rate-limit wait once per endpoint until a line gets through — a
  full concurrency is the normal state of a busy run and is not logged;
- builds log their progress milestones and the finished export.

The panel separates queue time from run time, offers search and a warnings-and-errors filter, and
expands each event's diagnostic fields. Run details keep timestamps, usage, the estimate and the
reservation (and for scripting what was charged), independent of later chapter changes. **Copy diagnostics** uses an
explicit field allowlist and omits the job's connection snapshot. A demo job seeded without events
says so rather than inventing a history. The newest 1,000 events are kept per job
(`MAX_JOB_EVENTS`) with a visible count of the ones dropped, and removing a job removes its log.
