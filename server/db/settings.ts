// Settings by key. One helper per key because each reader validates its JSON: a malformed row
// reads as absent.
import { eq } from "drizzle-orm";

import type { PromptTemplate, ScriptSettings, ThoughtChoice } from "@/types";
import { makeScriptSettings } from "@/lib/scripting";
import type { Db, Tx } from "~/db/client";
import { effects, settings } from "~/db/schema";

/** Null means the built-in prompt. */
export function readLibraryPrompt(db: Db | Tx): PromptTemplate | null {
  const value = db.select().from(settings).where(eq(settings.key, "prompt")).get()?.value;
  if (typeof value !== "object" || value === null) return null;
  const { system, user } = value as Record<string, unknown>;
  return typeof system === "string" && typeof user === "string" ? { system, user } : null;
}

/** Null goes back to the built-in prompt by removing the row. */
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

/** A missing or malformed row reads as the defaults, with no profile. */
export function readScriptSettings(db: Db | Tx): ScriptSettings {
  const value = db.select().from(settings).where(eq(settings.key, "script")).get()?.value;
  const out = makeScriptSettings();
  if (typeof value !== "object" || value === null) return out;
  const { profile } = value as Record<string, unknown>;
  if (typeof profile === "string" && profile) out.profile = profile;
  return out;
}

export function writeScriptSettings(db: Db | Tx, script: ScriptSettings): void {
  const value = { profile: script.profile };
  db.insert(settings)
    .values({ key: "script", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/** An invalid row reads as the Inner voice, or "none" once that is gone. */
export function readThoughts(db: Db | Tx): ThoughtChoice {
  const value = db.select().from(settings).where(eq(settings.key, "thoughts")).get()?.value;
  if (value === "none") return value;
  const known = (id: unknown) =>
    typeof id === "string" &&
    !!db.select({ id: effects.id }).from(effects).where(eq(effects.id, id)).get();
  if (known(value)) return value as string;
  return known("inner-voice") ? "inner-voice" : "none";
}

export function writeThoughts(db: Db | Tx, value: ThoughtChoice): void {
  db.insert(settings)
    .values({ key: "thoughts", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}
