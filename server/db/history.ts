// A chapter's script history as rows. `planCapture` in `@/lib/scriptHistory` decides what an
// operation adds; this file writes it, always inside the transaction that writes the script.
import { and, asc, eq } from "drizzle-orm";

import type { ChapterHistory, HistoryHead, ScriptVersion, Segment, VersionOrigin } from "@/types";
import { planCapture, scriptSignature, sessionOpen, snapshotScript } from "@/lib/scriptHistory";
import type { Db, Tx } from "~/db/client";
import { scriptHeads, scriptVersions } from "~/db/schema";
import { scriptVersionValues, toChapterHistory } from "~/db/rows";

const emptyHead = (): HistoryHead => ({ at: 0, origin: { kind: "scripted" } });

/** The client's history plus the version the open editing session preserved, if any. */
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

export function readHistory(db: Db | Tx, bookId: string, chapterId: number): ChapterHistory {
  const { sessionVersion: _, ...history } = readStored(db, bookId, chapterId);
  return history;
}

/** `sessionVersion`: the version the open session's first edit preserved, else null. */
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

/** Preserve `current` before `origin` replaces it with `next`; the id added, or null. */
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
  // an edit that preserved a version opens a session on it; anything else closes the session
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
 * A hand edit. Edits within `SESSION_IDLE_MS` of each other join one session and one entry. A
 * session that returns to where it began drops the version its first edit added, so the list
 * never claims an edit that no longer exists. Only `session_version` is droppable: a checkpoint
 * saved mid-session is newer but is not the session's.
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

/** Name the script as it stands and keep a copy; the script itself does not change. */
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

/** Keep `segments` as a version beside the script, which stays as it is; returns its id. */
export function keepVersion(
  tx: Tx,
  bookId: string,
  chapterId: number,
  origin: VersionOrigin,
  segments: Segment[],
  now = Date.now(),
): number {
  const h = readStored(tx, bookId, chapterId);
  insertVersion(tx, bookId, chapterId, {
    id: h.nextId,
    at: now,
    origin,
    segments: snapshotScript(segments),
  });
  writeHead(tx, bookId, chapterId, h.head, h.nextId + 1, h.sessionVersion);
  return h.nextId;
}

/**
 * Version numbers are never reused. Dropping the checkpoint the head names reverts the head to
 * `was`, or (checkpoint over checkpoint, which keeps no `was`) the newest remaining checkpoint,
 * else "scripted".
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
