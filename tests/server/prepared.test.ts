// `insertRows` stands in for drizzle's own insert on the writes that repeat by the thousand — a
// script, an import, the demo's seed — so it has to write exactly what drizzle would: the same
// values, the same SQLite types, the same defaults for a key left out. The seed's round trip in
// `schema.test.ts` reads rows back through the mappers, which would not notice a null JSON column
// written as the text `null` or a boolean stored as text; this compares what SQLite holds.
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLiteInsertValue } from "drizzle-orm/sqlite-core";

import type { Db } from "~/db/client";
import { insertRows } from "~/db/prepared";
import { books, characters } from "~/db/schema";
import { testDb } from "../support/server";

/** Every column of every row the book holds, each with the type SQLite stored it as. */
function stored(db: Db, table: string, bookId: string): unknown[][] {
  const columns = db.$client.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const picked = columns.map((c) => `typeof("${c.name}"), "${c.name}"`).join(", ");
  return db.$client
    .query(`SELECT ${picked} FROM ${table} WHERE book_id = ? ORDER BY rowid`)
    .values(bookId);
}

function withBooks(...ids: string[]): Db {
  const db = testDb();
  for (const id of ids)
    db.insert(books)
      .values({ id, title: id, author: "", coverFrom: "", coverTo: "", addedAt: 0 })
      .run();
  return db;
}

describe("inserting many rows", () => {
  test("writes what drizzle's own insert writes: values, types, and the defaults of keys left out", () => {
    const db = withBooks("drizzle", "prepared");
    const cast = (bookId: string): SQLiteInsertValue<typeof characters>[] => [
      // every defaulted key left out, the nullable ones too
      { bookId, name: "Mara", color: "#111" },
      // an empty JSON array, a null text, a false boolean and a null one
      {
        bookId,
        name: "Idris",
        color: "#222",
        aliases: [],
        voice: null,
        major: false,
        isNew: null,
        keep: true,
        position: 3,
      },
      // a value that is SQL rather than data goes into the statement's text
      { bookId, name: "Oren", color: "#333", description: sql`'said ' || 'in SQL'` },
    ];
    db.insert(characters).values(cast("drizzle")).run();
    db.transaction((tx) => insertRows(tx, characters, cast("prepared")));

    const drizzle = stored(db, "characters", "drizzle");
    const prepared = stored(db, "characters", "prepared").map((row) =>
      row.map((v) => (v === "prepared" ? "drizzle" : v)),
    );
    expect(prepared).toEqual(drizzle);
    expect(drizzle).toHaveLength(3);
  });
});
