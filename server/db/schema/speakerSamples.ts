// Voice samples that came in a script file and wait with a speaker until someone clones them.
//
// A private clone lives on the account that made it, so a script that names one hands the reader a
// voice they cannot use — unless the export carried the recordings it was made from. Those arrive
// with no voice to belong to: no provider has made one from them here yet. So they are kept
// against the **speaker**, the one thing both books agree on, until the Voices tab clones them (and
// slice 2's store takes them over) or the person discards them. See docs/script-transfer.md.
//
// **Keyed to the character by value, with the cascade doing the bookkeeping.** A speaker renamed on
// the Cast page carries the recordings with it, as it carries the lines; a speaker removed, or a
// book removed, takes them away. The files themselves are under the book's own audio directory,
// so removing the book removes them from disk too.
import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { SampleFormat } from "~/providers/clone";
import { characters } from "~/db/schema/cast";

/** One voice's recordings, waiting with one speaker of one book. */
export const speakerSamples = sqliteTable(
  "speaker_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: text("book_id").notNull(),
    speaker: text("speaker").notNull(),
    /** the voice's title where it was kept, which the clone form starts from */
    title: text("title").notNull(),
    /** epoch ms and sentence from the file's consent record — what someone agreed to, elsewhere */
    consentAt: integer("consent_at").notNull(),
    consentText: text("consent_text").notNull(),
    /** the name of the script file they came in */
    source: text("source").notNull(),
    /** epoch ms they were stored here */
    storedAt: integer("stored_at").notNull(),
    /**
     * Epoch ms the person discarded them. Hidden from every read at once, restorable by the
     * discard's Undo, and removed with their files by a read a day later — slice 2's forget, here.
     */
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
    /** `<sha>.<ext>` — the name on disk, and the one a url asks for */
    file: text("file").notNull(),
    /** the name the recording had in the script file */
    name: text("name").notNull(),
    /** what the bytes say they are, which is what they are served as */
    format: text("format").$type<SampleFormat>().notNull(),
    bytes: integer("bytes").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.sampleId, t.file] })],
);
