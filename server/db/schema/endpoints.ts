// Endpoints (scripting, speech, transcription) and their rate cards. Rates are columns; windows and
// promotions are rows, since every request reads them against an instant.
// `endpoints.api_key` is the one secret: write-only over HTTP, read at request time, never copied
// onto a job.
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  AudioFormat,
  EndpointKind,
  Gender,
  ParkedRates,
  ProfilePrompt,
  PromotionScope,
  ReasoningEffort,
  RateSet,
  SampleRate,
  SpeechServer,
  SpeedRange,
  SplitMode,
  TagBracket,
  TtsBillingUnit,
} from "@/types";

/** A named account several endpoints can point at. */
export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /** free-text reminder of which account this is — never the key itself */
  note: text("note").notNull().default(""),
});

/**
 * One endpoint of any kind; `kind` decides which rate columns apply. A null rate is unknown, never
 * the same as 0 (free).
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
    /** never sent back over HTTP */
    apiKey: text("api_key"),
    /** per-request character cap; 0 = no limit */
    maxChars: integer("max_chars").notNull().default(0),
    splitAt: text("split_at").$type<SplitMode>().notNull().default("sentence"),
    /** speech only: Hz; null = the model's own */
    sampleRate: integer("sample_rate").$type<SampleRate>(),
    /** speech only: null = WAV */
    audioFormat: text("audio_format").$type<AudioFormat>(),
    /** speech only: MP3 kbps or Opus bps as the API spells it; null = the provider's default */
    audioBitrate: integer("audio_bitrate"),
    /** speech only: batch lines when the server takes them; false = one a request */
    batch: integer("batch", { mode: "boolean" }).notNull().default(true),
    /** speech only: a compatible server that makes voices at POST …/audio/voices */
    makesVoices: integer("makes_voices", { mode: "boolean" }).notNull().default(false),
    /** speech only: for a base URL that cannot say; null = the base URL decides */
    server: text("server").$type<SpeechServer>(),
    /** speech only: the range the server's capabilities declared when last read; never PUT */
    speedRange: text("speed_range", { mode: "json" }).$type<SpeedRange>(),
    position: integer("position").notNull().default(0),

    // ---- scripting rates: USD per 1M tokens ----
    inPrice: real("in_price"),
    outPrice: real("out_price"),
    /** null = charged as ordinary input (0 would mean free) */
    cachedInput: real("cached_input"),
    cacheWrite: real("cache_write"),
    maxOutputTokens: integer("max_output_tokens"),
    secPerChunk: real("sec_per_chunk"),
    /** scripting only: null leaves it to the model */
    reasoningEffort: text("reasoning_effort").$type<ReasoningEffort>(),
    /** scripting only: null = `default`; the texts are kept whatever the mode */
    promptMode: text("prompt_mode").$type<ProfilePrompt["mode"]>(),
    promptSystem: text("prompt_system"),
    promptUser: text("prompt_user"),
    /** scripting only: placed by `{{endpoint.notes}}` */
    promptNotes: text("prompt_notes"),
    /** transcription only: `hotword_lambda` sent beside the hinted names; null sends none */
    hotwordLambda: real("hotword_lambda"),
    /** transcription only: send 16 kHz mono WAV; false sends it as rendered */
    resample16k: integer("resample_16k", { mode: "boolean" }).notNull().default(true),

    // ---- speech rates ----
    billingUnit: text("billing_unit").$type<TtsBillingUnit>(),
    /** per 1M chars / bytes / input text tokens, per audio minute, or per request */
    billingRate: real("billing_rate"),
    /** `audio-tokens` only: USD per 1M output audio tokens */
    billingAudioRate: real("billing_audio_rate"),
    /** `audio-tokens` only: a per-model assumption, and estimates using it say so */
    audioTokensPerSecond: real("audio_tokens_per_second"),
    /** whether voice instructions are billed as submitted content */
    billsInstructions: integer("bills_instructions", { mode: "boolean" }),
    /** Rates from other billing units, parked so switching back restores them. */
    parkedRates: text("parked_rates", { mode: "json" }).$type<
      Partial<Record<TtsBillingUnit, ParkedRates>>
    >(),

    /** USD per 1M characters, used by the run estimator */
    price: real("price"),

    // ---- the schedule's timezone; the windows themselves are rows ----
    /**
     * IANA zone the windows are read in. Null = no rate card, read back as no `pricing` rather than
     * an empty one, so the app still fills in defaults on first use.
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

    /** expression tag support, for this exact model and base URL */
    expressionStatus: text("expression_status").$type<"unknown" | "unsupported" | "supported">(),
    expressionModel: text("expression_model"),
    expressionBaseUrl: text("expression_base_url"),
    expressionBrackets: text("expression_brackets", { mode: "json" }).$type<TagBracket[]>(),
    /** any words in those brackets, not only the listed tags */
    expressionOpen: integer("expression_open", { mode: "boolean" }),
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
    /** null = 1, the voice's own pace */
    speed: real("speed"),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.id] })],
);

/** `id` matches the same expression across models. */
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
 * A recurring window with its own rates. `from`/`to` are minutes past local midnight; `to <= from`
 * runs past midnight, and `days` names the day it starts on.
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
    /** wins over `percent` for the components it names */
    rates: text("rates", { mode: "json" }).$type<Partial<RateSet>>(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.id] })],
);

/** A temporary price change. Kept after it expires so the receipts it priced stay explicable. */
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
    /** ignore the schedule for the components they name */
    rates: text("rates", { mode: "json" }).$type<Partial<RateSet>>(),
    note: text("note"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.id] }),
    index("promotions_window").on(t.endpointId, t.fromAt, t.untilAt),
  ],
);
