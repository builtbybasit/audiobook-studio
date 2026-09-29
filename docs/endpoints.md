# Endpoints and queue activity

[Back to README](../README.md) · [Pricing and usage](pricing.md) · [Store ownership](../src/stores/README.md)

All connections, discovery, requests and costs described here are simulated. See the pricing guide for the shared calculation rules and their limitations.

## Queue job activity

Running, queued, and historical jobs open a right-side detail panel (full-width on mobile). Activity
is recorded by the simulator when jobs queue, start, wait, dispatch, complete, fail, or cancel.
Scripting events include request numbers, retry attempts, token usage, and simulated costs; narration
events include segment/retake identity, endpoint, model, split count, response time, and errors.
Export events record progress milestones and the completed artifact. Waiting reasons are logged only
when they change, so a paused endpoint does not fill the log with duplicate messages.

The panel separates queue time from run time, offers search and a warnings/errors filter, and expands
each event's diagnostic fields. Run details preserve timestamps and scripting usage independently of
later chapter changes. Copy diagnostics uses an explicit field allowlist, omits connection snapshots,
and uses sanitized event data. Old seeded jobs explicitly have no detailed activity rather than
inventing a request history. The latest 1,000 events are kept per job with a visible dropped count;
removing a job or refreshing the prototype discards its log. No real provider calls or persistence.

## Scripting endpoints

Scripting now has its own endpoint manager above the reader. Add named OpenAI-compatible base URLs and model IDs, choose an endpoint explicitly for each run, and edit Connection, Requests & chunking, or Token pricing in separate tabs. Each endpoint owns input/output USD-per-million-token rates, concurrency, maximum characters, cut boundary, and maximum output tokens. Numeric fields accept exact integers (including 2,500 concurrency); slider ranges expand when a typed value exceeds the displayed range. Zero maximum characters means a whole chapter. The chunk preview preserves source whitespace and shows estimated input/output tokens and cost.

“This run” shows chapter/request counts, separate input/output costs, an approximate duration, and a per-book scripting budget. Blank budget means no cap; zero blocks paid requests. Prompt/context overhead is estimated, and seeded rates are illustrative, not current provider quotes. Simulated requests reserve input cost plus the maximum output allowance before dispatch, then settle to simulated usage. Spend survives removing completed jobs and is included in the overview’s total book spend. The overall book cap is also checked by the scripting scheduler.

Concurrent chunk requests share a limit across books on the same endpoint. Chapters remain ordered within each book. Queued jobs keep a snapshot of their endpoint, model, chunking, and prices; changing concurrency or pausing an endpoint affects dispatch immediately. In-flight requests drain while paused. New jobs never silently switch providers. The same budget and scheduling path handles fallback chunk retries. Endpoint removal has Undo, and settings import/export excludes API keys. As elsewhere in this prototype, settings, budgets, jobs, and usage are in memory; no network requests or paid provider calls occur.

### The prompt

What a scripting model is told is edited in the app, not in code ([src/lib/prompt.ts](../src/lib/prompt.ts)
holds the rules; the page and the job share them, so the preview is what is sent). Three places may
change it:

- **The library's default prompt**: the **Default prompt** entry above the endpoint list on the
  Endpoints page, a system prompt and a user message. It starts as the built-in prompt, and **Reset to
  built-in** puts that back (a default equal to the built-in prompt is stored as none).
- **An endpoint's Prompt tab**: **Notes for this model** (a model's quirk: "keep paragraphs apart"),
  placed wherever the prompt says `{{endpoint.notes}}` and kept whatever the prompt mode; then
  _Default_, which sends the library's prompt, or _Replace_, which sends this endpoint's own prompt
  instead. The replacement's text is kept when you switch back to Default.
- **A book's Overview**, in its **Scripting prompt** card (the Scripting page shows a one-line summary
  and an _Edit on Overview_ link): **Notes for the scripter**, placed wherever the prompt says
  `{{book.notes}}` (the page warns when the prompt in use has no such tag), and **Use this book's own
  prompt**, which replaces the whole prompt for that book.

Unlike the rest of the Endpoints page, prompt edits are not saved as you type — a half-typed prompt
usually has no `{{excerpt}}` yet — but staged behind an **Unsaved changes** bar, whose Save stays
disabled while the prompt has problems. A book's notes and prompt save a moment after typing stops.
Exported settings files carry the default prompt and each endpoint's prompt and reasoning level; a
simulated endpoint ignores both.

