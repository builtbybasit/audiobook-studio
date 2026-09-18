# Pricing, usage and budgets

[Back to README](../README.md) · [Endpoint UI](endpoints.md) · [Ownership and invariants](../src/stores/README.md#pricing-and-usage-invariants)

This guide describes the prototype’s implemented pricing rules. Provider names, rates, billing units and usage payloads are editable demo examples, not verified current billing contracts. Actual integrations will need to validate each provider’s rules.

## Rates, schedules and promotions

Pricing is no longer a flat rate. An endpoint's **Pricing & budgets** tab still opens on the rates
that endpoint needs — input and output per million tokens for a chat model, and the selected billing model’s rate or
separate input/audio rates for a speech model — and everything below is a disclosure that stays shut unless that endpoint uses
it. **Both kinds go through the same schedule and the same promotions**; what differs is which rates
they have and what unit those rates are written in.

**Cached input** (implemented for chat endpoints only; this prototype does not offer cache pricing
for speech endpoints). A switch adds a separate cached-input rate, and a second one adds a cache-write
rate where the provider bills for that too. Off is not zero: it means "no separate line", and those
tokens are charged at the ordinary input rate. The distinction matters — some providers write the
cache for free, others charge more for it than for ordinary input.

**Peak / off-peak.** A schedule is an explicit IANA timezone (shown with its current local clock, so
you can see the window you are in) and a list of recurring windows. A window whose end is at or
before its start runs **past midnight**, says so, and its day buttons then name the day it _starts_
on — Fri 22:00–02:00 is Friday night and the first two hours of Saturday. A window with no days set
is "every day" and shows all seven buttons pressed, so clicking one of them **deselects** that day
and leaves the other six, rather than collapsing the window onto the day that was clicked. Windows never stack: the
first one in the list that covers the moment wins, the list is reorderable, and one that covers but
is outranked is labelled rather than hidden. Every rate a window or promotion names is quoted in the
unit that component is billed in — `/ 1M tokens` on a chat model, `/ audio min` or `/ request` on a
speech endpoint that bills that way.

**Promotions.** A start date, an end date, a scope (whole model, or input / cached input / cache
writes / output individually) and either a percentage or explicit replacement rates. The dates are
calendar days **in the endpoint's own timezone**, the one the schedule is read in and the one every
other date on the page is displayed in — editing a New York promotion from Karachi does not move its
start or end onto another day — and the field says which zone it is naming. They are
grouped **running now**, **scheduled** and **ended — kept as history**: an expired promotion stops
applying on its own date, is never deleted for you, and never re-prices a request it already priced.

**Precedence, in one sentence each:** base rates are what the endpoint charges; the schedule may
replace them, one window at most; a promotion may replace what the schedule left, one promotion at
most _per component_ — the one that makes that component cheapest, ties going to the one ending
soonest. Nothing compounds. **Effective price now** shows all three steps per component with the
base struck through, a chip per reason, the shadowed promotions named, and one line saying what
changes next and when, in the endpoint's own timezone.

**A rate nobody knows stays unknown through every discount.** The seeded Azure proxy bills per
audio minute at a rate that was never written down and has a nightly 30% window over it: the window
is in force, the effective price is still _unknown_, and the page says so instead of producing a
confident number. Requests through it are counted, never priced, and every total that leaves them
out calls itself a floor. A two-rate endpoint with only one of its rates filled in is the same case
rather than half of one: knowing what the text costs and not what the audio costs is no answer, so
nothing is priced until both are set.

### Billing models and their distinct units

A speech provider meters one of several quantities and they are **not** scalings of one another. A
line of Mandarin is 12 characters, 36 UTF-8 bytes and some number of text tokens that neither figure
predicts. So every request records all of them and only the one its endpoint bills on is charged:

| Model                                | Charged on                                | Seeded as                      |
| ------------------------------------ | ----------------------------------------- | ------------------------------ |
| per 1M characters                    | billable characters — Unicode code points | OpenAI (main), $12             |
| per 1M UTF-8 bytes                   | `TextEncoder` bytes of the same content   | Fish Audio, $15                |
| per 1M input text tokens             | the submitted text, tokenised             | —                              |
| input text **+** output audio tokens | two rates, priced separately and added    | Gemini 3.1 Flash TTS, $1 + $20 |
| per audio minute                     | the recording that came back              | Azure proxy, rate unknown      |
| per request                          | a flat fee per call                       | —                              |

**Characters are not `String.length`.** That counts UTF-16 code units — an emoji as two, a Han
character as one — and is neither what a provider billing "characters" means nor what one billing
bytes meters. `billableChars` counts code points and `utf8Bytes` counts bytes, and the Fish Audio
demo preset uses **UTF-8 bytes** to exercise a different billing unit. This is a fixture choice,
not a verified claim about Fish Audio’s current pricing. Under that configuration, three-byte Han characters cost
three times their code-point count; verify the provider contract before using the preset for real billing.

**What is counted is what was submitted**, not what the book says: the line after the pronunciation
dictionary has rewritten it, with the expression tags inserted and the voice instructions that
travel beside it (a switch on the tab, since a few providers ignore that field). It is a separate
question from how long the chapter **is** — which is what the reading-time estimate uses — and from
the endpoint's per-request character limit, which is about payload size and lives in [lib/split.ts](../src/lib/split.ts).
The seeded dictionary rewrites "outer sect" into `外门`, so the byte-billed speaker's requests are
measurably more bytes than characters and the difference is visible in the estimate and on the
receipt.

**Audio tokens do not follow from the text.** They follow the length of the recording, so an
estimate goes through the audio's expected duration and a tokens-per-second conversion — an
assumption about the provider's tokeniser rather than anything this app can measure. It is editable
per endpoint (`audioTokensPerSecond`, seeded at 25), recorded on every receipt priced under it, and
any estimate that leans on it says so. A text-token approximation is never used for the audio side:
that is a different quantity, not a cheaper way of getting the same one.

**Estimates split input from audio.** `inputCost + audioCost = cost`, on the Pricing tab's worked
example, in the run panel and in the queue's run details — because on a token-billed endpoint the
audio half usually dominates, and a single total hides which one is large. The reconciliation after
a run reports the two halves separately for the same reason: an input side that lands on the nose
and an audio side 19% out is a different story from both being 10% out, and only one of them is
fixed by changing a number on the Pricing tab.

### Cache usage comes from the API, not from an assumption

`TokenUsage.inputTokens` is the **total** input; `cachedInput` and `cacheWrite` are slices of it,
never additions. A response reporting 10,000 input tokens of which 8,000 were cached is charged
8,000 at the cached rate and 2,000 at the ordinary one, with output charged separately — and the
charge lines always add back up to what the provider reported.

Providers disagree about this, so nothing reads a payload directly. `normalizeUsage` in
[src/lib/pricing.ts](../src/lib/pricing.ts) is the one way in and knows three shapes: OpenAI's `prompt_tokens` **includes**
`prompt_tokens_details.cached_tokens`, Anthropic's `input_tokens` **excludes**
`cache_read_input_tokens` and `cache_creation_input_tokens`, and a plain provider reports totals and
nothing else. [src/mock/simulators/usage.ts](../src/mock/simulators/usage.ts) builds payloads in those shapes and reads them back
through the same normalizer, so both the live simulator and the seeded week of history exercise the
rule rather than assert it.

- **Zero cached tokens and no cache report are different facts.** `cachedInput: 0` is a reported
  zero. `null` means the provider said nothing: the request is then charged with the whole input at
  the ordinary rate — the conservative reading — its cost is labelled **estimated** rather than
  calculated, and the row says _"How much of the input was cached was not reported. The whole input
  is charged at the ordinary rate, so the real cost is this figure or less."_ An assumed cache miss
  is never presented as a reported one.
- **Contradictory counts are caught before the arithmetic.** Cached plus cache-write tokens adding up
  to more than the total input, a negative count, a missing one — each is repaired so no line can go
  negative, flagged on the receipt, and drops the cost to an estimate.
- **A charge the provider reported is kept apart from one we worked out.** `CostBasis` is
  `calculated`, `provider-reported`, `estimated` or `unknown`, and where a provider reports its own
  figure the receipt shows both with a note that a provider's tokeniser and rounding are not ours.

### Estimates, and what they are allowed to assume

Before a run, cache use is unknowable, so the headline estimate assumes **none**: every input token
at the ordinary rate. Beside it, and only beside it, sit two labelled alternatives — the same work at
a recently _observed_ cache rate (drawn only from requests that actually reported cache detail, so a
silent provider produces no figure at all) and the same work **without today's discounts**.

Budget checks use that last one. A promotion can expire and an off-peak window can close while a run
is still going, so a cap that only holds while a discount lasts is not a cap: reservations are taken
at undiscounted rates with the full output ceiling, and a run blocked by that says so in those words.
"Why this is an estimate and not a price" lists what could move the figure — a boundary the batch may
cross, a promotion that may expire — and finishes by saying that each request is priced when it comes
back, not when the run starts.

**"No cache savings" is not automatically a ceiling.** Cached and cache-write tokens are slices of
the input, and neither is guaranteed to be cheaper than it — a cache write commonly costs _more_,
and the switch that adds one defaults it to 125% of the input rate. So the input side of a
reservation is taken at the **dearest** rate any input token could be charged at on that card, not
at the ordinary input rate, and the run estimate only claims "the real cost is this or less" on a
card where ordinary input really is the dearest. Where it is not, the caution names the ceiling
instead and says that is what the budget is checked against.

**Narration enforces its cap in the store, at every entry point.** A bulk run, "re-narrate stale", a
retry, a retake and "retake everything flagged" all check the undiscounted price against what has
been spent _and_ what unfinished work has already reserved, and each narration job holds its
chapter's price against the cap until it lands. A check that lives only in the run panel is a
warning on one screen; two runs that each fit on their own could otherwise start together and land
past the cap between them.

### Every request keeps its own receipt

A completed scripting request stores a `PricedRequest`: the normalized usage, the rates in force,
the reasoning behind each one, the instant they were read at and the rule that chose that instant
(`PRICING_RULE` — "priced at the rates in force when the request completed"). A rendered clip stores
the speech equivalent, a `SpeechCharge`: the billing model in force, one charged line per component
with its rate and what moved that rate off the card, everything that was measured — characters,
UTF-8 bytes, text tokens, audio seconds, audio tokens and how many requests a split line became —
and whatever the provider itself reported. Where the provider reports the quantity being billed, the
receipt uses **its** number and says so; where it reports nothing, the count taken on the way out is
used and the figure is labelled an estimate rather than presented as a reconciliation. A charge the
provider reported itself stays distinct from one worked out here from reported usage, which in turn
stays distinct from one worked out from our own counts. A clip is priced when it **lands**, never when it is dispatched: a per-minute endpoint
has no audio to bill for until then, and a failed clip therefore costs a per-minute endpoint nothing
while a per-character or per-request one still charges for what it sent. The rule travels with
either receipt so a provider that bills at dispatch, or per batch, can adopt a different one without
rewriting history.

Pricing is therefore evaluated **per request**, not once per run: a batch that straddles an off-peak
boundary is charged at two different prices, and the activity log records the rates each request
used. When a run finishes it reconciles itself — estimated against charged, how much of the input
turned out to be cached, and how many requests reported no cache detail and so have an upper bound
rather than a figure. Each chapter of a bulk run is reconciled against **its own** chunks, not
against the run's total divided by the number of chapters, so a short chapter and a long one do not
report an artificial underspend and overrun against each other.

### The ledger: what was spent is what was requested

Every request that settles — a scripting chunk, a rendered clip, a retake, one that failed, one the
provider refused — is appended to [src/stores/usage.ts](../src/stores/usage.ts) with the receipt it was priced from, and
nothing afterwards moves it, re-prices it or takes it out. Spending is read from there.

That is a deliberate replacement for totalling the clip currently sitting on each line, which was
wrong in both directions at once: a paid request that failed was invisible, and accepting a retake
made the money already spent on the clip it displaced **disappear** — recorded spending went down
and the budget handed back capacity it had genuinely used. A take carries its `SpeechCharge` into
the take list with it, so a superseded recording still says what it cost, at what rate, and why.

The same ledger is what the Endpoints **Activity** list reads for this session's own work. Reading
it out of the running job simulator meant a request vanished from the page the moment it finished —
the one moment its receipt is worth opening — and the page fell back to unrelated sample history.
The list now shows in-flight requests, then this session's settled ones with their receipts, then
the fixture service's invented week, with a violet dot marking everything this session produced.

The seeded world's own narration predates the ledger, so it is an opening balance: totalled once
from the **pristine** world rather than from the clips a session can move, and recomputed only when
a reset restores that world. Every clip rendered here has a row of its own instead, so the two
halves cannot overlap and neither can be un-counted by a clip being retried, replaced or displaced.

The reported cache percentage divides like by like: cached tokens over the input of the requests
that **reported** a cache figure, with the traffic that said nothing left out of both halves and
counted separately. Dividing by every request's input silently read a silent provider as a run of
misses.

The **Activity** list stays a list: a row shows `1.6k in (1.3k cached) / 796 out`, which cannot be
misread as 2.9k tokens, and a request whose provider said nothing wears a small `cache ?` mark.
Opening the row gives the receipt — a sentence spelling out how the tokens divide, then a line per
component with tokens, rate, amount and _why that rate_, the total with its basis and pricing
instant, the provider's own figure where there is one, and anything unknown in amber.

### Trying it

Demo tools has a **Rates, cache and promotions** group: cache reported / partly reported / not
reported / contradictory side by side, off-peak rates in force, a promotion running with one
scheduled and one ended, every promotion expired, a four-chapter run crossing a pricing boundary,
speech rates on discount, and **every billing model in one chapter** — five speakers routed at five
models at once, so a single run produces character-billed, byte-billed, token-billed, free and
unpriced requests and the estimate has to add all of them into one figure. The seeded endpoints cover the configuration cases between them —
OpenAI with cached input, a midnight-crossing off-peak window, a peak surcharge and three
promotions; Anthropic with cache-write pricing and the payload shape that excludes cache tokens
from the input; DeepSeek reporting its own charge; a local chat model with no advanced pricing at
all; the OpenAI speech endpoint with a nightly off-peak window and a promotion on top; a free local
Kokoro with nothing scheduled at **zero**, which is "free" and not "unknown"; Fish Audio billing
UTF-8 bytes with a promotion scoped to the speech rate; Gemini billing input text and output audio
tokens with a promotion on the **audio half only**; and the Azure proxy with a window over a rate
nobody knows.

### Limitations

Cached-input and cache-write pricing are implemented for **chat endpoints only**. Speech cache
pricing is not modeled; this is a prototype limitation, not a claim about every TTS provider.
Schedules and promotions are shared.

A speech endpoint's `price` field survives as the per-1M-characters fallback for an endpoint that
carries no `billing` block; `billingOf` adapts that legacy field into a character rate. Modern
calculations use the billing model. The legacy field is kept in step only where a model
can honestly produce a per-character figure — a per-request fee has no character in it, and a byte
or audio-token rate over non-ASCII text is a different quantity rather than a different scale, so
`perMillionChars` returns `null` for those rather than quoting one as the other.

Input text tokens are estimated at four characters per token where the provider does not report a
count, which is a rule of thumb and not a tokeniser. The audio-token conversion is likewise a single
configurable number per endpoint rather than a model of how any particular provider tokenises audio;
both are labelled as estimates wherever they reach a figure. The expected **duration** an audio-side
estimate rests on is this app's own reading-speed model, so an endpoint billing on the audio carries
that uncertainty on top.

`nextChange` advances local minutes arithmetically from the instant it is given, which is exact
except across a daylight-saving transition — a boundary within a fortnight of a DST change can be
reported an hour out. Window edges are minute-granular. The timezone picker offers a short list of
common zones rather than the full IANA set; an unreadable zone falls back to UTC and says so rather
than pretending. A promotion with no end date never expires, which is a configuration choice the
panel names rather than prevents.
