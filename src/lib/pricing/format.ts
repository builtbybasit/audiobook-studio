// How a price is written: money, what each component and billing model is called, a receipt as
// lines a table can render, and the one-liners a card leads with.
//
// Nothing here works out a figure. Every function takes one that `rates.ts`, `receipt.ts` or
// `estimate.ts` already worked out, so the words and the arithmetic can change apart.
import { whenPhrase } from "@/lib/wallClock";
import type {
  ChargeLine,
  CostBasis,
  CostLine,
  PricedRequest,
  PricingSnapshot,
  PromotionScope,
  RateComponent,
  SpeechCharge,
  SpeechChargeLine,
  TtsBillingUnit,
} from "@/types";
import { billsAudioTokens, speechComponents } from "./units";

// ---------- money ----------

/** Money to a sensible number of places: cents for real sums, more for fractions of a cent. */
export function money(n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : 2;
  return (
    "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })
  );
}

/** An unknown cost is never $0. */
export const maybeMoney = (n: number | null | undefined): string =>
  n == null ? "unknown" : money(n);

// ---------- what is charged for ----------

export const COMPONENT_LABEL: Record<RateComponent, string> = {
  input: "Input",
  cachedInput: "Cached input",
  cacheWrite: "Cache write",
  output: "Output",
  speech: "Speech",
  textTokens: "Input text tokens",
  audioTokens: "Output audio tokens",
};

export const COMPONENT_HINT: Record<RateComponent, string> = {
  input: "The chapter text, the prompt and any context carried forward.",
  cachedInput: "Input the provider served from its cache instead of reading again.",
  cacheWrite: "Input the provider wrote into its cache for later requests.",
  output: "The script that comes back — lines, speaker labels and directions.",
  speech: "What this endpoint bills for rendering a line — see the unit beside the rate.",
  textTokens:
    "The line as submitted — after pronunciation replacements and expression tags — plus any voice instructions sent with it.",
  audioTokens:
    "The audio that comes back, metered in tokens. Not a conversion of the text: it follows the length of the recording.",
};

export const SCOPE_LABEL: Record<PromotionScope, string> = {
  model: "Whole model",
  input: "Input only",
  cachedInput: "Cached input only",
  cacheWrite: "Cache writes only",
  output: "Output only",
  speech: "Speech rates",
  textTokens: "Input text tokens only",
  audioTokens: "Output audio tokens only",
};

// ---------- speech billing units ----------

export const BILLING_UNITS: {
  value: TtsBillingUnit;
  label: string;
  group: string;
  hint: string;
}[] = [
  {
    value: "chars",
    label: "per 1M characters",
    group: "What was sent",
    hint: "billable characters — Unicode code points, not UTF-16 length",
  },
  {
    value: "bytes",
    label: "per 1M UTF-8 bytes",
    group: "What was sent",
    hint: "what Fish Audio meters, even where its price list says “characters”",
  },
  {
    value: "tokens",
    label: "per 1M input text tokens",
    group: "What was sent",
    hint: "the text tokenised, with no separate charge for the audio",
  },
  {
    value: "audio-tokens",
    label: "input text + output audio tokens",
    group: "Tokens both ways",
    hint: "two rates, priced separately — Gemini-style TTS",
  },
  {
    value: "minute",
    label: "per audio minute",
    group: "What came back",
    hint: "billed on the length of the recording",
  },
  {
    value: "request",
    label: "per request",
    group: "Flat fee",
    hint: "a fee per call, regardless of length",
  },
];

export const billingUnitLabel = (unit: TtsBillingUnit): string =>
  BILLING_UNITS.find((b) => b.value === unit)?.label ?? unit;

/** The short suffix a rate field wears, e.g. `$12.00 / 1M chars`. */
const BILLING_SUFFIX: Record<TtsBillingUnit, string> = {
  chars: "/ 1M chars",
  bytes: "/ 1M UTF-8 bytes",
  tokens: "/ 1M text tokens",
  "audio-tokens": "/ 1M text tokens",
  minute: "/ audio min",
  request: "/ request",
};

/**
 * What the single-rate `speech` component is *called* under each model.
 *
 * "Speech" is the component's name, not a description of what was charged, and a receipt that says
 * "Speech · 59 UTF-8 bytes" when the whole question is which quantity was billed is one word short
 * of answering it. The two token components name themselves already.
 */
const BILLING_NOUN: Record<TtsBillingUnit, string> = {
  chars: "Characters",
  bytes: "UTF-8 bytes",
  tokens: "Input text tokens",
  "audio-tokens": "Input text tokens",
  minute: "Audio minutes",
  request: "Requests",
};

