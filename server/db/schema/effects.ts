// The library's voice effects: named Pedalboard chains (`Effect`), shared by every book.
//
// Nothing points at an effect with a foreign key. A book or a speaker names one by id in a text
// column that also holds "none", so a delete resets those names itself, in the same transaction
// (`server/db/effects.ts`).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Step } from "@/types";

export const effects = sqliteTable("effects", {
  /** a slug of the name it was made with; kept when it is renamed */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  chain: text("chain", { mode: "json" }).$type<Step[]>().notNull(),
  /** the order the effects are listed in, and line effects are run in */
  position: integer("position"),
  /** `Effect.useWhen`: the sentence that offers it to the scripting model; null = not offered */
  useWhen: text("use_when"),
});
