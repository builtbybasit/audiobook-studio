// Applies the migrations in `drizzle/`; a file database with some pending is copied first.
// Foreign keys go off on the connection: a table rebuild's `DROP TABLE` would otherwise fire every
// ON DELETE CASCADE, and the migration's own `PRAGMA foreign_keys=OFF` is ignored inside drizzle's
// transaction. `foreign_key_check` then confirms every reference still lands.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import type { Db } from "~/db/client";

interface Violation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

/** Snapshots kept per database; the oldest goes when another is taken. */
const KEPT_BACKUPS = 3;

/** A copy of a file database with migrations pending, taken before they run; else null. */
function backUp(db: Db, folder: string): string | null {
  const sqlite = db.$client;
  const file = sqlite.filename;
  if (!file || file === ":memory:") return null;
  // drizzle's own rule: a migration runs when it is newer than the last one applied
  const applied = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get()
    ? (sqlite.query("SELECT max(created_at) AS at FROM __drizzle_migrations").get() as {
        at: number | null;
      })
    : null;
  // a database never migrated holds nothing to keep
  if (!applied) return null;
  const last = Number(applied.at ?? 0);
  if (!readMigrationFiles({ migrationsFolder: folder }).some((m) => m.folderMillis > last))
    return null;

  const dir = join(dirname(file), "backups");
  const ext = extname(file);
  const name = basename(file, ext);
  mkdirSync(dir, { recursive: true });
  // ISO time sorts as it reads, so the listing below is oldest first
  const copy = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`);
  sqlite.query("VACUUM INTO ?").run(copy);
  const ours = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith(ext))
    .sort();
  for (const old of ours.slice(0, -KEPT_BACKUPS)) rmSync(join(dir, old), { force: true });
  return copy;
}

export function migrate(db: Db, folder = "./drizzle"): void {
  const sqlite = db.$client;
  const backup = backUp(db, folder);
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
          `nothing (${shown}). The server has not started on it; restore the database from ` +
          (backup ? `${backup} (taken just before)` : "a backup") +
          `, fix the migration, and start again.`,
      );
    }
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON;");
  }
}
