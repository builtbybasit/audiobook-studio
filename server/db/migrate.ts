// Schema creation, applied at startup and by the tests.
//
// Drizzle Kit generates SQL into `drizzle/` from `server/db/schema.ts`; this applies whatever is
// there to the database it is handed. Running it against an up-to-date database does nothing, so
// booting the server is always safe.
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Db } from "~/db/client";

export function migrate(db: Db, folder = "./drizzle"): void {
  drizzleMigrate(db, { migrationsFolder: folder });
}
