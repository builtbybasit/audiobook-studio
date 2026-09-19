// Writing a whole world into the schema, and reading it back out.
//
// This exists for one question — does the schema actually hold the domain — and the seeded world is
// the reference answer, because it is the same data every screen in the app is built against. It is
// test support rather than product code: nothing in the server imports the demo world, and the
// backend has no feature that would.
import { and, asc, eq } from "drizzle-orm";

import type {
  Book,
  Chapter,
  Character,
  ChapterHistory,
  Endpoint,
  ExportItem,
  Job,
  LexEntry,
  Profile,
  Promotion,
  RateWindow,
  RequestRecord,
  Segment,
} from "@/types";
import type { Credential } from "@/lib/credentials";
import type { Db } from "~/db/client";
import * as rows from "~/db/rows";
import {
  books,
  chapters,
  characters,
  clips,
  credentials,
  endpoints,
  exportChapters,
  exportFiles,
  exportItems,
  expressionTags,
  jobEvents,
  jobs,
  lexiconEntries,
  promotions,
  rateWindows,
  requests,
  scriptHeads,
  scriptVersions,
  segments,
  voices,
  volumes,
} from "~/db/schema";

const CHUNK = 150;
function insertAll<T>(write: (part: T[]) => void, values: readonly T[]): void {
  for (let i = 0; i < values.length; i += CHUNK) write(values.slice(i, i + CHUNK));
}

// ---------- writing ----------

export function writeBook(db: Db, book: Book, chs: readonly Chapter[], addedAt = Date.now()): void {
  db.insert(books).values(rows.bookValues(book, addedAt)).run();
  book.volumes.forEach((v, i) =>
    db
      .insert(volumes)
      .values(rows.volumeValues(book.id, v, i))
      .run(),
  );
  insertAll(
    (part) => db.insert(chapters).values(part).run(),
    chs.map((c) => rows.chapterValues(book.id, c)),
  );
}

export function writeCast(db: Db, bookId: string, cast: readonly Character[]): void {
  if (!cast.length) return;
  insertAll(
    (part) => db.insert(characters).values(part).run(),
    cast.map((c, i) => rows.characterValues(bookId, c, i)),
  );
}

export function writeLexicon(db: Db, bookId: string, entries: readonly LexEntry[]): void {
  if (!entries.length) return;
  insertAll(
    (part) => db.insert(lexiconEntries).values(part).run(),
    entries.map((e, i) => rows.lexiconValues(bookId, e, i)),
  );
}

export function writeScript(
  db: Db,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
): void {
  if (!segs.length) return;
  insertAll(
    (part) => db.insert(segments).values(part).run(),
    segs.map((s, i) => rows.segmentValues(bookId, chapterId, s, i)),
  );
  const clipRows = segs.flatMap((s) => rows.segmentClipValues(bookId, chapterId, s));
  insertAll((part) => db.insert(clips).values(part).run(), clipRows);
}

export function writeHistory(
  db: Db,
  bookId: string,
  chapterId: number,
  history: ChapterHistory,
): void {
  db.insert(scriptHeads)
    .values(rows.scriptHeadValues(bookId, chapterId, history))
    .run();
  for (const v of history.versions)
    db.insert(scriptVersions)
      .values(rows.scriptVersionValues(bookId, chapterId, v))
      .run();
}

/**
 * The credential registry.
 *
 * Endpoints point at it by id, so it has to exist before any of them do. Names only — the secret
 * itself is not in this schema.
 */
export function writeCredentials(db: Db, registry: readonly Credential[]): void {
  for (const c of registry)
    db.insert(credentials).values({ id: c.id, label: c.label, note: c.note }).run();
}

/** An endpoint and everything hanging off it: voices, the schedule, promotions, expression tags. */
export function writeEndpoint(db: Db, e: Endpoint, position: number): void {
  db.insert(endpoints).values(rows.endpointValues(e, position)).run();
  e.voices.forEach((v, i) =>
    db
      .insert(voices)
      .values(rows.voiceValues(e.id, v, i))
      .run(),
  );
  writeCard(db, e.id, e.pricing?.windows ?? [], e.pricing?.promotions ?? []);
  (e.expressions?.tags ?? []).forEach((t, i) =>
    db
      .insert(expressionTags)
      .values(rows.expressionTagValues(e.id, t, i))
      .run(),
  );
}

export function writeProfile(db: Db, p: Profile, position: number): void {
  db.insert(endpoints).values(rows.profileValues(p, position)).run();
  writeCard(db, p.id, p.pricing?.windows ?? [], p.pricing?.promotions ?? []);
}

/** The rate card's rows. Shared, because a speech rate goes on discount exactly as a token rate does. */
function writeCard(
  db: Db,
  endpointId: string,
  windows: readonly RateWindow[],
  promos: readonly Promotion[],
): void {
  windows.forEach((w, i) =>
    db
      .insert(rateWindows)
      .values(rows.rateWindowValues(endpointId, w, i))
      .run(),
  );
  promos.forEach((p, i) =>
    db
      .insert(promotions)
      .values(rows.promotionValues(endpointId, p, i))
      .run(),
  );
}

