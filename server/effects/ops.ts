// Voice effect operations; the rules live here, routes only translate requests.
import type { Effect, EffectUses, ExistingScope, StaleSound, ThoughtChoice } from "@/types";
import type { EffectRunner } from "~/audio/effects";
import type { Db, Tx } from "~/db/client";
import * as effects from "~/db/effects";
import type { EffectBody } from "~/db/effects";
import { getBook } from "~/db/library";
import { readThoughts, writeThoughts } from "~/db/settings";
import { badRequest, notFound } from "~/lib/errors";
import { slugify } from "~/lib/http";

export const isEffectChoice = (db: Db | Tx, choice: string): boolean =>
  choice === "none" || effects.getEffect(db, choice) != null;

/** Refuses an effect the library lacks; null (follow the next level) and "none" pass. */
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

/** The lines it was stripped from, with their chapters' new revisions. */
export function deleteEffect(db: Db, id: string): effects.BookLines[] {
  const lines = effects.deleteEffect(db, id);
  if (!lines) throw notFound("No such effect");
  return lines;
}

export async function staleSound(
  db: Db,
  bookId: string,
  scope: ExistingScope,
  runner?: EffectRunner,
): Promise<StaleSound> {
  if (!getBook(db, bookId)) throw notFound("No such book");
  return { ...effects.staleSound(db, bookId, scope), ready: (await runner?.available()) ?? false };
}

export function keepOldSound(db: Db, bookId: string, scope: ExistingScope): number {
  if (!getBook(db, bookId)) throw notFound("No such book");
  return effects.keepOldSound(db, bookId, scope);
}

export const libraryThoughts = (db: Db): ThoughtChoice => readThoughts(db);

export function setLibraryThoughts(db: Db, choice: ThoughtChoice): ThoughtChoice {
  requireEffect(db, choice, "The library's thought effect");
  writeThoughts(db, choice);
  return choice;
}
