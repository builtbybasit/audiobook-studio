// Endpoints, scripting profiles and their rate cards.
//
// The app talks to two kinds of OpenAI-compatible server — a chat model that turns prose into an
// attributed script, and a speech model that renders a line — and they are configured, paused, rate
// limited and billed the same way. They are two tables rather than one because their rate cards
// price different components and their operational settings differ in the middle, but everything
// that *is* shared (the ops columns, the schedule, the promotions) is shared by structure.
//
// **Rates live in columns and the schedule lives in rows.** A promotion has a start, an end and a
// scope; a window has days and minutes past midnight. Both are read against an instant on every
// single request — "what was the rate at 02:14 on Friday" — so they are queryable rows, not JSON.
// And an expired promotion is kept rather than deleted: it stops applying when its end date passes,
// and the requests it priced keep the rates they were priced at.
//
// **No secret is in here.** `credentials` is a registry of names — which account a key belongs to —
// and the key itself is not stored by this schema at all. Where secrets eventually live is a
// decision this slice does not make; see `docs/backend.md`.
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  EndpointKind,
  Gender,
  ParkedRates,
  PromotionScope,
  RateSet,
  SampleRate,
  SplitMode,
  TtsBillingUnit,
} from "@/types";

/** A named account several endpoints can point at, instead of each holding its own copy of a key. */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /** free-text reminder of which account this is — never the key itself */
  note: text("note").notNull().default(""),
});

/**
 * One configured endpoint, of either kind.
 *
 * `kind` decides which half of the rate columns means anything: a `scripting` row prices tokens
 * (`in_price`, `out_price`, `cached_input`, `cache_write`), a `tts` row prices speech in whatever
 * unit it bills in (`billing_unit`, `billing_rate`, `billing_audio_rate`). A rate is `null` when it
 * is **not known**, which is never the same as `0` — a local endpoint you host yourself is free; a
 * provider whose price list nobody has typed in yet cannot be priced at all.
 */
export const endpoints = sqliteTable(
  "endpoints",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<EndpointKind>().notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    concurrency: integer("concurrency").notNull().default(1),
    needsKey: integer("needs_key", { mode: "boolean" }).notNull().default(false),
    /** per-request character cap; 0 = no limit */
    maxChars: integer("max_chars").notNull().default(0),
    splitAt: text("split_at").$type<SplitMode>().notNull().default("sentence"),
    /** speech only: the rate every line is asked for, in Hz; null = the model's own */
    sampleRate: integer("sample_rate").$type<SampleRate>(),
    position: integer("position").notNull().default(0),

    // ---- scripting rates: USD per 1M tokens ----
    inPrice: real("in_price"),
    outPrice: real("out_price"),
    /** null = no separate rate, charged as ordinary input. Not zero, which would mean free. */
    cachedInput: real("cached_input"),
    cacheWrite: real("cache_write"),
    maxOutputTokens: integer("max_output_tokens"),
    secPerChunk: real("sec_per_chunk"),

    // ---- speech rates ----
    billingUnit: text("billing_unit").$type<TtsBillingUnit>(),
    /** per 1M chars / bytes / input text tokens, per audio minute, or per request */
    billingRate: real("billing_rate"),
    /** `audio-tokens` only: USD per 1M output audio tokens */
    billingAudioRate: real("billing_audio_rate"),
    /**
     * `audio-tokens` only: how many audio tokens one second of returned audio bills as. A
     * per-model assumption rather than something derivable from the text, so it is configured here
     * and every estimate that leans on it says so.
     */
    audioTokensPerSecond: real("audio_tokens_per_second"),
    /** whether voice instructions sent beside the line are billed as submitted content */
    billsInstructions: integer("bills_instructions", { mode: "boolean" }),
    /**
     * Rates entered under a **different** billing model, kept rather than discarded.
     *
     * Switching model clears the rate fields instead of reinterpreting a per-character rate as a
     * per-token one; parking them here means switching back restores what was configured rather
     * than making the operator type it again.
     */
    parkedRates: text("parked_rates", { mode: "json" }).$type<
      Partial<Record<TtsBillingUnit, ParkedRates>>
    >(),

    /** USD per 1M characters — the figure the run estimator has always used */
    price: real("price"),

    // ---- the schedule's timezone; the windows themselves are rows ----
    /**
     * IANA zone the rate windows are read in — a schedule without one is unreadable, which is what
     * makes this the field that says whether there is a rate card at all.
     *
     * Null means no advanced pricing has ever been configured on this endpoint, and it reads back
     * with no `pricing` rather than with an empty one. The difference matters: the app fills the
     * defaults in on first use, and an endpoint that already had an empty card would skip that.
     */
    timezone: text("timezone"),

    // ---- operational ----
    /** per-request wall clock, seconds */
    timeoutSec: integer("timeout_sec"),
    /** attempts *after* the first */
    maxRetries: integer("max_retries"),
    /** how long dispatch holds off after a 429 with no Retry-After, seconds */
    cooldownSec: integer("cooldown_sec"),
    /** USD/day across every book; null = no endpoint-level limit */
    spendLimit: real("spend_limit"),
    credentialId: text("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    /** endpoints that share one provider rate limit and spend pool */
    quotaGroup: text("quota_group"),

    // ---- simulated behaviour, kept so a demo endpoint round-trips ----
    latency: real("latency"),
    failRate: real("fail_rate"),

    /** what this model can do with expression tags, and for which exact model and base URL */
    expressionStatus: text("expression_status").$type<"unknown" | "unsupported" | "supported">(),
    expressionModel: text("expression_model"),
    expressionBaseUrl: text("expression_base_url"),
  },
  (t) => [index("endpoints_kind").on(t.kind, t.position)],
);

