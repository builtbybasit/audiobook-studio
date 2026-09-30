// Script edits answered as the server would answer them, and left unwritten.
//
// A store test that edits a chapter's script checks what the edit left on the page and what the
// store asked to write; with the write answered here rather than sent, the seeded demo is never
// changed, so it can be opened once and every test reads the same book. What that trades away is
// the server's side of the write — the revision check, the history entry it keeps, a clip left
// stale — which these tests no longer reach. That path is covered where it lives:
// `tests/jobsBackend.test.ts` ("editing a script with a server answering") sends the store's writes
// to a real server, and `tests/server/scriptEdit.test.ts` holds what the server keeps of one.
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
 * Answer the page's script edits without writing them. Call it after `demoServer()`: it wraps the
 * library service that set, so every other request still reaches the demo. An edit is accepted at
 * the next revision, with the chapter's history as the demo holds it, and recorded in `writes`; a
 * line's flag is accepted as sent, at the revision after the last one answered, and recorded in
 * `flags` — clear both in a `beforeEach`. With `lexicon`, a dictionary change is accepted as sent
 * too, with nothing staled or restored.
 */
export function unwrittenEdits(opts: { lexicon?: boolean } = {}): {
  writes: UnwrittenEdit[];
  flags: UnwrittenFlag[];
} {
  const writes: UnwrittenEdit[] = [];
  const flags: UnwrittenFlag[] = [];
  const real = libraryService();
  /** the revision last answered for each chapter, as the server would have moved it */
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
