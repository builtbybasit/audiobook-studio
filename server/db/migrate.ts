// Applies the generated migrations in `drizzle/`; a no-op on an up-to-date database.
// Foreign keys go off on the connection first: a table rebuild's `DROP TABLE` would otherwise fire
// every ON DELETE CASCADE, and the migration's own `PRAGMA foreign_keys=OFF` is ignored inside
// drizzle's transaction. `foreign_key_check` then confirms every reference still lands.
// See https://www.sqlite.org/lang_altertable.html#otheralter
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
