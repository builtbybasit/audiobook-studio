// Schema creation, applied at startup and by the tests.
//
// Drizzle Kit generates SQL into `drizzle/` from `server/db/schema.ts`; this applies whatever is
// there to the database it is handed. Running it against an up-to-date database does nothing, so
// booting the server is always safe.
//
// **Foreign keys are off while it runs.** SQLite cannot alter most of a table in place, so a
// schema change drizzle-kit cannot express as `ALTER TABLE` is written as a rebuild: create
// `__new_chapters`, copy the rows across, `DROP TABLE chapters`, rename. With foreign keys on, that
// `DROP` deletes every row and fires every `ON DELETE CASCADE` pointing at the table — every
// script, clip, job and export row a book owns, gone on the next boot. The generated SQL does say
// `PRAGMA foreign_keys=OFF` before it, but drizzle runs all pending migrations inside one
// transaction, and inside a transaction SQLite ignores that pragma. So it is set here, on the
// connection, before drizzle begins — the procedure SQLite's own documentation gives for
// altering a table — and SQLite's `foreign_key_check` is asked afterwards whether every reference
// still lands, before the keys go back on and the server trusts the result.
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";

import type { Db } from "~/db/client";

interface Violation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

export function migrate(db: Db, folder = "./drizzle"): void {
  const sqlite = db.$client;
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  try {
    drizzleMigrate(db, { migrationsFolder: folder });
    const broken = sqlite.query("PRAGMA foreign_key_check;").all() as Violation[];
    if (broken.length) {
      const shown = broken
        .slice(0, 5)
        .map((v) => `${v.table} row ${v.rowid ?? "?"} → ${v.parent}`)
        .join("; ");
      throw new Error(
        `A migration left ${broken.length} row${broken.length === 1 ? "" : "s"} pointing at ` +
          `nothing (${shown}). The server has not started on it; restore the database from a ` +
          `backup, fix the migration, and start again.`,
      );
    }
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON;");
  }
}
