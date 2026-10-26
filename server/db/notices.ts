// `recheck-notices`: runs the notice check again over books imported before it learned a rule.
// Only chapters with no note get one, so an earlier note and every skip or keep stay as they are.
import { and, asc, eq } from "drizzle-orm";

import type { ChapterNote } from "@/types";
import { openDb, type Db } from "~/db/client";
import { chapters, chapterTexts } from "~/db/schema";
import { detectNotices } from "~/epub/notices";

/** How many chapters gained a note. */
export function recheckNotices(db: Db): number {
  const rows = db
    .select({
      bookId: chapters.bookId,
      id: chapters.id,
      volumeId: chapters.volumeId,
      title: chapters.title,
      words: chapters.words,
      note: chapters.note,
      body: chapterTexts.body,
    })
    .from(chapters)
    .innerJoin(
      chapterTexts,
      and(eq(chapterTexts.bookId, chapters.bookId), eq(chapterTexts.chapterId, chapters.id)),
    )
    .orderBy(asc(chapters.bookId), asc(chapters.volumeId), asc(chapters.volumeIndex))
    .all();

  // A volume is judged on its own, as at import.
  const volumes = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.bookId}\n${r.volumeId}`;
    const volume = volumes.get(key);
    if (volume) volume.push(r);
    else volumes.set(key, [r]);
  }
  let added = 0;
  db.transaction((tx) => {
    for (const volume of volumes.values()) {
      const notes = detectNotices(
        volume.map((r) => ({
          title: r.title,
          text: r.body,
          words: r.words,
          href: "",
          ...((r.note as ChapterNote | null)?.kind === "unreadable" ? { unreadable: true } : {}),
        })),
      );
      volume.forEach((r, i) => {
        if (r.note || !notes[i]) return;
        tx.update(chapters)
          .set({ note: notes[i] })
          .where(and(eq(chapters.bookId, r.bookId), eq(chapters.id, r.id)))
          .run();
        added++;
      });
    }
  });
  return added;
}

if (import.meta.main) console.log(`${recheckNotices(openDb())} chapters gained a note`);
