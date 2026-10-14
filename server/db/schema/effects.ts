// The library's voice effects: named Pedalboard chains shared by every book. No FK points here
// (the columns also hold "none"); a delete resets references itself (server/db/effects.ts).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { Step } from "@/types";

export const effects = sqliteTable("effects", {
  /** a slug of the original name; kept on rename */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  chain: text("chain", { mode: "json" }).$type<Step[]>().notNull(),
  /** list order, and the order line effects run in */
  position: integer("position"),
  /** the sentence offering it to the scripting model; null = not offered */
  useWhen: text("use_when"),
});
