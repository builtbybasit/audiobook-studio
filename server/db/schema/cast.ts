// The cast of a book, and how it should be pronounced.
//
// Both belong to the **book**, not to a chapter and not to a script version: restoring an old
// script must not roll the cast back with it, which is why neither of these is inside
// `script_versions`. See the script-history invariants in `src/stores/README.md`.
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Gender, VoiceRef } from "@/types";
import { books } from "~/db/schema/library";

/**
 * One speaker.
 *
 * Keyed by name, because the script refers to a speaker by name and nothing else — `Segment.speaker`
 * is a string, and re-attributing a line is a string change. A rename is therefore a key change that
 * has to move the lines with it, which is exactly why the name is the key rather than a surrogate id
 * that would let the two drift apart silently.
 */
export const characters = sqliteTable(
  "characters",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    /** every other name the same person is called in the text, as a JSON array */
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
    gender: text("gender").$type<Gender>().notNull().default("?"),
    description: text("description").notNull().default(""),
    /** `<endpointId>/<voiceId>`; null = borrows the Narrator's voice */
    voice: text("voice").$type<VoiceRef>(),
    /** free-text delivery note applied to every line this speaker has */
    style: text("style").notNull().default(""),
    color: text("color").notNull(),
    major: integer("major", { mode: "boolean" }).notNull().default(false),
    /** first seen in a re-script, not in the original cast */
    isNew: integer("is_new", { mode: "boolean" }),
    /** the user dismissed the merge suggestion for this name */
    keep: integer("keep", { mode: "boolean" }),
    /** the order the cast list reads in */
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.name] })],
);

/**
 * One entry of a book's pronunciation dictionary.
 *
 * The book text is never rewritten: the term is swapped for `say` on the way to the endpoint, so
 * the reader still shows the author's spelling. That is why this is a table beside the script
 * rather than an edit to it.
 */
export const lexiconEntries = sqliteTable(
  "lexicon_entries",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: integer("id").notNull(),
    /** as it is written in the book */
    term: text("term").notNull(),
    /** what the endpoint is sent instead */
    say: text("say").notNull(),
    /** reference spelling for humans; never sent anywhere */
    ipa: text("ipa"),
    note: text("note"),
    /** only match this capitalisation, for a term that is also an ordinary word */
    matchCase: integer("match_case", { mode: "boolean" }),
    /** off keeps the entry in the list without applying it */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    index("lexicon_book_term").on(t.bookId, t.term),
  ],
);
