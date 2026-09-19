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

/** A chapter's history, or an empty one for a chapter nothing has happened to yet. */
export function readHistory(db: Db | Tx, bookId: string, chapterId: number): ChapterHistory {
  const head = db
    .select()
    .from(scriptHeads)
    .where(and(eq(scriptHeads.bookId, bookId), eq(scriptHeads.chapterId, chapterId)))
    .get();
  if (!head) return { versions: [], head: emptyHead(), nextId: 1 };
  const versions = db
    .select()
    .from(scriptVersions)
    .where(and(eq(scriptVersions.bookId, bookId), eq(scriptVersions.chapterId, chapterId)))
    .orderBy(asc(scriptVersions.id))
    .all();
  return toChapterHistory(head, versions);
}

function writeHead(
  tx: Tx,
  bookId: string,
  chapterId: number,
  head: HistoryHead,
  nextId: number,
): void {
  const values = {
    bookId,
    chapterId,
    at: head.at,
    origin: head.origin,
    open: head.open ?? null,
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
  writeHead(tx, bookId, chapterId, head, nextId);
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
 */
export function noteEdit(
  tx: Tx,
  bookId: string,
  chapterId: number,
  current: Segment[],
  next: Segment[],
  now = Date.now(),
): void {
  const h = readHistory(tx, bookId, chapterId);
  if (!sessionOpen(h.head, now) || h.head.origin.kind !== "edited") {
    capture(tx, bookId, chapterId, { kind: "edited", edits: 1 }, current, next, now);
    return;
  }
  const last = h.versions.at(-1);
  if (last && scriptSignature(last.segments) === scriptSignature(next)) {
    deleteVersionRow(tx, bookId, chapterId, last.id);
    writeHead(
      tx,
      bookId,
      chapterId,
      { at: last.at, origin: last.origin },
      h.nextId === last.id + 1 ? last.id : h.nextId,
    );
    return;
  }
  writeHead(
    tx,
    bookId,
    chapterId,
    { at: now, origin: { kind: "edited", edits: h.head.origin.edits + 1 }, open: true },
    h.nextId,
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
  writeHead(tx, bookId, chapterId, { at: now, origin }, h.nextId + 1);
  return version;
}

/**
 * Forget one version. Version numbers are never reused, so the ones after it keep theirs. When the
 * version was the checkpoint the head still names, the head goes back to how the script came to be
 * before it was named — what an Undo of a checkpoint asks for.
 */
export function dropVersion(
  tx: Tx,
  bookId: string,
  chapterId: number,
  id: number,
): ScriptVersion | null {
  const h = readHistory(tx, bookId, chapterId);
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
  writeHead(
    tx,
    bookId,
    chapterId,
    named ? { at: version.at, origin: named.was ?? { kind: "scripted" } } : head,
    h.nextId === id + 1 ? id : h.nextId,
  );
  return version;
}
