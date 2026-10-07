// What a chapter's script does when a person edits it, as operations.
//
// A scripting job writes a script too, through the same `replaceScript` and the same history rule
// (`server/jobs/scripting.ts`); this file is the other writer, the one a person drives from the
// reader. Two rules hold across both:
//
//   * **An edit names the revision it read.** `ifRevision` is the revision the client last saw,
//     and an edit against a script that has moved since — a job landed, another tab wrote — is
//     refused with a 409 rather than written over it, exactly as a stale job result is.
//   * **History is written in the transaction that writes the script.** The working script is
//     preserved before the new one replaces it, labelled by what produced it, so a version and the
//     script it preceded cannot disagree about which came first.
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
}

/**
 * What an edit writes of the lines it was sent, given the lines they replace.
 *
 * A line whose type the edit changed has had its type decided by a person, so the detector's
 * suggestion it carried (`siteCheck`) goes, even when a copy of the line sent it back; one the
 * edit puts back where the line had none is an Undo writing back the line as it was, and stays.
 * A suggestion the edit left out of a line has been dismissed, and goes by being absent. The rest
 * is written as sent — the speaker too, so a line marked as site text and back keeps whoever
 * said it, and its clip, so marking it back as story costs no render.
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
 * Replace a chapter's script with what a person made of it.
 *
 * An edit joins the open editing session or opens one; a bulk correction and a restore each
 * preserve the script under their own name. Whatever the origin, a chapter that now has a script
 * reads as scripted — its status is asked of its script, never remembered — and an edit that would
 * leave it with no lines is refused, because a chapter with nothing in it cannot be narrated and
 * would have nothing left to undo from.
 *
 * A write that changes nothing a version keeps — a line flagged, a clip that finished, anything
 * about the audio, a suggestion dismissed — is still written, and moves the revision on, but leaves
 * the history alone: `scriptSignature` is what a version is, and a script with the same signature
 * is the same script, so there is no edit to count and no session to open.
 *
 * An edit that changes which lines are read aloud — a line marked as site text, or back as story —
 * settles the chapter's narration as a run would, since a line that is not read wants no clip and
 * one that is read again may be missing its own; unless a run holds the chapter, which settles it
 * when it ends.
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
 * Raise, replace or take down one line's flag, and write nothing else.
 *
 * A flag changes nothing a version keeps and nothing a run renders, so unlike an edit it names no
 * revision: a run landing clips in this chapter moves the revision on with every clip, and a flag
 * raised while it did was refused as an edit of a script that had moved. The revision still moves
 * on, as it does for every write of the script's rows, so a copy read before the flag is refused
 * rather than written back over it. The history is left alone, as `editScript` leaves it for a
 * write that changes no signature.
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

/** Forget one version of a chapter's history. What an Undo of a checkpoint sends. */
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

/**
 * What the history says replaced a script that was started over. A chapter with no script shows
 * no history, so this is never read as a label; the next run scripts the chapter afresh after it.
 */
const STARTED_OVER: VersionOrigin = { kind: "bulk", label: "Started over", lines: 0 };

/**
 * Take every script in the book away so it can be scripted afresh: each chapter reads as the
 * import left it, its clips are removed from disk, and with `cast` every speaker but the Narrator
 * leaves the cast. The text, the volumes, the contents decisions, the dictionary, the prompts, the
 * settings and the audiobooks already built all stay.
 *
 * Each script is kept in its chapter's history first, so a chapter scripted again that came out
 * worse can be restored — as text: the audio is not kept with a version, and its files are gone.
 *
 * Refused while any job of the book is queued or running: a run would write into a chapter this is
 * emptying, and a build reads the clips this removes.
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
    let speakers = 0;
    if (clearCast) {
      // the Narrator holds what the others leave behind, so they are there to hold it
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
