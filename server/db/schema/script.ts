// The script: one row per line, the clips rendered from those lines, and the versions the script
// has been through.
//
// Three decisions shape this file.
//
// **A line is a row.** Segments are read per chapter, filtered by speaker, counted by state and
// rewritten one field at a time by every bulk correction in the app. That is relational work, and
// burying it in a JSON blob per chapter would mean rewriting a whole chapter to change one line's
// speaker.
//
// **A clip is a row too, and `role` says which clip it is.** `SegmentAudio`, the retake waiting for
// a verdict (`candidate`) and every superseded `Take` are the same shape wearing three hats — the
// domain types differ only in which optional fields they happen to carry. One table with a
// discriminator means accepting a retake is an update to two rows rather than a restructure, and it
// makes the rule in `src/stores/README.md` — that `_queueRender` can never leave a line with
// neither its clip nor its retake — a constraint over rows that a query can actually check.
//
// **A version's segments are a document.** `ScriptVersion.segments` is explicitly "an independent
// copy: nothing that happens later may reach into it". Normalising it would hand out exactly the
// shared references that copy exists to prevent, so it is stored whole.
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
  SpeechCharge,
  SplitMode,
  VersionOrigin,
  VoiceRef,
} from "@/types";
import type { ReqError } from "@/types";
import { chapters } from "~/db/schema/library";

