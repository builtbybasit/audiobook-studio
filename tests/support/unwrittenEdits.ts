// Script edits answered as the server would, and left unwritten, so the seeded demo opens once and
// every test reads the same book. The server's side of an edit is covered by
// `tests/jobsBackend.test.ts` and `tests/server/scriptEdit.test.ts`.
import {
  libraryService,
  setLibraryService,
  type LibraryService,
  type ScriptEdit,
} from "@/services/library";
import type { FlagKind, LexEntry } from "@/types";

/** One write the store asked for, in the order it asked. */
export interface UnwrittenEdit {
  bookId: string;
  chId: number;
  edit: ScriptEdit;
}

/** One line's flag the store asked to write, or to take down (`flag: null`). */
export interface UnwrittenFlag {
  bookId: string;
  chId: number;
  segId: number;
  flag: { kind: FlagKind; note: string } | null;
}

/**
 * Call after `demoServer()`; other requests still reach the demo. Edits are accepted at the next
 * revision and recorded in `writes`, flags as sent in `flags` (clear both in `beforeEach`). With
 * `lexicon`, dictionary changes are accepted too, staling nothing.
 */
export function unwrittenEdits(opts: { lexicon?: boolean } = {}): {
  writes: UnwrittenEdit[];
  flags: UnwrittenFlag[];
} {
  const writes: UnwrittenEdit[] = [];
  const flags: UnwrittenFlag[] = [];
  const real = libraryService();
  /** the revision last answered per chapter */
  const revisions = new Map<string, number>();
  const fake: Partial<LibraryService> = {
    editScript: async (bookId, chId, edit) => {
      writes.push({ bookId, chId, edit });
      revisions.set(`${bookId}:${chId}`, edit.ifRevision + 1);
      return {
        segments: edit.segments,
        revision: edit.ifRevision + 1,
        history: await real.chapterHistory(bookId, chId),
      };
    },
    flagLine: async (bookId, chId, segId, flag) => {
      flags.push({ bookId, chId, segId, flag });
      const k = `${bookId}:${chId}`;
      const revision = (revisions.get(k) ?? (await real.chapterScript(bookId, chId)).revision) + 1;
      revisions.set(k, revision);
      return {
        flag: flag && { kind: flag.kind, note: flag.note.trim(), at: Date.now() },
        revision,
      };
    },
  };
  if (opts.lexicon)
    fake.putLexicon = async (_bookId: string, entries: LexEntry[]) => ({
      entries,
      stale: [],
      restored: [],
    });
  setLibraryService(Object.assign(Object.create(real) as LibraryService, fake));
  return { writes, flags };
}
