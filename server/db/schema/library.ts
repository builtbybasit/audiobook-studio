// The library: books, the volumes they were assembled from, their chapters, and the chapter text
// the EPUB actually contained.
//
// Chapter text is a table of its own. The contents review lists a few hundred chapters at a time
// and needs none of their prose; keeping it out of `chapters` means that listing stays a cheap read
// no matter how long the book is.
//
// `chapters` is the table everything downstream hangs off. A chapter is addressed by its **number**
// within the book, continuous across volumes, and that number moves when a volume is removed — so
// every child keys on `(book_id, chapter_id)` with `ON UPDATE CASCADE`, and a renumbering carries
// the script, the clips and the history with it rather than orphaning them.
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

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  coverFrom: text("cover_from").notNull(),
  coverTo: text("cover_to").notNull(),
  /** the EPUB's own cover, a file under the book's covers directory; null when it had none */
  coverImage: text("cover_image"),
  /** epoch ms; the API serialises this to the YYYY-MM-DD the shelf shows */
  addedAt: integer("added_at").notNull(),
  /** still in its contents review: the library does not list it and nothing runs on it */
  importing: integer("importing", { mode: "boolean" }).notNull().default(false),
  budgetCap: real("budget_cap"),
  budgetPaused: integer("budget_paused", { mode: "boolean" }),
  scriptBudget: real("script_budget"),
  pacingLine: real("pacing_line"),
  pacingTurn: real("pacing_turn"),
});

export const volumes = sqliteTable(
  "volumes",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** per-book, not global: volume 1 of every book is 1 */
    id: integer("id").notNull(),
    name: text("name").notNull(),
    file: text("file").notNull(),
    /** inclusive chapter-number range this volume covers */
    fromIndex: integer("from_index").notNull(),
    toIndex: integer("to_index").notNull(),
    /** the order volumes are read in; chapters are numbered to follow it */
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
    /** the chapter number, continuous across volumes; `index` in the domain model is the same value */
    id: integer("id").notNull(),
    /**
     * This chapter, for as long as it exists — assigned once at import and never rewritten.
     *
     * The number above is an *address*, not an identity: removing volume 1 turns chapter 2 into
     * chapter 1. Everything that keys on the address follows it by cascade, which is right for the
     * script and the clips because they move with the chapter. It is wrong for anything that must
     * not be rewritten — the spending ledger is append-only, and a row that said "chapter 2" and now
     * says "chapter 1" is not a record of the past, it is a quiet edit of one. Those reference this.
     */
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
    /** skipped for the audiobook: out of every stage, still in the book, restorable */
    excluded: integer("excluded", { mode: "boolean" }),
    /** the user read the note and chose to keep the chapter */
    kept: integer("kept", { mode: "boolean" }),
    /** the import's note, as JSON; null when the chapter read as story */
    note: text("note", { mode: "json" }).$type<unknown>(),
    /**
     * How many times this chapter's script has been written.
     *
     * A scripting job reads it when it starts and writes only if it has not moved, so a slow run
     * can never overwrite a script that was edited or replaced while it was working. Moved by
     * `writeScript` in `server/db/script.ts` and nothing else.
     */
    scriptRevision: integer("script_revision").notNull().default(0),
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
     * The chapter's prose, blocks separated by blank lines, with the emphasis the EPUB carried
     * marked `*italic*` and `**bold**`, and a literal `*` escaped `\*`.
     *
     * One column rather than prose here and its emphasis beside it, because the two would come
     * apart: the text is edited, split and joined all through scripting, and a range recorded
     * against it would point at the wrong words after the first edit. `plainText` is what anything
     * that counts, bills or speaks this reads.
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
