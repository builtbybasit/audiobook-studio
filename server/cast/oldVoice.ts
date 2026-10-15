// A speaker's finished lines read in a voice other than the one they get now, and re-narrating
// them. Re-voicing stales those clips with the run's jobs and narrates at `fill`, so the preview
// prices exactly what that run renders, missing lines in the same chapters included.
import type { Book, NarrationQueued, OldVoice, Segment, VoiceRef } from "@/types";
import { NARRATOR, speakerVoice } from "@/lib/cast";
import { narrationTargets } from "@/lib/runPlan";
import { isSpoken } from "@/lib/siteText";
import { chapterSpeakers, readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import * as library from "~/db/library";
import { readScript } from "~/db/script";
import { requireCharacter } from "~/cast/ops";
import { enqueueNarration, withStale } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { requireBook } from "~/library/ops";
import { narrationPricer } from "~/narration/cost";

/**
 * The voice a speaker's lines get now, when a change to `name`'s voice can move them: `name`'s own
 * lines, their voiceless personas', and for the Narrator everyone who falls back to them.
 */
function voiceThrough(db: Db, bookId: string, name: string) {
  const cast = new Map(readCast(db, bookId).map((c) => [c.name, c]));
  const cv = library.getBook(db, bookId)?.characterVoice;
  const memo = new Map<string, VoiceRef | null | undefined>();
  return (speaker: string): VoiceRef | null | undefined => {
    if (!memo.has(speaker)) {
      const v = speakerVoice(speaker, cast, cv);
      const via = v.of ? speakerVoice(v.of, cast, cv).from : v.from;
      const moves = speaker === name || v.of === name || (name === NARRATOR && via === "narrator");
      memo.set(speaker, moves ? v.ref : undefined);
    }
    return memo.get(speaker);
  };
}

interface OldLines {
  id: number;
  segs: Segment[];
  old: Set<number>;
}

/**
 * Kept chapters' spoken, done clips whose recorded voice is not the one now wanted. A clip with no
 * recorded voice can't be told apart, a line with no voice now can't be redone, and a line with a
 * retake waiting or in flight is the listener's: all three are left out.
 */
function oldLines(db: Db, book: Book, name: string, only?: readonly number[]): OldLines[] {
  const bookId = book.id;
  const asked = only && new Set(only);
  const wanted = voiceThrough(db, bookId, name);
  const out: OldLines[] = [];
  for (const [id, speakers] of chapterSpeakers(db, bookId)) {
    if ((asked && !asked.has(id)) || !speakers.some((s) => wanted(s) !== undefined)) continue;
    const segs = readScript(db, bookId, id);
    const old = new Set<number>();
    for (const s of segs) {
      const { status, voiceRef } = s.audio;
      if (status !== "done" || !voiceRef || s.candidate || !isSpoken(s, book)) continue;
      const now = wanted(s.speaker);
      if (now && now !== voiceRef) old.add(s.id);
    }
    if (old.size) out.push({ id, segs, old });
  }
  return out;
}

export function oldVoice(db: Db, bookId: string, name: string): OldVoice {
  const book = requireBook(db, bookId);
  requireCharacter(db, bookId, name);
  const priceOf = narrationPricer(db, bookId);
  const chapters = oldLines(db, book, name).map(({ id, segs, old }) => {
    const cost = priceOf(narrationTargets(withStale(segs, old), "fill", true, book).run);
    return { id, lines: old.size, cost: cost.priced ? cost.reserved : null };
  });
  const sum = (n: number, c: { cost: number | null }) => n + (c.cost ?? 0);
  return {
    lines: chapters.reduce((n, c) => n + c.lines, 0),
    cost: chapters.some((c) => c.cost == null) ? null : chapters.reduce(sum, 0),
    chapters,
  };
}

/** Chapters with no old-voice lines are skipped, as `enqueueNarration` skips any with nothing to do. */
export function revoice(
  db: Db,
  runner: Runner,
  bookId: string,
  name: string,
  chapters: readonly number[],
): NarrationQueued {
  const book = requireBook(db, bookId);
  requireCharacter(db, bookId, name);
  const stale = new Map(oldLines(db, book, name, chapters).map((c) => [c.id, c.old]));
  return enqueueNarration(db, runner, bookId, chapters, { scope: "fill", stale });
}
