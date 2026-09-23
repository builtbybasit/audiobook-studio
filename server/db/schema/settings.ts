// Settings that belong to the installation rather than to a book.
//
// One row per key, holding JSON. A table per settings group would be a table per screen that grows
// a checkbox; this is the one place where a document really is the right shape, because nothing
// queries across settings — they are read whole, by name, by the screen that owns them.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Known keys.
 *
 *   script   `ScriptSettings` — the chosen profile, watermark stripping, keep-my-edits
 *   export     the export form's defaults, so a new build starts where the last one left off
 *   endpoints  `{ savedAt }` — that the endpoints were saved here at least once; see
 *              `endpointsSaved` in server/db/endpoints.ts
 */
export type SettingKey = "script" | "export" | "endpoints";

export const settings = sqliteTable("settings", {
  key: text("key").$type<SettingKey>().primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