/** One voice an endpoint offers. A character stores `<endpointId>/<voiceId>` and nothing else. */
export const voices = sqliteTable(
  "voices",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: text("id").notNull(),
    label: text("label").notNull(),
    gender: text("gender").$type<Gender>().notNull().default("?"),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.id] })],
);

/** One expression tag this endpoint's model understands. `id` matches the same expression across models. */
export const expressionTags = sqliteTable(
  "expression_tags",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: text("id").notNull(),
    label: text("label").notNull(),
    token: text("token").notNull(),
    kind: text("kind").$type<"sound" | "delivery">().notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.id] })],
);

/**
 * A recurring time window with its own rates — an off-peak discount, a peak surcharge.
 *
 * `from` and `to` are minutes past local midnight in the endpoint's timezone. `to <= from` means
 * the window runs past midnight, and `days` then names the day it *starts* on, so a Friday
 * 22:00–02:00 window covers Friday night and the first two hours of Saturday.
 */
export const rateWindows = sqliteTable(
  "rate_windows",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: text("id").notNull(),
    label: text("label").notNull(),
    /** 0 = Sunday … 6 = Saturday; an empty array means every day */
    days: text("days", { mode: "json" }).$type<number[]>().notNull().default([]),
    fromMinute: integer("from_minute").notNull(),
    toMinute: integer("to_minute").notNull(),
    /** percentage off the base rates, 0–100 */
    percent: real("percent"),
    /** explicit replacement rates; wins over `percent` for the components it names */
    rates: text("rates", { mode: "json" }).$type<Partial<RateSet>>(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.id] })],
);

/**
 * A temporary price change with a start and an end — "50% off this model until Friday".
 *
 * Never deleted when it expires. It stops applying the moment its end date passes, and every
 * request it priced keeps the rates it was priced at, so the row has to stay for the receipt to
 * remain explicable.
 */
export const promotions = sqliteTable(
  "promotions",
  {
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: text("id").notNull(),
    label: text("label").notNull(),
    /** epoch ms; null = already running */
    fromAt: integer("from_at"),
    /** epoch ms; null = no end date */
    untilAt: integer("until_at"),
    /** which components this may touch; `model` means every component the endpoint prices */
    scope: text("scope", { mode: "json" }).$type<PromotionScope[]>().notNull(),
    /** percentage off whatever the schedule left, 0–100 */
    percent: real("percent"),
    /** explicit replacement rates — these ignore the schedule for the components they name */
    rates: text("rates", { mode: "json" }).$type<Partial<RateSet>>(),
    /** free text kept with the promotion so an expired one still explains itself */
    note: text("note"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.id] }),
    index("promotions_window").on(t.endpointId, t.fromAt, t.untilAt),
  ],
);
