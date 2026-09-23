// A schema change that rebuilds a table, applied to a library that has books in it.
//
// SQLite cannot alter most of a table in place, so drizzle-kit writes such a change as a rebuild:
// create the new table, copy the rows, drop the old one, rename. With foreign keys on, that drop
// cascades — and drizzle runs migrations in a transaction, where SQLite ignores the
// `PRAGMA foreign_keys=OFF` the generated SQL puts first. No migration in `drizzle/` rebuilds a
// table yet; this writes the one the next schema change on `chapters` would, and runs it.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "~/app";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { epubFile, story } from "../support/epub";
import { collectingLogger } from "../support/server";

/** The migrations as they stand, somewhere a test can add one. */
function copyOfMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "audiobook-migrations-"));
  cpSync("./drizzle", dir, { recursive: true });
  return dir;
}

/** Add a migration that rebuilds `table` exactly as it is, the way drizzle-kit writes one. */
function addRebuild(db: Db, dir: string, table: string): void {
  const schema = db.$client
    .query("SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL")
    .all(table) as { type: string; sql: string }[];
  const create = schema.find((s) => s.type === "table")!.sql;
  const indexes = schema.filter((s) => s.type === "index").map((s) => s.sql);
  const tag = "9999_rebuild_" + table;
  const statements = [
    "PRAGMA foreign_keys=OFF;",
    create.replace(/CREATE TABLE [`"]?\w+[`"]?/, `CREATE TABLE \`__new_${table}\``) + ";",
    `INSERT INTO \`__new_${table}\` SELECT * FROM \`${table}\`;`,
    `DROP TABLE \`${table}\`;`,
    `ALTER TABLE \`__new_${table}\` RENAME TO \`${table}\`;`,
    "PRAGMA foreign_keys=ON;",
    ...indexes.map((sql) => sql + ";"),
  ];
  writeFileSync(join(dir, `${tag}.sql`), statements.join("\n--> statement-breakpoint\n"));
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[];
  };
  const last = journal.entries.at(-1)!;
  journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
  writeFileSync(journalPath, JSON.stringify(journal));
}

/** How many rows every table holds, so nothing can go missing without the test seeing which. */
function rowCounts(db: Db): Record<string, number> {
  const tables = db.$client
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.$client.query(`SELECT count(*) AS n FROM \`${name}\``).get() as { n: number }).n,
    ]),
  );
}

describe("a migration that rebuilds a table", () => {
  test("keeps every row that pointed at it", async () => {
    const dir = copyOfMigrations();
    const db = openDb(":memory:");
    migrate(db, dir);

    const form = new FormData();
    form.set(
      "file",
      await epubFile({ chapters: ["One", "Two"].map((title) => ({ title, paragraphs: story() })) }),
    );
    const app = createApp(db, { log: collectingLogger().log });
    const res = await app.request("http://api.test/api/books/import", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const before = rowCounts(db);
    expect(before.chapters).toBe(2);
    expect(before.chapter_texts).toBe(2);

    addRebuild(db, dir, "chapters");
    migrate(db, dir);

    expect(rowCounts(db)).toEqual(before);
    // and the keys are back on for the server that runs after it
    expect(
      (db.$client.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
    ).toBe(1);
  });

  test("a migration that leaves a row pointing at nothing stops the server starting", () => {
    const dir = copyOfMigrations();
    const db = openDb(":memory:");
    migrate(db, dir);
    db.$client.exec("PRAGMA foreign_keys = OFF;");
    db.$client.exec(
      "INSERT INTO chapter_texts (book_id, chapter_id, body) VALUES ('nobody', 1, 'orphan')",
    );
    db.$client.exec("PRAGMA foreign_keys = ON;");
    addRebuild(db, dir, "chapters");
    expect(() => migrate(db, dir)).toThrow(/pointing at nothing/);
  });
});
