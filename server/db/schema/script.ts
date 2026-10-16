// The script: a row per line (bulk edits touch one field), a row per clip with `role` telling the
// book's clip, the retake and old takes apart, and versions stored whole as independent copies.
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
  AudioStatus,
  Cut,
  ExpressionAnnotation,
  Segment,
  SegmentFlag,
  SegmentType,
  SiteCheck,
  SpeechCharge,
  SplitMode,
  VersionOrigin,
  VoiceRef,
} from "@/types";
import type { ReqError } from "@/types";
import { books, chapters } from "~/db/schema/library";

export const segments = sqliteTable(
  "segments",
  {
    bookId: text("book_id").notNull(),
    /** the chapter's number, which moves on renumbering — hence ON UPDATE CASCADE */
    chapterId: integer("chapter_id").notNull(),
    id: integer("id").notNull(),
    /** reading order; apart from `id` so a split can insert without renumbering */
    position: integer("position").notNull(),
    type: text("type").$type<SegmentType>().notNull(),
    /** a `characters.name` by value; an unmatched name is a routing issue, not an error */
    speaker: text("speaker").notNull(),
    text: text("text").notNull(),
    /** delivery note on top of the speaker's style */
    direction: text("direction").notNull().default(""),

    /** the LLM failed verification and the chunk was kept whole as narration */
    fallback: integer("fallback", { mode: "boolean" }),
    fallbackCount: integer("fallback_count"),
    fallbackMismatch: text("fallback_mismatch"),

    /** changed by hand */
    edited: integer("edited", { mode: "boolean" }),
    /** the site-text detector's suggested type, until a person decides */
    siteCheck: text("site_check", { mode: "json" }).$type<SiteCheck>(),
    /** seconds of silence after, overriding the book's pacing; 0 = run straight on */
    pause: real("pause"),
    /** the source whitespace after this line, when not a single space */
    sep: text("sep"),

    flag: text("flag", { mode: "json" }).$type<SegmentFlag>(),
    /** tags at positions in the unchanged source text */
    expressions: text("expressions", { mode: "json" }).$type<ExpressionAnnotation[]>(),
    /** effect ids; null = none */
    effects: text("effects", { mode: "json" }).$type<string[]>(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.chapterId, t.id] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "segments_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("segments_chapter_order").on(t.bookId, t.chapterId, t.position),
    index("segments_speaker").on(t.bookId, t.speaker),
  ],
);

/** current = the clip the book plays; candidate = a retake awaiting a verdict; take = old. */
export type ClipRole = "current" | "candidate" | "take";

/**
 * One rendered clip and its receipt. What was sent is in columns, not a blob: the stale check
 * reads them on every line to tell a script change from a delivery change.
 */
