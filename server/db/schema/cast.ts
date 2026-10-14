// A book's cast and pronunciation dictionary. Both belong to the book, so restoring a script
// version never rolls them back.
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Gender, VoiceRef } from "@/types";
import { books } from "~/db/schema/library";

/** One speaker, keyed by name as `Segment.speaker` is; a rename must move the lines with it. */
export const characters = sqliteTable(
  "characters",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    /** other names the same person goes by in the text */
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
    gender: text("gender").$type<Gender>().notNull().default("?"),
    description: text("description").notNull().default(""),
    /** `<endpointId>/<voiceId>`; null = borrows the Narrator's voice */
    voice: text("voice").$type<VoiceRef>(),
    /** delivery note for every line of this speaker */
    style: text("style").notNull().default(""),
    color: text("color").notNull(),
    major: integer("major", { mode: "boolean" }).notNull().default(false),
    /** first seen in a re-script */
    isNew: integer("is_new", { mode: "boolean" }),
    /** the user dismissed the merge suggestion for this name */
    keep: integer("keep", { mode: "boolean" }),
    /** effect id for every line of this speaker */
    effect: text("effect"),
    /** an effect id or "none"; null = the book's */
    thoughts: text("thoughts"),
    /** the name of the character this one is a persona of */
    personaOf: text("persona_of"),
    /** a disguise the scripting model found */
    masked: integer("masked", { mode: "boolean" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.name] })],
);

/** A pronunciation entry: `term` is swapped for `say` when sent; the text is never rewritten. */
export const lexiconEntries = sqliteTable(
  "lexicon_entries",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: integer("id").notNull(),
    term: text("term").notNull(),
    say: text("say").notNull(),
    /** for humans; never sent */
    ipa: text("ipa"),
    note: text("note"),
    /** for a term that is also an ordinary word */
    matchCase: integer("match_case", { mode: "boolean" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    index("lexicon_book_term").on(t.bookId, t.term),
  ],
);
