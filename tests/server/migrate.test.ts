// A schema change that rebuilds a table, applied to a library that has books in it.
//
// SQLite cannot alter most of a table in place, so drizzle-kit writes such a change as a rebuild:
// create the new table, copy the rows, drop the old one, rename. With foreign keys on, that drop
// cascades — and drizzle runs migrations in a transaction, where SQLite ignores the
// `PRAGMA foreign_keys=OFF` the generated SQL puts first. No migration in `drizzle/` rebuilds a
// table yet; this writes the one the next schema change on `chapters` would, and runs it.
//
// And the migrations that rewrite rows rather than tables: a book's cover, once kept as a file
// name, kept as the url it is served at; and a label, once naming its chapter by id, naming none.
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

/**
 * A database migrated up to just before `tag`, and the call that applies `tag` and the rest. The
 * migration and every one after it are held back: one is applied only if it is newer than the last
 * that was.
 */
function migratedUpTo(tag: string): { db: Db; rest: () => void } {
  const dir = copyOfMigrations();
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = readFileSync(journalPath, "utf8");
  const before = JSON.parse(journal) as { entries: { tag: string }[] };
  before.entries = before.entries.slice(
    0,
    before.entries.findIndex((e) => e.tag === tag),
  );
  writeFileSync(journalPath, JSON.stringify(before));
  const db = openDb(":memory:");
  migrate(db, dir);
  return {
    db,
    rest: () => {
      writeFileSync(journalPath, journal);
      migrate(db, dir);
    },
  };
}

describe("keeping a cover as its url", () => {
  test("gives a cover kept as a file name the real library's url for it", () => {
    const { db, rest } = migratedUpTo("0012_cover_urls");
    db.$client.exec(
      "INSERT INTO books (id, title, author, cover_from, cover_to, cover_image, added_at) VALUES " +
        "('kept', 'Kept', 'A', '#000', '#111', 'abc.png', 0), " +
        "('none', 'None', 'A', '#000', '#111', NULL, 0)",
    );

    rest();
    expect(db.$client.query("SELECT id, cover_image FROM books ORDER BY id").all()).toEqual([
      { id: "kept", cover_image: "/api/books/kept/covers/abc.png" },
      { id: "none", cover_image: null },
    ]);
  });
});

describe("labels without their chapter", () => {
  test("takes the chapter's id out of a job's label, and out of a request's while the chapter is there", () => {
    const { db, rest } = migratedUpTo("0026_labels_without_chapter");
    db.$client.exec(
      "INSERT INTO books (id, title, author, cover_from, cover_to, added_at) VALUES ('b', 'B', 'A', '#000', '#111', 0);" +
        "INSERT INTO volumes (book_id, id, name, file, from_index, to_index, position) VALUES ('b', 1, 'V', 'v.epub', 0, 0, 0);" +
        "INSERT INTO chapters (book_id, id, uid, volume_id, volume_index, title, words) VALUES ('b', 4, 'u4', 1, 0, 'The Gate', 10);",
    );
    const jobs = [
      "Narrate · ch 4",
      "Re-script · ch 4 · DeepSeek · ch 9",
      "Retake · ch 4",
      "Build M4B · 18 ch",
      "Script · ch 4b",
    ];
    for (const [i, label] of jobs.entries())
      db.$client
        .query(
          "INSERT INTO jobs (id, kind, book_id, label, status, queued_at) VALUES (?, 'narration', 'b', ?, 'done', 0)",
        )
        .run(i + 1, label);
    const requests: [string, string | null][] = [
      ["Script chunk 2 · ch 4", "u4"],
      ["Prompt trial · ch 4 · part 2/3", "u4"],
      ["Check · The Gate", "u4"],
      // the chapter has gone: the label is the one trace of it left
      ["Script chunk 1 · ch 7", null],
      ["Check · A Chapter Since Removed", null],
    ];
    for (const [i, [label, uid]] of requests.entries())
      db.$client
        .query(
          "INSERT INTO requests (id, endpoint_id, kind, label, status, queued_at, cost_basis, chapter_uid) VALUES (?, 'e', 'scripting', ?, 'done', 0, 'calculated', ?)",
        )
        .run(`r${i}`, label, uid);

    rest();
    const labels = (table: string) =>
      (db.$client.query(`SELECT label FROM ${table} ORDER BY id`).all() as { label: string }[]).map(
        (r) => r.label,
      );
    expect(labels("jobs")).toEqual([
      "Narrate",
      "Re-script · DeepSeek · ch 9",
      "Retake",
      "Build M4B · 18 ch",
      "Script · ch 4b",
    ]);
    expect(labels("requests")).toEqual([
      "Script chunk 2",
      "Prompt trial · part 2/3",
      "Check",
      "Script chunk 1 · ch 7",
      "Check · A Chapter Since Removed",
    ]);
  });
});
