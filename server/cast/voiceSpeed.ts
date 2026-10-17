// A voice's speed change, across books: the lines of everyone who reads at that voice's speed. A
// sent speed leaves an old voice (`oldVoice`, re-narrated, priced); one made here leaves old sound
// (`staleClips`, Re-applied, free). The per-book rules are theirs; this only gathers them.

import type { Book, VoiceRef, VoiceSpeedBook, VoiceSpeedRedone } from "@/types";
import { speedFollowers } from "@/lib/cast";
import { oldVoice, revoice } from "~/cast/oldVoice";
import { readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import { cannotRedo, keepOldSound, staleClips } from "~/db/effects";
import * as library from "~/db/library";
import { enqueueReapply } from "~/jobs/effects";
import type { Runner } from "~/jobs/runner";
import { AppError } from "~/lib/errors";

/** Per book, who reads at `ref`'s speed: read in it, with no speed of their own. */
function readersOf(
  db: Db,
  ref: VoiceRef,
  only?: readonly string[],
): { book: Book; names: string[] }[] {
  const out: { book: Book; names: string[] }[] = [];
  for (const book of library.listBooks(db)) {
    if (book.importing || (only && !only.includes(book.id))) continue;
    const names = speedFollowers(ref, readCast(db, book.id), book.characterVoice);
    if (names.length) out.push({ book, names });
  }
  return out;
}

/** Books with any line at the old speed, in the library's order. */
export function voiceSpeedLines(db: Db, ref: VoiceRef): VoiceSpeedBook[] {
  const out: VoiceSpeedBook[] = [];
  for (const { book, names } of readersOf(db, ref)) {
    const sent = oldVoice(db, book.id, names);
    const stale = staleClips(db, book.id, { speakers: names });
    if (!sent.lines && !stale.length) continue;
    out.push({
      bookId: book.id,
      title: book.title,
      reNarrate: sent.lines,
      cost: sent.cost,
      reApply: stale.length,
      unavailable: stale.filter(cannotRedo).length,
    });
  }
  return out;
}

/**
 * Re-narrates the books' old-voice lines and Re-applies their old sound (when effects can run);
 * `only` = those books, absent = all. A refusal (paused, over budget, already re-applying) is said
 * and the rest go on.
 */
export function redoVoiceSpeed(
  db: Db,
  runner: Runner,
  ref: VoiceRef,
  canReapply: boolean,
  only?: readonly string[],
): VoiceSpeedRedone {
  const out: VoiceSpeedRedone = { books: [] };
  for (const { book, names } of readersOf(db, ref, only)) {
    const done: VoiceSpeedRedone["books"][number] = { bookId: book.id, jobs: 0, reapplied: false };
    const attempt = (act: () => void) => {
      try {
        act();
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        (done.refused ??= []).push(e.message);
      }
    };
    if (oldVoice(db, book.id, names).lines)
      attempt(() => {
        const queued = revoice(db, runner, book.id, names, library.chapterIds(db, book.id));
        done.jobs = queued.jobs.length;
        done.chapters = queued.chapters;
      });
    if (canReapply && staleClips(db, book.id, { speakers: names }).length)
      attempt(() => {
        enqueueReapply(db, runner, book.id, { speakers: names });
        done.reapplied = true;
      });
    if (done.jobs || done.reapplied || done.refused) out.books.push(done);
  }
  return out;
}

/** Books left out: their old-sound lines stop counting as old; old-voice ones are left as they are. */
export function keepVoiceSpeed(db: Db, ref: VoiceRef, only?: readonly string[]): number {
  let kept = 0;
  for (const { book, names } of readersOf(db, ref, only))
    kept += keepOldSound(db, book.id, { speakers: names });
  return kept;
}
