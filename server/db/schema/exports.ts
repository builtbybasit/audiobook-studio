// Audiobooks that have been built, and what each one was built from.
//
// A build makes one *export*, which is one or more files; grouping decides how many. An export is
// identified by `key` (name + format + grouping), so building the same audiobook again is a new
// **version** of it rather than a second entry.
//
// `export_chapters` carries the two per-chapter facts a finished export needs: the duration the
// chapter had **when it was built** (so it can be heard as built, not as the book stands now) and
// the signature of the audio it was built from. That signature is the whole mechanism behind
// "needs an update" — comparing it against the chapter's audio now is how a stale export is found —
// so it is a column on a row, not a key in a JSON map.
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type {
  ExportFormat,
  ExportGrouping,
  ExportScope,
  ExportSettings,
  ExportStatus,
  ExportVolume,
} from "@/types";
import { books, chapters } from "~/db/schema/library";
import { jobs } from "~/db/schema/jobs";

export const exportItems = sqliteTable(
  "exports",
  {
    id: integer("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** same name + format + grouping ⇒ the same audiobook, built again */
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    /** id of the export this one supersedes */
    replaces: integer("replaces"),
    status: text("status").$type<ExportStatus>().notNull(),
    progress: real("progress"),
    error: text("error"),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),

    /** the file, or the folder a set of files lives in */
    filename: text("filename").notNull(),
    title: text("title").notNull(),
    series: text("series").notNull().default(""),
    author: text("author").notNull().default(""),
    narrator: text("narrator").notNull().default(""),
    year: integer("year"),
    description: text("description").notNull().default(""),
    customCover: integer("custom_cover", { mode: "boolean" }),

    format: text("format").$type<ExportFormat>().notNull(),
    grouping: text("grouping").$type<ExportGrouping>().notNull(),
    bitrate: integer("bitrate"),
    chapterGap: real("chapter_gap"),
    normalize: integer("normalize", { mode: "boolean" }),
    /** integrated loudness target, LUFS */
    loudness: integer("loudness"),

    chapterCount: integer("chapter_count").notNull().default(0),
    duration: real("duration").notNull().default(0),
    /** MB */
    size: real("size").notNull().default(0),
    /** chapter marks written across every file */
    markers: integer("markers").notNull().default(0),
    createdAt: integer("created_at").notNull(),

    /**
     * Which chapters this export claims.
     *
     * A build of everything the book can give follows the book; three chapters picked on purpose
     * stay those three, and anything narrated elsewhere is offered separately rather than folded in
     * behind the user's back.
     */
    scope: text("scope").$type<ExportScope>(),
    /** everything it was built with, so an update starts from it rather than from the defaults */
    settings: text("settings", { mode: "json" }).$type<ExportSettings>(),

    /** chapters re-encoded by the build that made this version */
    rebuilt: integer("rebuilt"),
    /** chapters carried over from the previous version untouched */
    reused: integer("reused"),
    /** clips that were already stale when this was built, accepted on purpose */
    stale: integer("stale"),
  },
  (t) => [
    index("exports_book").on(t.bookId, t.id),
    index("exports_key").on(t.bookId, t.key, t.version),
  ],
);

/** One output file of a finished export. */
export const exportFiles = sqliteTable(
  "export_files",
  {
    exportId: integer("export_id")
      .notNull()
      .references(() => exportItems.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** 1-based position in the set */
    position: integer("position").notNull(),
    name: text("name").notNull(),
    duration: real("duration").notNull().default(0),
    /** MB */
    size: real("size").notNull().default(0),
    /** chapter marks inside this file; 0 when it is one chapter, or the format has none */
    markers: integer("markers").notNull().default(0),
    /** which volume this file covers, when a set is cut by volume */
    volume: text("volume", { mode: "json" }).$type<ExportVolume | null>(),
  },
  (t) => [primaryKey({ columns: [t.exportId, t.position] })],
);

/**
 * One chapter of a finished export, as it played when the export was built.
 *
 * `fileIndex` is which output file it landed in; `signature` is what its audio was at build time,
 * which is how "this export needs an update" is decided.
 */
export const exportChapters = sqliteTable(
  "export_chapters",
  {
    exportId: integer("export_id")
      .notNull()
      .references(() => exportItems.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** carried so the chapter can be keyed the way every other child of `chapters` is */
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    /** reading order within the export */
    position: integer("position").notNull(),
    fileIndex: integer("file_index"),
    /**
     * The title and duration this chapter had **at build time**, so the export can be heard as
     * built rather than as the book stands now.
     *
     * Both are null on an export made before the timeline was recorded. That is a real distinction
     * and not a tidiness one: a zero here would be indistinguishable from a chapter of silence,
     * and would hand the player a timeline that claims the audiobook is empty.
     */
    title: text("title"),
    duration: real("duration"),
    /** what this chapter's audio was when the export was built */
    signature: text("signature"),
  },
  (t) => [
    primaryKey({ columns: [t.exportId, t.chapterId] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "export_chapters_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("export_chapters_order").on(t.exportId, t.position),
  ],
);
