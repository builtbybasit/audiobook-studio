// Built audiobooks. A build makes one export of one or more files; the same `key` built again is
// a new version. `export_chapters.signature` against the chapter's audio now is how a stale export
// is found.
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
    /** the export this one supersedes */
    replaces: integer("replaces"),
    status: text("status").$type<ExportStatus>().notNull(),
    progress: real("progress"),
    error: text("error"),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),

    /** the file, or the folder of a set */
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
    /** chapter marks across every file */
    markers: integer("markers").notNull().default(0),
    createdAt: integer("created_at").notNull(),

    /** Which chapters it claims: "everything" follows the book; a hand-picked set stays put. */
    scope: text("scope").$type<ExportScope>(),
    /** what it was built with, so an update starts from it */
    settings: text("settings", { mode: "json" }).$type<ExportSettings>(),

    /** clips already stale at build time, accepted on purpose */
    stale: integer("stale"),
  },
  (t) => [
    index("exports_book").on(t.bookId, t.id),
    index("exports_key").on(t.bookId, t.key, t.version),
  ],
);

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
    /** 0 when it is one chapter or the format has none */
    markers: integer("markers").notNull().default(0),
    /** set when cut by volume */
    volume: text("volume", { mode: "json" }).$type<ExportVolume | null>(),
    /**
     * The token on disk (`server/exports/files.ts`), not `name`: two versions share a name. Null
     * when nothing was written yet.
     */
    path: text("path"),
  },
  (t) => [primaryKey({ columns: [t.exportId, t.position] })],
);

/** One chapter of a finished export, as it played when built. */
export const exportChapters = sqliteTable(
  "export_chapters",
  {
    exportId: integer("export_id")
      .notNull()
      .references(() => exportItems.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** carried so the chapter FK matches every other child of `chapters` */
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    position: integer("position").notNull(),
    fileIndex: integer("file_index"),
    /** At build time. Null when unrecorded, never 0, which would read as a chapter of silence. */
    title: text("title"),
    duration: real("duration"),
    /** the chapter's audio at build time; differs from now = needs an update */
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