/** One line of the script. */
export const segments = sqliteTable(
  "segments",
  {
    bookId: text("book_id").notNull(),
    /** the chapter's number, which moves when the book is renumbered — hence ON UPDATE CASCADE */
    chapterId: integer("chapter_id").notNull(),
    /** the line's id within its chapter */
    id: integer("id").notNull(),
    /** reading order; kept apart from `id` so a split can insert without renumbering the chapter */
    position: integer("position").notNull(),
    type: text("type").$type<SegmentType>().notNull(),
    /** a `characters.name` of the same book, by value — an unmatched name is a routing issue, not an error */
    speaker: text("speaker").notNull(),
    text: text("text").notNull(),
    /** per-line delivery note, on top of the speaker's own style */
    direction: text("direction").notNull().default(""),

    /** the LLM failed verification on this run and the chunk was kept whole as narration */
    fallback: integer("fallback", { mode: "boolean" }),
    fallbackCount: integer("fallback_count"),
    fallbackMismatch: text("fallback_mismatch"),

    /** changed by hand; survives a re-script when "keep my edits" is on */
    edited: integer("edited", { mode: "boolean" }),
    /** seconds of silence after this line, overriding the book's pacing; 0 = run straight on */
    pause: real("pause"),
    /** the exact whitespace that followed this line in the source, when it is not a single space */
    sep: text("sep"),

    /** what a listener complained about after hearing the clip */
    flag: text("flag", { mode: "json" }).$type<SegmentFlag>(),
    /** expression tags placed at positions in the unchanged source text */
    expressions: text("expressions", { mode: "json" }).$type<ExpressionAnnotation[]>(),
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

/**
 * Which clip of its line this is.
 *
 *   current    the clip the chapter plays, times and exports
 *   candidate  a retake rendering beside it, waiting for a verdict — nothing reads it as the book's
 *   take       a superseded clip, kept so two takes can be compared
 */
export type ClipRole = "current" | "candidate" | "take";

/**
 * One rendered clip, and the receipt for it.
 *
 * The audit columns — what voice, what model, what text was actually sent — are what let drift tell
 * "the script changed" from "the delivery changed", so they are columns rather than a blob: the
 * stale check reads them on every line of a chapter.
 */
export const clips = sqliteTable(
  "clips",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    segmentId: integer("segment_id").notNull(),
    /** surrogate, because a line can hold many takes at once */
    id: integer("id").primaryKey({ autoIncrement: true }),
    role: text("role").$type<ClipRole>().notNull(),
    /** take number, stable for the life of the segment; null on a clip that has never been retaken */
    n: integer("n"),

    status: text("status").$type<AudioStatus>().notNull().default("none"),
    endpoint: text("endpoint"),
    /** request round trip, ms */
    ms: real("ms").notNull().default(0),
    /** the clip's own length, seconds. Silence stitched in locally is not generated audio. */
    duration: real("duration").notNull().default(0),
    /** where the rendered audio is; null until there is a file */
    url: text("url"),

    /** set when the request goes out, for the in-flight elapsed readout */
    startedAt: integer("started_at"),
    at: integer("at"),

    // ---- what was actually sent, captured at render time ----
    voiceRef: text("voice_ref").$type<VoiceRef>(),
    voice: text("voice"),
    model: text("model"),
    direction: text("direction"),
    style: text("style"),
    /** the instructions submitted beside the line; a provider that meters what it receives meters these */
    instructions: text("instructions"),
    type: text("type").$type<SegmentType>(),
    /** the exact text sent, so drift can tell a script change from a delivery change */
    text: text("text"),
    /** the text after the pronunciation dictionary, when it differed */
    said: text("said"),
    /** how many dictionary substitutions this clip carried */
    lex: integer("lex"),
    pronounced: text("pronounced"),
    expressionSignature: text("expression_signature"),
    expressions: text("expressions", { mode: "json" }).$type<string[]>(),

    // ---- splitting, when the line exceeded the endpoint's per-request cap ----
    parts: integer("parts"),
    splitAt: text("split_at").$type<SplitMode>(),
    cuts: text("cuts", { mode: "json" }).$type<Cut[]>(),

    /** a replacement queued by a bulk run rather than a retake asked for by hand */
    auto: integer("auto", { mode: "boolean" }),
    /** the listener heard it and chose the other take */
    rejected: integer("rejected", { mode: "boolean" }),

    // ---- the money ----
    /** null = this endpoint's rate is not known, which is never the same as free */
    cost: real("cost"),
    /**
     * The receipt: the rate in force when this landed, what moved it off the card, and what it was
     * charged on. Written once when the render settles and never recalculated, so editing a rate
     * or letting a promotion expire leaves every clip at the price it was actually charged. Stored
     * whole because that is what it is — a frozen document, not a row to be updated.
     */
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
    /**
     * A line has at most one clip in the book and at most one retake awaiting a verdict. Takes are
     * a list and are deliberately not covered: the partial index only constrains the two roles that
     * are singular, so the rule holds in the database rather than only in the store.
     */
    uniqueIndex("clips_one_per_role")
      .on(t.bookId, t.chapterId, t.segmentId, t.role)
      .where(sql`role <> 'take'`),
  ],
);

/**
 * One version of a chapter's script.
 *
 * Content only: the cast, the voices, the dictionary and the endpoint settings belong to the book
 * and are never rolled back with a chapter, and the audio is carried across a restore clip by clip
 * rather than stored twice.
 */
export const scriptVersions = sqliteTable(
  "script_versions",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    /** 1-based, stable for the life of the chapter — what the panel calls "v3" */
    id: integer("id").notNull(),
    /** when this content was last changed; 0 for a script that predates the session */
    at: integer("at").notNull(),
    /** how this script came to be: scripted, edited, bulk, restored, or a named checkpoint */
    origin: text("origin", { mode: "json" }).$type<VersionOrigin>().notNull(),
    /** an independent copy of the script at that moment */
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
 * Where a chapter's working script stands, and the next version number to hand out.
 *
 * One row per chapter that anything has happened to. `nextId` is stored rather than derived from
 * `max(script_versions.id)`, because a version number is never reused even after a version is
 * dropped — "v3" has to keep meaning the same script to the person reading the panel.
 */
export const scriptHeads = sqliteTable(
  "script_heads",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    at: integer("at").notNull(),
    origin: text("origin", { mode: "json" }).$type<VersionOrigin>().notNull(),
    /** an editing session later edits still join, until it goes quiet */
    open: integer("open", { mode: "boolean" }),
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

/**
 * The script a re-script replaced, kept while its diff is on screen.
 *
 * `scripts._previous` in the store. It is not history — history is `script_versions` — it is the
 * one-shot "here is what just changed" the Scripting page shows after a run, and it is dropped when
 * the diff is dismissed.
 */
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
