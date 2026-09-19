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
import type { ChapterHistory, ScriptVersion, Segment, VersionOrigin } from "@/types";
import { scriptSignature } from "@/lib/scriptHistory";
import { and, eq } from "drizzle-orm";

import type { Db } from "~/db/client";
import * as history from "~/db/history";
import { chapters } from "~/db/schema";
import { ScriptConflict, readScript, replaceScript, scriptRevision } from "~/db/script";
import { badRequest, conflict, notFound } from "~/lib/errors";

export interface ChapterScript {
  segments: Segment[];
  revision: number;
}

export interface Edited extends ChapterScript {
  history: ChapterHistory;
}

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
 * Replace a chapter's script with what a person made of it.
 *
 * An edit joins the open editing session or opens one; a bulk correction and a restore each
 * preserve the script under their own name. Whatever the origin, a chapter that now has a script
 * reads as scripted — its status is asked of its script, never remembered — and an edit that would
 * leave it with no lines is refused, because a chapter with nothing in it cannot be narrated and
 * would have nothing left to undo from.
 *
 * A write that changes nothing a version keeps — a line flagged, a clip that finished, anything
 * about the audio — is still written, and moves the revision on, but leaves the history alone:
 * `scriptSignature` is what a version is, and a script with the same signature is the same script,
 * so there is no edit to count and no session to open.
 */
export function editScript(db: Db, bookId: string, chapterId: number, input: EditInput): Edited {
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
      const changesScript = scriptSignature(current) !== scriptSignature(input.segments);
      if (!changesScript) {
        // nothing for the history to say
      } else if (origin.kind === "edited")
        history.noteEdit(tx, bookId, chapterId, current, input.segments);
      else history.capture(tx, bookId, chapterId, origin, current, input.segments);
      const { revision } = replaceScript(tx, bookId, chapterId, input.segments, {
        ifRevision: input.ifRevision,
      });
      const status = tx
        .select({ scripting: chapters.scripting })
        .from(chapters)
        .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
        .get()?.scripting;
      if (status !== "done" && status !== "fallback")
        tx.update(chapters)
          .set({ scripting: "done", scriptingProgress: 100 })
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
          .run();
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
