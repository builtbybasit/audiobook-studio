// Statements compiled once and run many times: the writes that repeat by the thousand.
//
// A drizzle query builds its SQL afresh every time it runs — walking every column of every row it
// was given — and SQLite compiles each text it is handed again. For one query that is nothing; for
// a chapter's script, an import of hundreds of chapters, or the demo's thirteen thousand rows,
// building and compiling was most of the time the write took, not the writing. The two here build
// a statement once per handle and keep it: `prepared` for a query written with placeholders, and
// `insertRows` for many rows into one table.
//
// **A statement belongs to the handle it was built on.** A transaction's handle is gone when it
// commits, and its statements with it; those a `Db` holds live as long as the database does.
//
// **`insertRows` sends drizzle's own values.** Each column is filled the way drizzle's insert fills
// it: the value given, through the column's `mapToDriverValue` (a null stays null — it is not sent
// through a JSON or boolean column's mapping); for a key left out, the column's default, its
// `$defaultFn` or its `$onUpdateFn`, and null when it has none. A value or default that is SQL
// rather than data belongs in the statement's text, so a row carrying one goes to drizzle's own
// insert.
//
// **Its placeholders are wrapped in SQL on purpose.** A bare `sql.placeholder` given to `values()`
// is sent through the column's mapping when the statement runs — and that mapping does not skip
// null, so a null JSON column would be written as the text `null` and a null boolean as 0. Wrapped,
// the placeholder reaches SQLite as it is, and the mapping above is the only one applied. A
// placeholder compared with `eq` is not mapped either, which is why `prepared` suits a key — text
// and integers, which no mapping changes — and not a JSON or boolean value.
import { getTableColumns, is, sql, SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db, Tx } from "~/db/client";

type Handle = Db | Tx;

const statements = new WeakMap<Handle, Map<unknown, unknown>>();

/**
 * The statement `build` makes on this handle, made the first time it is asked for and kept, under
 * `key`, for every later call on the same handle. `key` is anything that names the query for good
 * — the function that runs it, usually.
 */
export function prepared<T>(db: Handle, key: unknown, build: (db: Handle) => T): T {
  let byKey = statements.get(db);
  if (!byKey) statements.set(db, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, build(db));
  return byKey.get(key) as T;
}

/** A table's insert: the columns it writes, and one row's statement. */
interface Insert {
  columns: [key: string, column: SQLiteColumn][];
  run: (values: Record<string, unknown>) => void;
}

const insertFor = (db: Handle, table: SQLiteTable): Insert =>
  prepared(db, table, () => {
    // a generated column is written by SQLite, never by an insert, and drizzle leaves it out — the
    // test its insert makes (`shouldDisableInsert`, which its types keep to itself)
    const columns = Object.entries(getTableColumns(table)).filter(
      ([, column]) => !column.generated || column.generated.type === "byDefault",
    );
    const statement = db
      .insert(table)
      .values(Object.fromEntries(columns.map(([key]) => [key, sql.placeholder(key).getSQL()])))
      .prepare();
    return { columns, run: (values) => void statement.run(values) };
  });

/** What drizzle's insert would fill this column with, before the column's mapping. */
function filled(column: SQLiteColumn, given: unknown): unknown {
  if (given !== undefined) return given;
  if (column.default !== null && column.default !== undefined) return column.default;
  if (column.defaultFn !== undefined) return column.defaultFn();
  if (!column.default && column.onUpdateFn !== undefined) return column.onUpdateFn();
  return null;
}

/**
 * Insert `rows` into `table`, in order, as `db.insert(table).values(rows)` would — the same rows,
 * the same values, the same ids handed out — at a fraction of the cost when there are many. Call it
 * inside a transaction: each row is its own statement, and only a transaction makes them one write.
 */
export function insertRows<T extends SQLiteTable>(
  db: Handle,
  table: T,
  rows: readonly SQLiteInsertValue<T>[],
): void {
  if (!rows.length) return;
  const { columns, run } = insertFor(db, table);
  for (const row of rows) {
    const given = row as Record<string, unknown>;
    const raw: Record<string, unknown> = {};
    const values: Record<string, unknown> = {};
    let inline = false;
    for (const [key, column] of columns) {
      const value = (raw[key] = filled(column, given[key]));
      const sent = value === null || is(value, SQL) ? value : column.mapToDriverValue(value);
      if (is(sent, SQL)) inline = true;
      values[key] = sent;
    }
    // handed the row as filled here, so a default's function is not asked a second time
    if (inline)
      db.insert(table)
        .values(raw as SQLiteInsertValue<T>)
        .run();
    else run(values);
  }
}
