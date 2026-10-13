// What the library's voice effects do, as operations: the same arrangement as `server/cast/ops.ts`,
// a route turning a request into one of these and the rules living here.
import type { Effect, EffectUses, StaleSound, ThoughtChoice } from "@/types";
import type { EffectRunner } from "~/audio/effects";
import type { Db, Tx } from "~/db/client";
import * as effects from "~/db/effects";
import type { EffectBody } from "~/db/effects";
import { getBook } from "~/db/library";
import { readThoughts, writeThoughts } from "~/db/settings";
import { badRequest, notFound } from "~/lib/errors";
import { slugify } from "~/lib/http";

/** Whether a choice is "none" or an effect the library has. */
export const isEffectChoice = (db: Db | Tx, choice: string): boolean =>
  choice === "none" || effects.getEffect(db, choice) != null;

/**
 * Refuse a choice that names an effect the library does not have. Null (follow the next level) and
 * "none" name none, and pass.
 */
export function requireEffect(db: Db | Tx, choice: string | null | undefined, what: string): void {
  if (choice != null && !isEffectChoice(db, choice))
    throw badRequest(`${what}: there is no effect “${choice}”`);
}

export const listEffects = (db: Db): Effect[] => effects.listEffects(db);

export function createEffect(db: Db, body: EffectBody, after?: string): Effect {
  if (after !== undefined && !effects.getEffect(db, after))
    throw badRequest(`There is no effect “${after}” to put it after`);
  return effects.createEffect(db, slugify(body.name, "effect"), body, after);
}

export function effectUses(db: Db, id: string): EffectUses {
  if (!effects.getEffect(db, id)) throw notFound("No such effect");
  return effects.effectUses(db, id);
}

export function updateEffect(db: Db, id: string, body: EffectBody): Effect {
  const effect = effects.updateEffect(db, id, body);
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
