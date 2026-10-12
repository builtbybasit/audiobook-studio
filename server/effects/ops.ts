// What the library's voice effects do, as operations: the same arrangement as `server/cast/ops.ts`,
// a route turning a request into one of these and the rules living here.
import type { Effect, EffectUses, StaleSound, Step, ThoughtChoice } from "@/types";
import type { EffectRunner } from "~/audio/effects";
import type { Db, Tx } from "~/db/client";
import * as effects from "~/db/effects";
import { getBook } from "~/db/library";
import { readThoughts, writeThoughts } from "~/db/settings";
import { badRequest, notFound } from "~/lib/errors";
import { slugify } from "~/lib/http";

/**
 * Refuse a choice that names an effect the library does not have. Null (follow the next level) and
 * "none" name none, and pass.
 */
export function requireEffect(db: Db | Tx, choice: string | null | undefined, what: string): void {
  if (choice == null || choice === "none") return;
  if (!effects.getEffect(db, choice)) throw badRequest(`${what}: there is no effect “${choice}”`);
}

export const listEffects = (db: Db): Effect[] => effects.listEffects(db);

export function createEffect(db: Db, name: string, chain: Step[], after?: string): Effect {
  if (after !== undefined && !effects.getEffect(db, after))
    throw badRequest(`There is no effect “${after}” to put it after`);
  return effects.createEffect(db, slugify(name, "effect"), name, chain, after);
}

export function effectUses(db: Db, id: string): EffectUses {
  if (!effects.getEffect(db, id)) throw notFound("No such effect");
  return effects.effectUses(db, id);
}

export function updateEffect(db: Db, id: string, name: string, chain: Step[]): Effect {
  const effect = effects.updateEffect(db, id, name, chain);
  if (!effect) throw notFound("No such effect");
  return effect;
}

export function deleteEffect(db: Db, id: string): void {
  if (!effects.deleteEffect(db, id)) throw notFound("No such effect");
}

/**
 * How many of a book's clips have an old sound, how many of those cannot be redone, and whether
 * `runner` can redo any here at all.
 */
export async function staleSound(
  db: Db,
  bookId: string,
  runner?: EffectRunner,
): Promise<StaleSound> {
  if (!getBook(db, bookId)) throw notFound("No such book");
  return { ...effects.staleSound(db, bookId), ready: (await runner?.available()) ?? false };
}

export const libraryThoughts = (db: Db): ThoughtChoice => readThoughts(db);

export function setLibraryThoughts(db: Db, choice: ThoughtChoice): ThoughtChoice {
  requireEffect(db, choice, "The library's thought effect");
  writeThoughts(db, choice);
  return choice;
}