/** The same, lower-case and in a sentence: "so only the UTF-8 bytes are charged". */
const BILLING_PHRASE: Record<TtsBillingUnit, string> = {
  chars: "only the characters are charged",
  bytes: "only the UTF-8 bytes are charged — not the characters, and not the tokens",
  tokens: "only the input text tokens are charged",
  "audio-tokens":
    "the input text tokens and the output audio tokens are charged separately, and nothing else is charged at all",
  minute: "only the audio that came back is charged",
  request: "the call is charged as a flat fee, whatever it carried",
};

/** How one charged line is labelled: the component's name, or what this model bills on. */
export const chargeLabel = (c: RateComponent, unit: TtsBillingUnit): string =>
  c === "speech" ? BILLING_NOUN[unit] : COMPONENT_LABEL[c];

/** What each component of a speech card is measured in, spelled out for a quantity column. */
const COMPONENT_UNIT: Partial<Record<RateComponent, string>> = {
  textTokens: "/ 1M text tokens",
  audioTokens: "/ 1M audio tokens",
};

/**
 * How one component's rate is written.
 *
 * Token components on a scripting card are always per 1M tokens. On a speech card the two token
 * components say **which** tokens, because "$20.00 / 1M" on a Gemini-style endpoint is the answer
 * to a question nobody asked. The single-rate `speech` component is written in whatever unit its
 * endpoint bills in, which is why that unit has to be passed in.
 */
export const rateSuffix = (c: RateComponent, unit?: TtsBillingUnit): string =>
  c === "speech" ? BILLING_SUFFIX[unit ?? "chars"] : (COMPONENT_UNIT[c] ?? "/ 1M tokens");

/** A rate with its unit: `$12.00 / 1M chars`. */
export const rateWithUnit = (n: number | null, c: RateComponent, unit?: TtsBillingUnit): string =>
  n == null ? "unknown" : `${money(n)} ${rateSuffix(c, unit)}`;

// ---------- how sure a figure is ----------

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  calculated: "calculated here",
  "provider-reported": "reported by the provider",
  estimated: "estimated",
  unknown: "unknown",
};

export const COST_BASIS_DETAIL: Record<CostBasis, string> = {
  calculated:
    "worked out here from the reported usage and the rates in force when the request completed",
  "provider-reported": "the charge the provider itself reported for this request",
  estimated:
    "worked out from the rates, but part of the usage was missing or inconsistent — treat it as an upper bound",
  unknown: "no rate is set for this endpoint, so nothing can be worked out",
};

// ---------- one display shape for both kinds ----------

const count = (n: number, unit: string): string =>
  `${Math.round(n).toLocaleString()} ${unit}${Math.round(n) === 1 ? "" : "s"}`;

/** What a token line charged for, in the unit that line is measured in. */
const tokenQuantity = (l: CostLine): string => count(l.tokens, "token");

/** What one speech line was charged on, in that component's own unit. */
function speechQuantity(charge: SpeechCharge, line: SpeechChargeLine): string {
  if (line.component === "textTokens") return count(line.quantity, "text token");
  if (line.component === "audioTokens") return count(line.quantity, "audio token");
  switch (charge.unit) {
    case "chars":
      return count(line.quantity, "character");
    case "bytes":
      return `${Math.round(line.quantity).toLocaleString()} UTF-8 bytes`;
    case "minute":
      return `${line.quantity.toFixed(2)} audio minutes`;
    case "request":
      return count(line.quantity, "request");
    default:
      return count(line.quantity, "unit");
  }
}

/** A priced LLM request as lines a table can render. */
export const tokenChargeLines = (priced: PricedRequest): ChargeLine[] =>
  priced.lines
    .filter((l) => l.tokens > 0 || l.component === "input" || l.component === "output")
    .map((l) => ({
      label: COMPONENT_LABEL[l.component],
      quantity: tokenQuantity(l),
      rate: rateWithUnit(l.rate, l.component),
      amount: l.amount,
      why: priced.rates[l.component]?.why ?? [],
      ...(l.note ? { note: l.note } : {}),
    }));

/** A charged clip as the same lines — one for a per-character endpoint, two for a token-billed one. */
export const speechChargeLines = (charge: SpeechCharge): ChargeLine[] =>
  charge.lines.map((l) => ({
    label: chargeLabel(l.component, charge.unit),
    quantity: speechQuantity(charge, l),
    rate: rateWithUnit(l.rate, l.component, charge.unit),
    amount: l.amount,
    why: l.why,
    ...(l.note ||
    (charge.units.requests > 1 && charge.unit !== "request" && l.component !== "audioTokens")
      ? {
          note: [
            l.note,
            charge.units.requests > 1 && charge.unit !== "request" && l.component !== "audioTokens"
              ? `sent as ${charge.units.requests} requests — the line was over this endpoint's limit`
              : "",
          ]
            .filter(Boolean)
            .join("; "),
        }
      : {}),
  }));