A book's own prompt beats an endpoint's Replace, which beats the library default, which beats the
built-in prompt. **Notes go only where a tag puts them**: the built-in prompt has a line for each
(`Notes on this book: {{book.notes}}`, `Notes for this model: {{endpoint.notes}}`), and a prompt you
write decides for itself — a book's own prompt pulls an endpoint's notes in by naming
`{{endpoint.notes}}`. Notes that the prompt in use has no tag for are not sent, and the page says so
where they are typed, with a button that adds the tag.

**Tags** are `{{name}}` and are filled in per request: `{{excerpt}}` (the text; required once, in
the user message), `{{part}}` / `{{parts}}`, `{{chapter.title}}`, `{{chapter.number}}`, `{{cast}}`
(the known speakers' names), `{{cast.details}}` (one line per speaker with gender, other names and
description), `{{book.title}}`, `{{book.author}}`, `{{book.notes}}`, `{{endpoint.name}}`,
`{{endpoint.notes}}` and `{{model}}`. A line whose tags all come out empty is left out, so `Notes on this book: {{book.notes}}`
vanishes for a book without notes. An unknown tag, a missing or repeated `{{excerpt}}` or a message over
20,000 characters stops the save. A tag that changes every chapter in the _system_ prompt is allowed,
with a warning: it stops the provider caching the system prompt, and cached input is cheaper.

**The output format is not editable.** The answer is parsed as `{"lines":[…]}` and held word for word
against the prose, so the format and the verbatim rule are added after the system prompt of every
request; the editor shows them read-only.

A run snapshots the resolved prompt and the book's notes when it is queued, like its endpoint and
chunking, so editing a prompt mid-run changes only later runs. The estimate and the budget hold price
the prompt's real length. Each scripted version in a chapter's history says where its prompt came from
and a short fingerprint of it, so two runs with different prompts can be told apart.

### Trying a prompt on one chunk

**Try it on one chunk** sits under a book's prompt (a chapter to pick, and the endpoint the Scripting
page's runs use)
and on an endpoint's Prompt tab (with a book and chapter to pick). It sends the prompt as it stands in
the editor — saved or not — with one chunk of a real chapter, cut as the endpoint cuts it, and shows
what came back: the lines, the word-for-word check a run would hold them to (an answer a run would
refuse is shown rather than refused), the time, the input, output and thinking tokens, and the cost,
with the two messages exactly as sent. Nothing is written — not the script, its history or the cast.
The request is real: it is held to the book's budget at its worst case first and priced into the
book's ledger as `Prompt trial · ch N · part P/T` (a simulated endpoint bills nothing). The last
result stays, dimmed, when the prompt, part or endpoint it was made with changes. Cancel stops the
request on the server, though a provider may still bill one that had already reached the model.

### Reasoning level

