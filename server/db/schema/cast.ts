// A book's cast and pronunciation dictionary. Both belong to the book, so restoring a script
// version never rolls them back.
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { Age, CharacterProfile, FactKind, Gender, VoiceRef, VoiceType } from "@/types";
import { books, chapters } from "~/db/schema/library";

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
    /** null = unknown */
    age: text("age").$type<Age>(),
    /** null = unknown */
    voiceType: text("voice_type", { mode: "json" }).$type<VoiceType>(),
    /** the user's own; blank = the profile stands in */
    description: text("description").notNull().default(""),
    /** the model's, from `character_facts`; never written by the client */
    profile: text("profile", { mode: "json" }).$type<CharacterProfile>(),
    /** the highest `character_facts.id` the profile was written from */
    profileUpTo: integer("profile_up_to").notNull().default(0),
    /** facts were removed or moved in: rewrite from all of them, not just the newer ones */
    profileRebuild: integer("profile_rebuild", { mode: "boolean" }).notNull().default(false),
    /** fields the user set by hand, which a profile rewrite leaves alone */
    edited: text("edited", { mode: "json" }).$type<("age" | "voiceType")[]>().notNull().default([]),
    /** `<endpointId>/<voiceId>`; null = borrows the Narrator's voice */
    voice: text("voice").$type<VoiceRef>(),
    /** delivery note for every line of this speaker */
    style: text("style").notNull().default(""),
    /** null = 1, the voice's own pace */
    speed: real("speed"),
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
    /** the wiki page last filled from */
    wiki: text("wiki", { mode: "json" }).$type<{ url: string; at: number }>(),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.name] })],
);

/** What one chapter's script says of a speaker; a re-script replaces that chapter's rows. */
export const characterFacts = sqliteTable(
  "character_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookId: text("book_id").notNull(),
    speaker: text("speaker").notNull(),
    chapterId: integer("chapter_id").notNull(),
    kind: text("kind").$type<FactKind>().notNull(),
    text: text("text").notNull(),
    /** the cited paragraphs' text, kept with the fact; null for older facts */
    evidence: text("evidence"),
    sourceIds: text("source_ids", { mode: "json" }).$type<number[]>(),
  },
  (t) => [
    foreignKey({
      columns: [t.bookId, t.speaker],
      foreignColumns: [characters.bookId, characters.name],
      name: "character_facts_speaker_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "character_facts_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("character_facts_speaker").on(t.bookId, t.speaker),
    index("character_facts_chapter").on(t.bookId, t.chapterId),
  ],
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
    /** a `characters.name` by value, kept in step by the cast ops */
    speaker: text("speaker"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.id] }),
    index("lexicon_book_term").on(t.bookId, t.term),
  ],
);