/**
 * How the measured quantities divide, as a sentence that cannot be read as double counting.
 *
 * Every quantity is named, including the ones this endpoint does not bill on, and the last clause
 * says which single one was charged — so a reader can see that 1,240 characters and 1,860 bytes are
 * two readings of the same text rather than two things being paid for.
 */
export function speechSentence(charge: SpeechCharge): string {
  const u = charge.units;
  const parts = [
    `${u.chars.toLocaleString()} characters (${u.bytes.toLocaleString()} UTF-8 bytes` +
      `${u.textTokens != null ? `, ~${u.textTokens.toLocaleString()} text tokens` : ""}) submitted`,
  ];
  if (u.instructionChars)
    parts.push(`${u.instructionChars.toLocaleString()} of them voice instructions`);
  if (u.audioSeconds > 0)
    parts.push(
      `${(u.audioSeconds / 60).toFixed(2)} audio minutes returned` +
        (u.audioTokens != null ? ` (~${u.audioTokens.toLocaleString()} audio tokens)` : ""),
    );
  else parts.push("nothing came back, so no audio was produced");
  if (u.requests > 1) parts.push(`across ${u.requests} requests`);
  return `${parts.join(", ")}. This endpoint bills ${billingUnitLabel(charge.unit)}, so ${BILLING_PHRASE[charge.unit]}.`;
}

// ---------- saying it in one line ----------

/**
 * The compact line the Pricing tab leads with, per component:
 * "Input: $0.50 / 1M tokens · 50% promotion applied · ends tomorrow".
 */
export function componentLine(
  snapshot: PricingSnapshot,
  c: RateComponent,
  now: number,
  unit?: TtsBillingUnit,
): string {
  const e = snapshot.components[c];
  if (e.rate == null)
    return `${COMPONENT_LABEL[c]}: ${
      c === "speech" || c === "textTokens" || c === "audioTokens"
        ? "rate not known"
        : "charged as ordinary input"
    }`;
  const parts = [`${COMPONENT_LABEL[c]}: ${rateWithUnit(e.rate, c, unit)}`];
  for (const why of e.why) parts.push(why);
  if (e.promotion) {
    const p = snapshot.applied.find((x) => x.label === e.promotion);
    if (p?.until != null) parts.push(`ends ${whenPhrase(p.until, now, snapshot.timezone)}`);
  } else if (snapshot.next && e.why.length) {
    parts.push(
      `${snapshot.next.label.toLowerCase()} ${whenPhrase(snapshot.next.at, now, snapshot.timezone)}`,
    );
  }
  return parts.join(" · ");
}

/** The one-line pricing a card shows, with whatever is moving it right now. */
export function pricingOneLiner(snapshot: PricingSnapshot, unit?: TtsBillingUnit): string {
  const i = snapshot.components.input;
  const o = snapshot.components.output;
  const head =
    unit !== undefined
      ? speechOneLiner(snapshot, unit)
      : !i.rate && !o.rate
        ? "no charge"
        : `${money(i.rate ?? 0)} in / ${money(o.rate ?? 0)} out · 1M tokens`;
  const notes: string[] = [];
  if (snapshot.window) notes.push(snapshot.window.label);
  for (const p of snapshot.applied) notes.push(p.label);
  return notes.length ? `${head} · ${notes.join(", ")}` : head;
}

/**
 * The rate half of a speech endpoint's one-liner, in whichever model it bills under.
 *
 * A two-rate endpoint says both, because quoting only one of them is how "$1 per 1M" ends up on a
 * card whose bill is dominated by the audio side. Zero is "no charge"; not-known says so.
 */
function speechOneLiner(snapshot: PricingSnapshot, unit: TtsBillingUnit): string {
  const components = speechComponents(unit);
  if (components.every((c) => snapshot.components[c].rate === 0)) return "no charge";
  if (components.some((c) => snapshot.components[c].rate == null))
    // one half of a two-rate card is not half an answer: the endpoint cannot be priced at all
    return components.length > 1 && components.some((c) => snapshot.components[c].rate != null)
      ? `${COMPONENT_LABEL[components.find((c) => snapshot.components[c].rate == null)!].toLowerCase()} rate not known`
      : "rate not known";
  const parts = components.map((c) => {
    const rate = snapshot.components[c].rate!;
    return c === "speech"
      ? `${money(rate)} ${billingUnitLabel(unit)}`
      : `${money(rate)} ${c === "textTokens" ? "text" : "audio"}`;
  });
  return billsAudioTokens(unit) ? `${parts.join(" + ")} · 1M tokens` : parts.join(" · ");
}
