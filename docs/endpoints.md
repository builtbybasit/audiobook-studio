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
- **Connection** — keeps three things apart that usually get confused: the saved model
  configuration, the provider connection (base URL + credential, shareable between configurations)
  and the shared quota group. Named credentials can be used by several endpoints; the key itself
  stays in the in-memory keyring and never reaches an export. Edits are staged and applied
  deliberately: changing base URL, model or credential while jobs are unfinished asks first and says
  that queued jobs keep the connection they were created with. The connection test states its scope
  and cost before you press it, and both that estimate and the figure the test reports afterwards go
  through the shared pricing engine at the rates in force now — so a probe inside an off-peak window
  or under a promotion is quoted at the price it will actually be charged, in both places.
- **Voices** (TTS only) — the endpoint’s voice catalogue, discovery and manual voice controls. Voice discovery is simulated.
- **Expressions** (TTS only) — explicitly configured model support and tag syntax; see [model-specific expressions](audio.md#model-specific-expressions).
- **Requests** — concurrency as an exact number with a slider whose range grows to fit what you
  type (2,500 is as easy to set as 4), and three separate readouts: configured, in flight now, and
  the effective limit actually in force (zero while paused, cooling down or missing a key).
  Timeouts, retry limit and rate-limit cooldown; maximum characters, cut boundary and the scripting
  output-token ceiling. The split preview runs the real splitter and asserts the pieces rejoin the
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
