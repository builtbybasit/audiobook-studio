// `db:migrate`: apply migrations without starting the server (which also applies them at startup).
import { openDb } from "~/db/client";
import { migrate } from "~/db/migrate";
import { env } from "~/env";

migrate(openDb());
console.log(`migrations applied to ${env.DATABASE_URL}`);