export const clips = sqliteTable(
  "clips",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    segmentId: integer("segment_id").notNull(),
    /** surrogate: a line can hold many takes */
    id: integer("id").primaryKey({ autoIncrement: true }),
    role: text("role").$type<ClipRole>().notNull(),
    /** take number, stable for the segment's life; null if never retaken */
    n: integer("n"),

    status: text("status").$type<AudioStatus>().notNull().default("none"),
    endpoint: text("endpoint"),
    /** request round trip, ms */
    ms: real("ms").notNull().default(0),
    /** seconds, excluding locally stitched silence */
    duration: real("duration").notNull().default(0),
    url: text("url"),

    /** set when the request goes out, for the elapsed readout */
    startedAt: integer("started_at"),
    at: integer("at"),

    // ---- what was sent, captured at render time ----
    voiceRef: text("voice_ref").$type<VoiceRef>(),
    voice: text("voice"),
    model: text("model"),
    direction: text("direction"),
    style: text("style"),
    /** sent beside the line; metered by providers that meter input */
    instructions: text("instructions"),
    type: text("type").$type<SegmentType>(),
    text: text("text"),
    /** the text after the pronunciation dictionary, when it differed */
    said: text("said"),
    /** dictionary substitutions made */
    lex: integer("lex"),
    pronounced: text("pronounced"),
    expressionSignature: text("expression_signature"),
    expressions: text("expressions", { mode: "json" }).$type<string[]>(),
    /** Hz, read from the file rather than the request */
    sampleRate: integer("sample_rate"),
    /** the effects baked into the file (`soundOf`); null = the voice's own */
    sound: text("sound"),
    /** the unprocessed file when `url` has effects applied; null = `url` is it */
    raw: text("raw"),

    // ---- splitting, when the line exceeded the endpoint's per-request cap ----
    parts: integer("parts"),
    splitAt: text("split_at").$type<SplitMode>(),
    cuts: text("cuts", { mode: "json" }).$type<Cut[]>(),

    /** queued by a bulk run rather than by hand */
    auto: integer("auto", { mode: "boolean" }),
    rejected: integer("rejected", { mode: "boolean" }),

    // ---- the money ----
    /** null = rate unknown, never the same as free */
    cost: real("cost"),
    /** The receipt, written once when the render settles and never recalculated. */
    charge: text("charge", { mode: "json" }).$type<SpeechCharge>(),

    error: text("error", { mode: "json" }).$type<ReqError>(),
  },
  (t) => [
    foreignKey({
      columns: [t.bookId, t.chapterId, t.segmentId],
      foreignColumns: [segments.bookId, segments.chapterId, segments.id],
      name: "clips_segment_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("clips_segment").on(t.bookId, t.chapterId, t.segmentId),
    /** Covers the per-endpoint counts the Queue polls (`clipsByEndpoint`). */
    index("clips_endpoint").on(t.role, t.endpoint, t.status),
    /** At most one current and one candidate per line; takes are a list. */
    uniqueIndex("clips_one_per_role")
      .on(t.bookId, t.chapterId, t.segmentId, t.role)
      .where(sql`role <> 'take'`),
  ],
);

/**
 * One version of a chapter's script: content only. Cast, voices and settings are the book's and
 * never roll back; audio is carried across a restore rather than stored twice.
 */
export const scriptVersions = sqliteTable(
  "script_versions",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    /** 1-based, stable for the chapter's life — the panel's "v3" */
    id: integer("id").notNull(),
    /** when this content was last changed; 0 for a script that predates the session */
    at: integer("at").notNull(),
    origin: text("origin", { mode: "json" }).$type<VersionOrigin>().notNull(),
    /** an independent copy; nothing later may reach into it */
    segments: text("segments", { mode: "json" }).$type<Segment[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.chapterId, t.id] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "script_versions_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("script_versions_chapter").on(t.bookId, t.chapterId, t.at),
  ],
);

/**
 * Where a chapter's working script stands. `nextId` is stored, not `max(id)`, so a dropped
 * version's number is never reused.
 */
export const scriptHeads = sqliteTable(
  "script_heads",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    at: integer("at").notNull(),
    origin: text("origin", { mode: "json" }).$type<VersionOrigin>().notNull(),
    /** an editing session later edits join, until it goes quiet */
    open: integer("open", { mode: "boolean" }),
    /**
     * The version the open session's first edit preserved. A session that returns to exactly that
     * script drops this version and no other.
     */
    sessionVersion: integer("session_version"),
    nextId: integer("next_id").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.chapterId] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "script_heads_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
);

/** The script a re-script replaced, kept until its diff is dismissed. Not history. */
export const previousScripts = sqliteTable(
  "previous_scripts",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    segments: text("segments", { mode: "json" }).$type<Segment[]>().notNull(),
    /** what the run did with the manual corrections it was asked to preserve */
    corrections: text("corrections", { mode: "json" }).$type<unknown>(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.chapterId] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "previous_scripts_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
);

/**
 * A check by ear's finding for one clip (`HeardLine`). Keyed by file, not row: `replaceScript`
 * rewrites clip rows but a render's file never changes. `text` is the line as checked, so an edit
 * since reads as unchecked.
 */
export const heard = sqliteTable(
  "heard",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** the file name under the book's audio directory */
    file: text("file").notNull(),
    text: text("text").notNull(),
    heard: text("heard").notNull(),
    /** `[from, to, start, end]` per word heard; null when the endpoint gave no word times */
    words: text("words", { mode: "json" }).$type<[number, number, number, number][]>(),
    score: real("score").notNull(),
    mismatch: integer("mismatch", { mode: "boolean" }).notNull(),
    endpoint: text("endpoint").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.file] })],
);

/**
 * A clip's old sound kept on purpose ("Keep old sound"), against what its line wanted then. Keyed
 * by file like `heard`: script saves rewrite clip rows, and a new file starts out not kept.
 */
export const keptSounds = sqliteTable(
  "kept_sounds",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** the line's `soundOf` when kept; null = it wanted no effect */
    want: text("want"),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.url] })],
);
