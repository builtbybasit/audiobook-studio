// `pnpm db:migrate` — apply the generated migrations to the configured database.
//
// The server does this at startup too; this is for applying a schema change without starting it.
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { env } from "~/env";

migrate(openDb());
console.log(`migrations applied to ${env.DATABASE_URL}`);