Each scripting endpoint's Requests tab has a **Reasoning** level: _Model default_ sends nothing and
leaves it to the model; _Off_, _Low_, _Medium_ and _High_ are sent as the host spells them
([src/lib/reasoning.ts](../src/lib/reasoning.ts)): `reasoning_effort` for OpenAI, Gemini, xAI, Ollama,
LM Studio and unknown gateways; `reasoning: {effort}` for OpenRouter; `thinking: {type: "disabled"}` for
off and `reasoning_effort` otherwise for DeepSeek; only `thinking: {type: "disabled"}` for off through
Anthropic's compatibility layer, which ignores levels. Where a host can't do what was asked, the nearest
level is sent and the page says so under the select (Gemini 3 and Grok 4.7 can't turn reasoning off;
DeepSeek has no medium). `temperature` is left out where it is refused or ignored — OpenAI's reasoning
models (with no level set too, since GPT-6 reasons by default), DeepSeek in thinking mode, and Claude 5
on every request. A reasoning model's thinking counts against **max output tokens** and is billed as
output; a cut-off answer says to raise the cap or lower the level, and the Test button reports the
reasoning tokens a reply used. **Estimates count the thinking**: each request's reasoning tokens and
level are kept in the ledger, and an endpoint's recent requests at its current level (the last 20 that
reported any) give its thinking as a share of input tokens, which a run's estimate, the chunk preview
and a trial add to the output ("incl. ~1,240 thinking tokens a chunk, from the last 12 requests at
this level"). Until such a request has been made the estimate says it isn't counted yet. The budget
hold still reserves the whole max-output ceiling, which already covers any thinking. Provider docs read on 29 September 2026 are named beside each rule.

Validation: `pnpm test` runs the scripting behavior tests with the installed Bun test runner. `pnpm build`, `pnpm lint`, and `pnpm fmt:check` check the application.

## Endpoints page

`/endpoints` is app-wide: both kinds of OpenAI-compatible server in one list, across every book.
Scripting profiles and TTS endpoints were configured in two different places, each buried inside a
book's stage, which left "what is running, what is broken, what am I spending" unanswerable. The
per-stage panels are still there for the routing work that belongs beside a book; each now links up
to this page, and `⌘K` reaches it and can pause or resume either kind from anywhere.

A compact strip answers the four questions at a glance — active requests, waiting requests, spend
today, endpoints needing attention (the last is a button that opens the first one). Searchable cards
on the left filter by All / Scripting / TTS and carry name, model, enabled state, observed health,
active-over-configured concurrency and one line of pricing. The selected endpoint fills the right
side behind tabs: five for scripting, with Voices and Expressions also available for TTS:

- **Overview** — throughput, latency, spend and errors over 1h / 6h / 24h / 7d, drawn with
  [Unovis](https://unovis.dev) (`@unovis/vue`) along the lines of shadcn-vue's chart recipe: the Vis
  components are used directly rather than wrapped, and series colours come from `--chart-*` tokens
  in [style.css](../src/style.css) so the SVG and the HTML legend beside it are painted from one source. Queue wait
  (our side, waiting for a slot) is drawn and totalled separately from provider response time; the
  latency chart stacks the two. Throughput is tokens/minute for scripting and generated audio
  minutes per minute for speech. Outcomes separate first-attempt success from eventual success and
  count rate limits, retries and failures. Clicking a bar filters the Activity tab to exactly the
  requests in that bucket — chart and list are folded from one array of records. SVG bars can't hold
  focus, so the plot is a keyboard control too: focus it and `←`/`→` walk the buckets, `Enter` picks
  one, `Esc` clears, and the readout under the chart is a live region that announces each one.
- **Connection** — starts with **Start from a preset…**, for both kinds. First in each list is
  **Simulated (free)**, base URL `simulated://local`: the server answers it itself — a quiet tone
  per line, or a script read from the prose's punctuation — and it never reaches the network and
  needs no key. Its requests are priced at its rate card, which the preset leaves at zero, and every
  one is marked simulated: nothing is billed. The speech one comes with its six voices, so it can
  render before anything is fetched; it answers WAV only, one line at a time, cannot clone, and its
  failures are retryable server errors. With a simulated base URL the tab shows no request line, credential or key field, and
  typing one over a hosted URL turns the key off with it. After it, a speech provider
  (Fish Audio; OpenAI's gpt-4o-mini-tts, tts-1 and tts-1-hd; Gemini 3.8 Flash and Flash-Lite TTS
  and the legacy 3.1; ElevenLabs Eleven v3, Multilingual v2 and Flash v2.5; BreezeBlue Breeze TTS 2
  and 2 Multilingual; MiniMax Speech 2.8 HD and Turbo; Cartesia Sonic 3.6; Alibaba Qwen-Audio 3.0
  TTS Plus and Flash; an OpenAI-compatible server — Kokoro or vLLM-Omni), grouped by provider, or a
  scripting one, grouped by provider: OpenAI
  GPT-6 Luna, Sol and Astra; DeepSeek V4.1 Flash; Gemini 3.8 Flash and 3.1 Pro; Claude Opus 5.5,
  Sonnet 5 and Haiku 4.5 through Anthropic's OpenAI layer; xAI Grok 4.7 and 4.3; models near
  the top of OpenRouter's Artificial Analysis Intelligence Index list on 28 September (Claude
  Opus 5.5, GPT-6 Astra and Sol, Grok 4.7, Qwen3.8 Max, MiMo-V2.6-Pro) at OpenRouter's listed
  rates — which need not be the provider's own card, nor what a request is charged, since
  OpenRouter bills at whichever of its providers serves it and reports that cost with each answer,
  which is the cost the ledger records (Grok 4.7 is listed at $1.60 / $4.80 against xAI's $2 / $6, and was served that day only at
  $3.20 / $9.60); and Ollama and LM Studio on your own machine. A preset fills in the base URL,
  model and prices, and every field stays editable. The rates are the providers' published cards
  on 28 September 2026, read in UTC, in `SCRIPTING_PRESETS` and `TTS_PRESETS` in
  [lib/presets/](../src/lib/presets/), re-exported by `lib/endpoints.ts`. Gemini 3.8's speech presets start with Google's
  recommended vocal tags (`<laugh>`, `<sigh>`, `<short pause>` and the rest) on the Expressions
  tab; BreezeBlue's bill the text but not the instructions beside it; gpt-4o-mini-tts is cut at
  1,500 characters, since the model reads at most 2,000 input tokens, and MiniMax at 3,000, above
  which it recommends streaming. DeepSeek's weekday peak hours are a schedule on the
  Pricing tab over an off-peak card, and Gemini Flash's 2026 price is a promotion that ends when
  its 2027 card applies. The picker copies what it fills in, so editing an endpoint's prices never
  changes the preset. On this tab a preset is staged with the connection edits, prices and limits
  included: Save applies all of it and Discard drops all of it, and its note goes when another
  endpoint is selected. The Scripting page's endpoint manager has the same picker
  (`usePresetPicker`), and writes onto the profile at once, as all its fields do. The tab keeps
  three things apart that usually get confused: the saved model configuration, the provider connection (base URL + credential, shareable between configurations)
  and the shared quota group. Named credentials can be used by several endpoints; in the demo the
  key itself stays in the in-memory keyring and never reaches an export. With a server, the key is
  the server's: the field saves it there at once, shows "Key saved on the server" afterwards (it
  cannot show the key, which never comes back), and Test asks the server to send one small request
  with the saved settings — see [the providers](backend.md#the-providers-and-where-a-key-lives). Edits are staged and applied
  deliberately: changing base URL, model or credential while jobs are unfinished asks first and says
  that queued jobs keep the connection they were created with. The connection test states its scope
  and cost before you press it, and both that estimate and the figure the test reports afterwards go
  through the shared pricing engine at the rates in force now — so a probe inside an off-peak window
  or under a promotion is quoted at the price it will actually be charged, in both places.
- **Voices** (TTS only) — the endpoint’s voice catalogue, discovery and manual voice controls. In
  the demo discovery is simulated. With a server, **Fetch** asks the server for the voices the
  saved key can see — a Fish Audio library, OpenAI's documented voices, or an OpenAI-compatible
  server's `/audio/voices` — and adds the ones not already listed. A Fish endpoint also gets
  **Public voices**: search Fish's public catalogue by title (or paste an id), filter by language,
  page through, and add one with a click; ▶ on a result plays Fish's own recording of that voice,
  a file on Fish's CDN that costs nothing (a voice with none is rendered like a listed one). A Fish
  voice is a `reference_id`, public or your own.
  On an endpoint whose provider clones — Fish Audio, ElevenLabs, BreezeBlue, Cartesia, MiniMax, or
  Qwen on `qwen3-tts-vc-2026-01-22` — with a server, **Clone a voice** makes a voice from samples of
  one person: audio you recorded or downloaded. It takes a name, the samples the provider takes (the
  picker offers only its formats; Fish takes up to 20, the others one, and a pick past that keeps
  the first and says so; a file too large, or named as a format the provider does not take, blocks
  the button by name), the provider's own advice and what it charges, and a box saying the voice is
  yours or its owner agreed, without which nothing is sent. The provider makes the voice once, and
  it is spoken by its id from then on. It is sent once and not retried, so a failure never leaves a
  second copy on the account. The provider keeps it as a private voice on the account and it is
  added to the list; a provider that asks for the voice to be verified first says so in the toast.
  A Qwen endpoint on another model names the model to switch to instead. See
  [the providers](backend.md#the-providers-and-where-a-key-lives), and a clone's fee lands in the
  Activity list. The server keeps the
  samples beside the voice, with the sentence that was agreed to and when, so the voice can go
  with a book's script ([script export](script-transfer.md#slice-2-cloning-keeps-its-samples)); a
  voice's row then says **N samples kept**, and **Forget** drops them and keeps the voice, with
  Undo. A voice cloned before samples were kept offers **Keep its samples…**: the same picker,
  limits and consent box, and nothing is sent to the provider. Removing a voice or its endpoint keeps the
  samples for a day, so the removal's Undo — or a settings import that brings the voice back —
  finds them where they were; the first save after that removes them, as it does a forget's.
  With a server, a voice's ▶ has the saved endpoint say a sentence in it — a real request, billed
  and listed under Activity, heard once and replayed from then on; see
  [voice samples](backend.md#the-providers-and-where-a-key-lives). In the demo it is the browser's own voice.
- **Audio** (on the Requests tab, TTS only) — the format every new line is asked for and kept in,
  the bitrate where the format has one, and the sample rate, each narrowed to what this endpoint's
  API can be asked for (`speechFormats` in `lib/endpointShapes.ts`). Fish Audio offers WAV
  (16–44.1 kHz), MP3 (32 or 44.1 kHz; 64, 128 or 192 kbps) and Opus (48 kHz); an OpenAI-shaped
  endpoint offers the same three with no rate or bitrate. Fish Opus offers only an automatic
  bitrate: asking it for 24 or 32 kbps came back at about 272 kbps. A change that leaves a rate or
  bitrate the new format does not have resets it and says what it reset; a base URL saved onto
  another API does the same. MP3 and Opus are about a tenth of WAV's size, building from them
  needs `EXPORT_ENCODER=ffmpeg`, and clips already rendered keep the format they were made in.
- **Expressions** (TTS only) — explicitly configured model support and tag syntax; see [model-specific expressions](audio.md#model-specific-expressions).
- **Requests** — concurrency as an exact number with a slider whose range grows to fit what you
  type (2,500 is as easy to set as 4), and three separate readouts: configured, in flight now, and
  the effective limit actually in force (zero while paused, cooling down or missing a key).
  Timeouts, retry limit and rate-limit cooldown; maximum characters, cut boundary and the scripting
  output-token ceiling. A simulated speech endpoint also has **Simulated answers**: how long each
  answer takes, in milliseconds, and the share that fail, in percent (stored as `latency` and
  `failRate`, 0–1), so a run on it moves and fails like one on a real provider. A simulated
  scripting profile has neither: it takes a tenth of its **Seconds per chunk** estimate to answer each chunk, the pace the demo scripts at, and never fails. The split preview runs the real splitter and asserts the pieces rejoin the
  source character for character. A footer says which settings apply immediately and which apply to
  the next job.
- **Pricing & budgets** — scripting keeps separate input/output prices per million tokens, with
  cached-input and cache-write rates; speech picks a **billing model**, because providers meter
  genuinely different things (per 1M characters, per 1M UTF-8 bytes, per 1M input text tokens,
  input text tokens **plus** output audio tokens at separate rates, per audio minute, per request).
  Only the fields that model uses are shown, each with its unit spelled out, and a worked example
  under them prices one line at the rates in force right now so you can see how the rates produce a
  total. Changing model never reinterprets a rate: $15 per million characters is not $15 per million
  audio tokens, so the old rates are **parked** rather than carried over, and switching back
  restores them. Both kinds then share a peak/off-peak schedule and temporary promotions, behind disclosures that
  stay shut on an endpoint that has neither. A blank rate means **unknown**, never $0: those requests are counted, never priced,
  and every total that excludes them says so. Estimated, reserved and recorded cost are defined side
  by side. The endpoint's daily limit (one endpoint, all books) sits beside book budgets (one book,
  all endpoints) with the scopes spelled out, and a paragraph says what happens when the remaining
  budget can't cover another request. See [pricing, usage and budgets](pricing.md).
- **Activity** — filterable request history by status, book and free text, with book/chapter links,
  attempts, queue time, response time, usage and cost. Rows expand to a sanitised error body and
  copyable diagnostics (anything key-shaped is replaced with `[redacted]` before it is displayed or
  copied). Waiting requests say why in words: paused, concurrency full, rate-limit cooldown, no
  credential, budget exhausted, or waiting its turn behind an earlier chapter.

**Pause is not Cancel.** Pausing stops new dispatches and holds the queue: requests already in
flight land and are recorded, queued ones wait, and the run resumes where it left off. Cancel stops
the jobs, and says first how many it will hit, that in-flight work is kept with its recorded cost,
and that nothing already scripted or rendered is deleted. Removing an endpoint explains the same
ground. Tab selection, activity filters and unsaved connection edits survive leaving the page.

An unused endpoint is never called "Healthy": it reads **Not tested** until something answers and
**No recent activity** once it falls quiet. Rate-limit cooldown is a live setting — the simulated
transport uses the number on the Requests tab.

### What is real and what is not

Live activity comes from the job simulator already in the store, and everything this session has
settled comes from the usage ledger. The backstory — the invented week behind the charts, the totals
and the older request rows, and the connection test — comes through `EndpointService`
([src/services/endpoints.ts](../src/services/endpoints.ts)), whose only implementation here is `FixtureEndpointService`: a seeded
generator that invents a plausible week of traffic per endpoint. Every row it produces is marked
`simulated`, the page labels sample history against work this session produced, and no provider is
called, nothing is billed and nothing persists. Swapping in an HTTP implementation is the last line
of that file.

That invented week is generated **once** and then kept until an explicit reset. It is priced from
the rate cards the seeded world holds, so a demo reset or a scenario that changes a card drops it
and the next look regenerates it — but nothing else does, because regenerating it on a timer meant
revisiting the page after editing a rate quietly rewrote the previous week's receipts at the new
price, which is the one thing a receipt exists to prevent.

The route is lazy (`() => import("@/views/EndpointsView.vue")`): the charting library is only used
here, and keeping it out of the entry chunk leaves the main bundle smaller than it was before this
page existed.
