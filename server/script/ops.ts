// A person's edits to a chapter's script (the other writer is `server/jobs/scripting.ts`). An edit
// names the revision it read (`ifRevision`) and is refused with a 409 if the script moved; history
// is written in the same transaction as the script.
import type {
  Book,
  ChapterHistory,
  ChapterScript,
  EditedScript,
  FlagKind,
  Flagged,
  ScriptVersion,
  Segment,
  SegmentFlag,
  StartedOver,
  VersionOrigin,
} from "@/types";
import { NARRATOR } from "@/lib/cast";
import { plural } from "@/lib/contents";
import { scriptSignature } from "@/lib/scriptHistory";
import { isSpoken } from "@/lib/siteText";

import type { AudioFiles } from "~/audio/files";
import * as cast from "~/db/cast";
import type { Db } from "~/db/client";
import { clearBookFacts } from "~/db/facts";
import * as history from "~/db/history";
import * as queue from "~/db/jobs";
import * as library from "~/db/library";
import {
  ScriptConflict,
  bumpRevision,
  dropBookScripts,
  readScript,
  replaceScript,
  scriptRevision,
  setFlag,
} from "~/db/script";
import { discardSpeakerSamples } from "~/db/speakerSamples";
import { inBackground } from "~/lib/background";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { bookWithChapters, requireBook } from "~/library/ops";
import { narrationInProgress, settleChapter } from "~/narration/chapter";

function requireRevision(db: Db, bookId: string, chapterId: number): number {
  const revision = scriptRevision(db, bookId, chapterId);
  if (revision == null) throw notFound("No such chapter");
  return revision;
}

/** A chapter's script as it stands, and the revision a later write has to name. */
export function chapterScript(db: Db, bookId: string, chapterId: number): ChapterScript {
  const revision = requireRevision(db, bookId, chapterId);
  return { segments: readScript(db, bookId, chapterId), revision };
}

/** Several chapters' scripts at once, by id; a chapter the book does not have is left out. */
export function chapterScripts(
  db: Db,
  bookId: string,
  chapterIds: readonly number[],
): Record<number, ChapterScript> {
  requireBook(db, bookId);
  const scripts: Record<number, ChapterScript> = {};
  for (const id of chapterIds) {
    const revision = scriptRevision(db, bookId, id);
    if (revision != null) scripts[id] = { segments: readScript(db, bookId, id), revision };
  }
  return scripts;
}

export function chapterHistory(db: Db, bookId: string, chapterId: number): ChapterHistory {
  requireRevision(db, bookId, chapterId);
  return history.readHistory(db, bookId, chapterId);
}

export interface EditInput {
  segments: Segment[];
  /** the revision the client read before it changed anything */
  ifRevision: number;
  /** what produced this script; an ordinary edit when left out */
  origin?: VersionOrigin;
  /** the chapter's recap (`{{previous.recap}}` for the next), written with the script */
  recap?: string;
}

/**
 * The lines an edit writes. A line whose type a person changed loses the `siteCheck` suggestion it
 * still carried; one added where there was none is an Undo and stays. All else is written as sent.
 */
function asEdited(segments: readonly Segment[], current: readonly Segment[]): Segment[] {
  const was = new Map(current.map((s) => [s.id, s]));
  return segments.map((s) => {
    const before = was.get(s.id);
    const decided =
      !!s.siteCheck &&
      !!before &&
      before.type !== s.type &&
      JSON.stringify(before.siteCheck) === JSON.stringify(s.siteCheck);
    if (!decided) return s;
    const { siteCheck: _decided, ...rest } = s;
    return rest;
  });
}

/** Whether two scripts disagree on which of their lines are read aloud. */
function spokenMoved(
  from: readonly Segment[],
  to: readonly Segment[],
  book: Pick<Book, "readNotes"> | undefined,
): boolean {
  const heard = (segs: readonly Segment[]) =>
    segs
      .filter((s) => isSpoken(s, book))
      .map((s) => s.id)
      .join(",");
  return heard(from) !== heard(to);
}

/**
 * Replace a chapter's script with a person's edit; an empty script is refused. A write with the
 * same `scriptSignature` moves the revision but leaves history alone. Changing which lines are
 * spoken settles narration, unless a run holds the chapter (it settles at the end).
 */
