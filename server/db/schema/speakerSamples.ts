// Voice samples imported with a script, kept against the speaker until someone clones or discards
// them (a private clone can't travel between accounts). The FK cascades renames and removals; the
// files live under the book's audio directory.
import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { SampleFormat } from "~/providers/clone";
import { characters } from "~/db/schema/cast";

export const speakerSamples = sqliteTable(
  "speaker_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: text("book_id").notNull(),
    speaker: text("speaker").notNull(),
    /** the clone form starts from it */
    title: text("title").notNull(),
    source: text("source").notNull(),
    /** epoch ms */
    storedAt: integer("stored_at").notNull(),
    /** Epoch ms discarded: hidden at once, restorable by Undo, removed with files a day later. */
    discardedAt: integer("discarded_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.bookId, t.speaker],
      foreignColumns: [characters.bookId, characters.name],
      name: "speaker_samples_character_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("speaker_samples_book").on(t.bookId),
  ],
);

/** One waiting recording. The bytes are on disk under `<AUDIO_DIR>/<bookId>/samples/`. */
export const speakerSampleFiles = sqliteTable(
  "speaker_sample_files",
  {
    sampleId: integer("sample_id")
      .notNull()
      .references(() => speakerSamples.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** `<sha>.<ext>`, the name on disk and in urls */
    file: text("file").notNull(),
    name: text("name").notNull(),
    /** sniffed from the bytes; served as this */
    format: text("format").$type<SampleFormat>().notNull(),
    bytes: integer("bytes").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sampleId, t.file] })],
);