export function writeExport(db: Db, e: ExportItem, createdAt = Date.now()): void {
  db.insert(exportItems).values(rows.exportValues(e, createdAt)).run();
  e.files.forEach((f, i) =>
    db
      .insert(exportFiles)
      .values(rows.exportFileValues(e.id, f, i))
      .run(),
  );
  const chapterRows = rows.exportChapterValues(e);
  if (chapterRows.length)
    insertAll((part) => db.insert(exportChapters).values(part).run(), chapterRows);
}

export function writeJob(db: Db, job: Job): void {
  db.insert(jobs).values(rows.jobValues(job)).run();
  for (const e of job.activity ?? [])
    db.insert(jobEvents).values(rows.jobEventValues(job.id, e)).run();
}

/**
 * Append one request to the ledger.
 *
 * The chapter is stored by its own id rather than by its number, so the lookup here is the same one
 * a repository would do: the caller knows which chapter number the work was for, and the row keeps
 * the identity that survives a renumbering.
 */
export function writeRequest(db: Db, r: RequestRecord): void {
  const uid =
    r.bookId && r.chapterId != null
      ? (db
          .select({ uid: chapters.uid })
          .from(chapters)
          .where(and(eq(chapters.bookId, r.bookId), eq(chapters.id, r.chapterId)))
          .get()?.uid ?? null)
      : null;
  db.insert(requests).values(rows.requestValues(r, uid)).run();
}

// ---------- reading ----------

export function readChapters(db: Db, bookId: string): Chapter[] {
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map(rows.toChapter);
}

export function readCast(db: Db, bookId: string): Character[] {
  return db
    .select()
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .orderBy(asc(characters.position))
    .all()
    .map(rows.toCharacter);
}

export function readLexicon(db: Db, bookId: string): LexEntry[] {
  return db
    .select()
    .from(lexiconEntries)
    .where(eq(lexiconEntries.bookId, bookId))
    .orderBy(asc(lexiconEntries.position))
    .all()
    .map(rows.toLexEntry);
}

export function readScript(db: Db, bookId: string, chapterId: number): Segment[] {
  const where = (t: typeof segments | typeof clips) =>
    and(eq(t.bookId, bookId), eq(t.chapterId, chapterId));
  const segRows = db
    .select()
    .from(segments)
    .where(where(segments))
    .orderBy(asc(segments.position))
    .all();
  const clipRows = db.select().from(clips).where(where(clips)).all();
  const bySegment = new Map<number, (typeof clipRows)[number][]>();
  for (const c of clipRows) {
    const list = bySegment.get(c.segmentId) ?? [];
    list.push(c);
    bySegment.set(c.segmentId, list);
  }
  return segRows.map((s) => rows.toSegment(s, bySegment.get(s.id) ?? []));
}

export function readHistory(db: Db, bookId: string, chapterId: number): ChapterHistory | null {
  const head = db
    .select()
    .from(scriptHeads)
    .where(and(eq(scriptHeads.bookId, bookId), eq(scriptHeads.chapterId, chapterId)))
    .get();
  if (!head) return null;
  const versions = db
    .select()
    .from(scriptVersions)
    .where(and(eq(scriptVersions.bookId, bookId), eq(scriptVersions.chapterId, chapterId)))
    .all();
  return rows.toChapterHistory(head, versions);
}

function partsOf(db: Db, endpointId: string): rows.EndpointParts {
  return {
    voices: db.select().from(voices).where(eq(voices.endpointId, endpointId)).all(),
    windows: db.select().from(rateWindows).where(eq(rateWindows.endpointId, endpointId)).all(),
    promotions: db.select().from(promotions).where(eq(promotions.endpointId, endpointId)).all(),
    tags: db.select().from(expressionTags).where(eq(expressionTags.endpointId, endpointId)).all(),
  };
}

export function readEndpoints(db: Db): Endpoint[] {
  return db
    .select()
    .from(endpoints)
    .where(eq(endpoints.kind, "tts"))
    .orderBy(asc(endpoints.position))
    .all()
    .map((row) => rows.toEndpoint(row, partsOf(db, row.id)));
}

export function readProfiles(db: Db): Profile[] {
  return db
    .select()
    .from(endpoints)
    .where(eq(endpoints.kind, "scripting"))
    .orderBy(asc(endpoints.position))
    .all()
    .map((row) => rows.toProfile(row, partsOf(db, row.id)));
}

export function readExport(db: Db, id: number): ExportItem | null {
  const row = db.select().from(exportItems).where(eq(exportItems.id, id)).get();
  if (!row) return null;
  return rows.toExportItem(
    row,
    db.select().from(exportFiles).where(eq(exportFiles.exportId, id)).all(),
    db.select().from(exportChapters).where(eq(exportChapters.exportId, id)).all(),
  );
}

export function readJob(db: Db, id: number): Job | null {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) return null;
  return rows.toJob(row, db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).all());
}

/** The ledger, with each row's chapter resolved to the number that chapter goes by now. */
export function readRequests(db: Db): RequestRecord[] {
  return db
    .select()
    .from(requests)
    .leftJoin(chapters, eq(requests.chapterUid, chapters.uid))
    .all()
    .map((r) => rows.toRequestRecord(r.requests, r.chapters?.id ?? null));
}
