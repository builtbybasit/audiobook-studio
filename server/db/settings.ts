// The installation's settings, read and written by key (`~/db/schema/settings`).
//
// One helper per key rather than a generic getter, because the row holds JSON and each key's
// reader is where that JSON is held to its shape: a hand-edited or half-written row reads as the
// setting being absent, never as an object the app cannot use.
import { eq } from "drizzle-orm";

import type { PromptTemplate } from "@/types";
import type { Db, Tx } from "~/db/client";
import { settings } from "~/db/schema";

/** The library's default scripting prompt, or null when it is the built-in one. */
export function readLibraryPrompt(db: Db | Tx): PromptTemplate | null {
  const value = db.select().from(settings).where(eq(settings.key, "prompt")).get()?.value;
  if (typeof value !== "object" || value === null) return null;
  const { system, user } = value as Record<string, unknown>;
  return typeof system === "string" && typeof user === "string" ? { system, user } : null;
}

/** Keep this as the library's default; null goes back to the built-in one by removing the row. */
export function writeLibraryPrompt(db: Db | Tx, prompt: PromptTemplate | null): void {
  if (!prompt) {
    db.delete(settings).where(eq(settings.key, "prompt")).run();
    return;
  }
  const value = { system: prompt.system, user: prompt.user };
  db.insert(settings)
    .values({ key: "prompt", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
