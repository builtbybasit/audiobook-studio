// Statements built once per handle and reused, for writes that repeat by the thousand (drizzle
// rebuilds and SQLite recompiles each query otherwise). A statement dies with its handle.
// `insertRows` fills columns as drizzle's insert would; a row with an SQL value falls back to it.
// Placeholders are wrapped in `sql` so drizzle's mapping doesn't run on them: it doesn't skip null
// (a null JSON column would become the text `null`). `eq` placeholders are unmapped too, so
// `prepared` suits text/integer keys, not JSON or boolean values.
import { getTableColumns, is, sql, SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db, Tx } from "~/db/client";

type Handle = Db | Tx;

const statements = new WeakMap<Handle, Map<unknown, unknown>>();

/** `build`'s statement on this handle, cached under `key` (usually the calling function). */
export function prepared<T>(db: Handle, key: unknown, build: (db: Handle) => T): T {
  let byKey = statements.get(db);
  if (!byKey) statements.set(db, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, build(db));
  return byKey.get(key) as T;
}

interface Insert {
  columns: [key: string, column: SQLiteColumn][];
  run: (values: Record<string, unknown>) => void;
}

const insertFor = (db: Handle, table: SQLiteTable): Insert =>
  prepared(db, table, () => {
    // generated columns are skipped, as drizzle's `shouldDisableInsert` (untyped) does
    const columns = Object.entries(getTableColumns(table)).filter(
      ([, column]) => !column.generated || column.generated.type === "byDefault",
    );
    const statement = db
      .insert(table)
      .values(Object.fromEntries(columns.map(([key]) => [key, sql.placeholder(key).getSQL()])))
      .prepare();
    return {
      columns,
      run: (values) => {
        statement.run(values);
      },
    };
  });

/** What drizzle's insert would fill this column with, before mapping. */
function filled(column: SQLiteColumn, given: unknown): unknown {
  if (given !== undefined) return given;
  if (column.default !== null && column.default !== undefined) return column.default;
  if (column.defaultFn !== undefined) return column.defaultFn();
  if (!column.default && column.onUpdateFn !== undefined) return column.onUpdateFn();
  return null;
}

/**
 * Same result as `db.insert(table).values(rows)`, much cheaper for many rows. Call inside a
 * transaction: each row is its own statement.
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
    // pass the filled row, so a `$defaultFn` is not called twice
    if (inline)
      db.insert(table)
        .values(raw as SQLiteInsertValue<T>)
        .run();
    else run(values);
  }
}
