// The database handle: SQLite through Bun's driver (a single-user library). Tests pass `:memory:`.
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { env } from "~/env";
import * as schema from "~/db/schema";

/** `$client` is the raw connection, for pragmas drizzle can't express. */
export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

/** The handle inside a transaction; queries like a `Db`, but cannot open another transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function openDb(url: string = env.DATABASE_URL): Db {
  if (url !== ":memory:") mkdirSync(dirname(url), { recursive: true });
  const sqlite = new Database(url, { create: true });
  // WAL so reads don't block a long import's writes; NORMAL is durable under WAL but for the
  // last commits on power loss, and skips a sync on every one
  if (url !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  return connect(sqlite);
}

/** These pragmas are per connection, not per file, so every connection needs them. */
export function connect(sqlite: Database): Db {
  sqlite.exec("PRAGMA foreign_keys = ON;");
  // a second connection (e.g. db:migrate while the server runs) waits instead of SQLITE_BUSY
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  return drizzle(sqlite, { schema });
}
