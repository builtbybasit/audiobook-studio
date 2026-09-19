// The database handle.
//
// SQLite through Bun's built-in driver: this is a personal, single-user library, and a file on
// disk is the whole deployment story. `openDb` is exported so a test can take a private
// `:memory:` database instead of sharing the real one.
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { env } from "~/env";
import * as schema from "~/db/schema";

export type Db = BunSQLiteDatabase<typeof schema>;

/**
 * The handle inside a transaction.
 *
 * It answers the same queries a `Db` does, which is what lets a helper be called from either. It is
 * a distinct type rather than the same one because the two differ in what they can start: a
 * transaction cannot open another.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function openDb(url: string = env.DATABASE_URL): Db {
  if (url !== ":memory:") mkdirSync(dirname(url), { recursive: true });
  const sqlite = new Database(url, { create: true });
  // Write-ahead logging keeps a read of the contents review from blocking an import that is
  // writing a few hundred chapters; foreign keys are off by default in SQLite and the cascade
  // from `books` is what makes removing a book remove everything it owns.
  if (url !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema });
}
