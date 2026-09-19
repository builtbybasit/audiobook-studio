// Every read and write a chapter's script history makes.
//
// The rule is the store's, applied here to rows: **the working script is preserved before
// anything replaces it**, labelled by whatever produced it, and never twice. `planCapture` in
// `@/lib/scriptHistory` decides what an operation adds; this file reads what the chapter holds,
// hands it to that rule, and writes the answer — always inside the transaction that writes the
// script, so a version and the script it preceded cannot disagree about which came first.
import { and, asc, eq } from "drizzle-orm";

import type { ChapterHistory, HistoryHead, ScriptVersion, Segment, VersionOrigin } from "@/types";
import { planCapture, scriptSignature, sessionOpen, snapshotScript } from "@/lib/scriptHistory";
import type { Db, Tx } from "~/db/client";
import { scriptHeads, scriptVersions } from "~/db/schema";
import { scriptVersionValues, toChapterHistory } from "~/db/rows";

const emptyHead = (): HistoryHead => ({ at: 0, origin: { kind: "scripted" } });

/**
 * A chapter's history as the client reads it, plus the one thing the server keeps for itself:
 * which version the open editing session preserved when it began, if it added one.
 */
interface StoredHistory extends ChapterHistory {
  sessionVersion: number | null;
}

function readStored(db: Db | Tx, bookId: string, chapterId: number): StoredHistory {
  const head = db
    .select()
    .from(scriptHeads)
    .where(and(eq(scriptHeads.bookId, bookId), eq(scriptHeads.chapterId, chapterId)))
    .get();
  if (!head) return { versions: [], head: emptyHead(), nextId: 1, sessionVersion: null };
  const versions = db
    .select()
    .from(scriptVersions)
    .where(and(eq(scriptVersions.bookId, bookId), eq(scriptVersions.chapterId, chapterId)))
    .orderBy(asc(scriptVersions.id))
    .all();
  return { ...toChapterHistory(head, versions), sessionVersion: head.sessionVersion ?? null };
}

/** A chapter's history, or an empty one for a chapter nothing has happened to yet. */
export function readHistory(db: Db | Tx, bookId: string, chapterId: number): ChapterHistory {
  const { sessionVersion: _, ...history } = readStored(db, bookId, chapterId);
  return history;
}

/**
 * Where the working script now stands. `sessionVersion` is the version the open session's first
 * edit preserved, and null for every head that is not an open session with a version of its own.
 */
function writeHead(
  tx: Tx,
  bookId: string,
  chapterId: number,
  head: HistoryHead,
  nextId: number,
  sessionVersion: number | null,
): void {
  const values = {
    bookId,
    chapterId,
    at: head.at,
    origin: head.origin,
    open: head.open ?? null,
    sessionVersion,
    nextId,
  };
  tx.insert(scriptHeads)
    .values(values)
    .onConflictDoUpdate({ target: [scriptHeads.bookId, scriptHeads.chapterId], set: values })
    .run();
}

function insertVersion(tx: Tx, bookId: string, chapterId: number, v: ScriptVersion): void {
  tx.insert(scriptVersions)
    .values(scriptVersionValues(bookId, chapterId, v))
    .run();
}

function deleteVersionRow(tx: Tx, bookId: string, chapterId: number, id: number): void {
  tx.delete(scriptVersions)
    .where(
      and(
        eq(scriptVersions.bookId, bookId),
        eq(scriptVersions.chapterId, chapterId),
        eq(scriptVersions.id, id),
      ),
    )
    .run();
}

/**
 * Preserve `current` before `origin` replaces it with `next`. Returns the id of the entry added,
 * or null when the rule added none.
 */
export function capture(
  tx: Tx,
  bookId: string,
  chapterId: number,
  origin: VersionOrigin,
  current: Segment[],
  next?: Segment[],
  now = Date.now(),
): number | null {
  const h = readHistory(tx, bookId, chapterId);
  const { added, head, nextId } = planCapture(h, current, origin, next, now);
  if (added) insertVersion(tx, bookId, chapterId, added);
  // an edit that preserved a version opens a session that version belongs to; anything else
  // closes whatever session there was
  writeHead(
    tx,
    bookId,
    chapterId,
    head,
    nextId,
    origin.kind === "edited" ? (added?.id ?? null) : null,
  );
  return added?.id ?? null;
}

