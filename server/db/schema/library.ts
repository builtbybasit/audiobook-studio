// Books, volumes, chapters, and chapter text (its own table so listing chapters stays cheap).
// A chapter's number moves when a volume is removed, so children key on `(book_id, chapter_id)`
// with ON UPDATE CASCADE.
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import type { CharacterVoice } from "@/types";

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  coverFrom: text("cover_from").notNull(),
  coverTo: text("cover_to").notNull(),
  /** the cover's url under the API base, as a clip's is */
  coverImage: text("cover_image"),
  /** epoch ms; the API serialises it to YYYY-MM-DD */
  addedAt: integer("added_at").notNull(),
  /** in its contents review: not listed, nothing runs on it */
  importing: integer("importing", { mode: "boolean" }).notNull().default(false),
  budgetCap: real("budget_cap"),
  budgetPaused: integer("budget_paused", { mode: "boolean" }),
  scriptBudget: real("script_budget"),
  pacingLine: real("pacing_line"),
  pacingTurn: real("pacing_turn"),
  /** pauses inside a line; null = default */
  pacingInlineShort: real("pacing_inline_short"),
  pacingInlineLong: real("pacing_inline_long"),
  /** placed by `{{book.notes}}` */
  promptNotes: text("prompt_notes"),
  /** whether the texts below replace the prompt; kept either way */
  promptReplace: integer("prompt_replace", { mode: "boolean" }),
  promptSystem: text("prompt_system"),
  promptUser: text("prompt_user"),
  /** read `note` lines aloud; null = skip them */
  readNotes: integer("read_notes", { mode: "boolean" }),
  /** null = only when asked */
  checkByEar: integer("check_by_ear", { mode: "boolean" }),
  /** null = the scripting model suggests dictionary terms */
  pronounceOff: integer("pronounce_off", { mode: "boolean" }),
  /** null = the Cast page shows rough line counts, not exact ones */
  exactCounts: integer("exact_counts", { mode: "boolean" }),
  /** an effect id or "none"; null = the library's */
  thoughts: text("thoughts"),
  /** for speakers with no voice of their own; null = the Narrator's */
  characterVoice: text("character_voice", { mode: "json" }).$type<CharacterVoice>(),
});

export const volumes = sqliteTable(
  "volumes",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** per-book */
    id: integer("id").notNull(),
    name: text("name").notNull(),
    file: text("file").notNull(),
    /** inclusive chapter-number range */
    fromIndex: integer("from_index").notNull(),
    toIndex: integer("to_index").notNull(),
    /** reading order; chapters are numbered to follow it */
    position: integer("position").notNull(),
    importing: integer("importing", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.id] })],
);

export const chapters = sqliteTable(
  "chapters",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** the chapter number, continuous across volumes (`index` in the domain model) */
    id: integer("id").notNull(),
    /** identity, never rewritten; for what must not follow renumbering (the ledger) */
    uid: text("uid").notNull(),
    volumeId: integer("volume_id").notNull(),
    volumeIndex: integer("volume_index").notNull(),
    title: text("title").notNull(),
    words: integer("words").notNull(),
    scripting: text("scripting").notNull().default("none"),
    scriptingProgress: real("scripting_progress").notNull().default(0),
    narration: text("narration").notNull().default("none"),
    narrationProgress: real("narration_progress").notNull().default(0),
    duration: real("duration").notNull().default(0),
    /** skipped: out of every stage, still in the book, restorable */
    excluded: integer("excluded", { mode: "boolean" }),
    /** the user chose to keep a noted chapter */
    kept: integer("kept", { mode: "boolean" }),
    /** the import's note; null when the chapter read as story */
    note: text("note", { mode: "json" }).$type<unknown>(),
    /**
     * Times the script has been written; a scripting run writes only if it hasn't moved. Moved only
     * by `writeScript` in server/db/script.ts.
     */
    scriptRevision: integer("script_revision").notNull().default(0),
    /** the model's summary of where it leaves off; the next chapter's `{{previous.recap}}` */
    recap: text("recap"),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    unique("chapters_uid").on(t.uid),
    index("chapters_book_volume").on(t.bookId, t.volumeId),
  ],
);

export const chapterTexts = sqliteTable(
  "chapter_texts",
  {
    bookId: text("book_id").notNull(),
    chapterId: integer("chapter_id").notNull(),
    /**
     * Prose in blank-line blocks with `*italic*`, `**bold**` and `\*` inline (ranges would drift
     * under edits). Anything that counts, bills or speaks reads it through `plainText`.
     */
    body: text("body").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.chapterId] }),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "chapter_texts_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
);