export function editScript(
  db: Db,
  bookId: string,
  chapterId: number,
  input: EditInput,
): EditedScript {
  requireRevision(db, bookId, chapterId);
  if (!input.segments.length) throw badRequest("A script needs at least one line");
  const ids = new Set<number>();
  for (const s of input.segments) {
    if (ids.has(s.id)) throw badRequest(`Line ${s.id} appears twice`);
    ids.add(s.id);
  }
  const origin = input.origin ?? { kind: "edited", edits: 1 };
  try {
    return db.transaction((tx) => {
      const current = readScript(tx, bookId, chapterId);
      const segments = asEdited(input.segments, current);
      const changesScript = scriptSignature(current) !== scriptSignature(segments);
      if (!changesScript) {
        // nothing for the history to say
      } else if (origin.kind === "edited")
        history.noteEdit(tx, bookId, chapterId, current, segments);
      else history.capture(tx, bookId, chapterId, origin, current, segments);
      const { revision } = replaceScript(tx, bookId, chapterId, segments, {
        ifRevision: input.ifRevision,
      });
      if (input.recap !== undefined)
        library.setChapterRecap(tx, bookId, chapterId, input.recap || null);
      const chapter = library.getChapter(tx, bookId, chapterId);
      const status = chapter?.scripting;
      if (status !== "done" && status !== "fallback")
        library.setChapterScripting(tx, bookId, chapterId, "done", 100);
      if (
        chapter &&
        chapter.narration !== "none" &&
        !narrationInProgress(tx, bookId, chapterId) &&
        spokenMoved(current, segments, library.getBook(tx, bookId))
      )
        settleChapter(tx, bookId, chapterId);
      return {
        segments: readScript(tx, bookId, chapterId),
        revision,
        history: history.readHistory(tx, bookId, chapterId),
      };
    });
  } catch (e) {
    if (e instanceof ScriptConflict)
      throw conflict(
        "The script changed since it was read, so this edit was not written",
        "Reload the chapter and make the change again.",
      );
    throw e;
  }
}

/**
 * Raise, replace or take down one line's flag. Names no revision (a run moves it with every clip)
 * but still bumps it, so a copy read before the flag can't be written back over it.
 */
export function flagLine(
  db: Db,
  bookId: string,
  chapterId: number,
  segmentId: number,
  flag: { kind: FlagKind; note: string } | null,
): Flagged {
  requireRevision(db, bookId, chapterId);
  const written: SegmentFlag | null = flag
    ? { kind: flag.kind, note: flag.note.trim(), at: Date.now() }
    : null;
  return db.transaction((tx) => {
    if (!setFlag(tx, bookId, chapterId, segmentId, written))
      throw notFound(`Line ${segmentId} is not in this chapter's script`);
    return { flag: written, revision: bumpRevision(tx, bookId, chapterId) };
  });
}

/** Name the script as it stands and keep a copy. The script itself is untouched. */
export function saveCheckpoint(
  db: Db,
  bookId: string,
  chapterId: number,
  name: string,
): { version: ScriptVersion; history: ChapterHistory } {
  requireRevision(db, bookId, chapterId);
  const title = name.trim();
  if (!title) throw badRequest("A checkpoint needs a name");
  return db.transaction((tx) => {
    const current = readScript(tx, bookId, chapterId);
    if (!current.length) throw conflict("This chapter has no script to checkpoint");
    const version = history.checkpoint(tx, bookId, chapterId, title, current);
    return { version, history: history.readHistory(tx, bookId, chapterId) };
  });
}

/** Forget one version of a chapter's history (an Undo of a checkpoint). */
export function dropVersion(
  db: Db,
  bookId: string,
  chapterId: number,
  versionId: number,
): ChapterHistory {
  requireRevision(db, bookId, chapterId);
  return db.transaction((tx) => {
    if (!history.dropVersion(tx, bookId, chapterId, versionId))
      throw notFound(`This chapter has no v${versionId}`);
    return history.readHistory(tx, bookId, chapterId);
  });
}

// ---------- starting the whole book over ----------

/** History origin for a started-over script; never shown (an unscripted chapter has no history). */
const STARTED_OVER: VersionOrigin = { kind: "bulk", label: "Started over", lines: 0 };

/**
 * Drop every script and clip in the book, and the facts read from them (and with `cast`, every
 * speaker but the Narrator); text, settings, profiles and built audiobooks stay. Scripts are kept in history first (text only). Refused while
 * any job of the book is queued or running.
 */
export function startOver(
  db: Db,
  bookId: string,
  { cast: clearCast = false }: { cast?: boolean } = {},
  files?: AudioFiles,
): StartedOver {
  const book = requireBook(db, bookId);
  const live = queue
    .listJobs(db, { bookId })
    .filter((j) => j.status === "queued" || j.status === "running").length;
  if (live)
    throw conflict(
      `${plural(live, "job")} of “${book.title}” ${live === 1 ? "is" : "are"} still queued or running`,
      "Let them finish, or cancel them from the Queue, before starting over.",
    );
  const done = db.transaction((tx) => {
    let scripts = 0;
    for (const ch of library.listChapters(tx, bookId)) {
      const current = readScript(tx, bookId, ch.id);
      if (!current.length) continue;
      history.capture(tx, bookId, ch.id, STARTED_OVER, current, []);
      scripts++;
    }
    const gone = dropBookScripts(tx, bookId);
    clearBookFacts(tx, bookId);
    let speakers = 0;
    if (clearCast) {
      // the Narrator inherits the removed speakers' lines
      cast.ensureSpeakers(tx, bookId, [NARRATOR]);
      for (const c of cast.readCast(tx, bookId)) {
        if (c.name === NARRATOR) continue;
        discardSpeakerSamples(tx, bookId, c.name, NARRATOR);
        cast.deleteCharacterRow(tx, bookId, c.name);
        speakers++;
      }
    }
    return { scripts, gone, speakers };
  });
  inBackground(files?.remove(bookId, done.gone), "could not remove a book's clips", {
    book: bookId,
  });
  return {
    ...bookWithChapters(db, bookId),
    cleared: { scripts: done.scripts, clips: done.gone.length, speakers: done.speakers },
  };
}
