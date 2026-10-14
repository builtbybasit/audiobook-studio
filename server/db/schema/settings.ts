// Installation-wide settings: one JSON row per key, read whole by the screen that owns it.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 *   script   `ScriptSettings`
 *   prompt   `PromptTemplate`; absent = the built-in one
 *   thoughts `ThoughtChoice`: an effect id or "none"
 */
export type SettingKey = "script" | "prompt" | "thoughts";

export const settings = sqliteTable("settings", {
  key: text("key").$type<SettingKey>().primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});