/**
 * One line of the script changed by hand: `next` is about to replace `current`.
 *
 * The first edit after a quiet spell preserves the script and opens a session; every edit less
 * than `SESSION_IDLE_MS` after the last joins it and is counted into the same entry. A session
 * that comes back to exactly where it began — the edits were undone, one by one — leaves no entry:
 * the version its first edit added is dropped again and the head goes back to what it said before,
 * which is what that version recorded. The list must never claim an edit happened that no longer
 * exists.
 *
 * Only that version is the session's to drop. The head remembers which one it was
 * (`session_version`), because the newest version is not always it: a checkpoint saved after the
 * session opened is newer, and a session that then comes back to the checkpoint's script leaves
 * the checkpoint where it is. A session whose first edit preserved nothing — the script it
 * replaced was already the newest entry — has nothing to drop either.
 */
export function noteEdit(
  tx: Tx,
  bookId: string,
  chapterId: number,
  current: Segment[],
  next: Segment[],
  now = Date.now(),
): void {
  const h = readStored(tx, bookId, chapterId);
  if (!sessionOpen(h.head, now) || h.head.origin.kind !== "edited") {
    capture(tx, bookId, chapterId, { kind: "edited", edits: 1 }, current, next, now);
    return;
  }
  const preserved =
    h.sessionVersion == null ? undefined : h.versions.find((v) => v.id === h.sessionVersion);
  if (preserved && scriptSignature(preserved.segments) === scriptSignature(next)) {
    deleteVersionRow(tx, bookId, chapterId, preserved.id);
    writeHead(
      tx,
      bookId,
      chapterId,
      { at: preserved.at, origin: preserved.origin },
      h.nextId === preserved.id + 1 ? preserved.id : h.nextId,
      null,
    );
    return;
  }
  writeHead(
    tx,
    bookId,
    chapterId,
    { at: now, origin: { kind: "edited", edits: h.head.origin.edits + 1 }, open: true },
    h.nextId,
    h.sessionVersion,
  );
}

/**
 * Name the script as it stands and keep a copy of it. The script itself does not change: a
 * checkpoint is a place to come back to, and the name goes on the state the script is in, so the
 * entry still says how it got there.
 */
export function checkpoint(
  tx: Tx,
  bookId: string,
  chapterId: number,
  name: string,
  current: Segment[],
  now = Date.now(),
): ScriptVersion {
  const h = readHistory(tx, bookId, chapterId);
  const origin: VersionOrigin = {
    kind: "checkpoint",
    name,
    ...(h.head.origin.kind === "checkpoint" ? {} : { was: h.head.origin }),
  };
  const version: ScriptVersion = {
    id: h.nextId,
    at: now,
    origin,
    segments: snapshotScript(current),
  };
  insertVersion(tx, bookId, chapterId, version);
  writeHead(tx, bookId, chapterId, { at: now, origin }, h.nextId + 1, null);
  return version;
}

/**
 * Forget one version. Version numbers are never reused, so the ones after it keep theirs. When the
 * version was the checkpoint the head still names, the head goes back to how the script came to be
 * before it was named — what an Undo of a checkpoint asks for. A checkpoint saved over a checkpoint
 * does not record what it was saved over (`was`), because the answer is the earlier checkpoint
 * itself: the head goes back to the newest checkpoint still in the list, or to "scripted" when
 * there is none left.
 */
export function dropVersion(
  tx: Tx,
  bookId: string,
  chapterId: number,
  id: number,
): ScriptVersion | null {
  const h = readStored(tx, bookId, chapterId);
  const version = h.versions.find((v) => v.id === id);
  if (!version) return null;
  deleteVersionRow(tx, bookId, chapterId, id);
  const head = h.head;
  const named =
    head.origin.kind === "checkpoint" &&
    version.origin.kind === "checkpoint" &&
    head.origin.name === version.origin.name &&
    head.at === version.at
      ? version.origin
      : null;
  const before = (): HistoryHead => {
    if (named?.was) return { at: version.at, origin: named.was };
    const earlier = [...h.versions]
      .reverse()
      .find((v) => v.id !== id && v.origin.kind === "checkpoint");
    return earlier
      ? { at: earlier.at, origin: earlier.origin }
      : { at: version.at, origin: { kind: "scripted" } };
  };
  writeHead(
    tx,
    bookId,
    chapterId,
    named ? before() : head,
    h.nextId === id + 1 ? id : h.nextId,
    // the session's version is gone with it, or the session it belonged to is
    named || h.sessionVersion === id ? null : h.sessionVersion,
  );
  return version;
}
