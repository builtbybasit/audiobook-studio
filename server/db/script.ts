// Every read and write a chapter's script makes. A script is written whole, and each write moves
// the chapter's `scriptRevision`, so a job that read an older revision cannot overwrite newer work.
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import type {
  ChapterLines,
  HeardLine,
  RevisedLines,
  Segment,
  SegmentAudio,
  SegmentFlag,
  Take,
} from "@/types";
import { snapshotTake } from "@/lib/takes";
import { chapterAt, clipFiles } from "~/db/library";
import { insertRows, prepared } from "~/db/prepared";
import type { Db, Tx } from "~/db/client";
import { chapters, clips, effects, heard, segments } from "~/db/schema";
import {
  clipValues,
  segmentClipValues,
  segmentValues,
  toHeardLine,
  toSegment,
  toSegmentAudio,
} from "~/db/rows";
import { AppError } from "~/lib/errors";

/** Keeps an `IN (...)` under SQLite's parameter limit; a chapter is hundreds of lines. */
const CHUNK = 100;
const chunked = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

export function lineCount(db: Db | Tx, bookId: string, chapterId: number): number {
  return (
    db
      .select({ n: count() })
      .from(segments)
      .where(and(eq(segments.bookId, bookId), eq(segments.chapterId, chapterId)))
      .get()?.n ?? 0
  );
}

export function readScript(db: Db | Tx, bookId: string, chapterId: number): Segment[] {
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
  return segRows.map((s) => toSegment(s, bySegment.get(s.id) ?? []));
}

/** The clip row at this url, with its line's speaker; read by `~/audio/demoClips`. */
export function clipByUrl(
  db: Db | Tx,
  bookId: string,
  url: string,
): { speaker: string; duration: number; rate: number | null } | undefined {
  return db
    .select({ speaker: segments.speaker, duration: clips.duration, rate: clips.sampleRate })
    .from(clips)
    .innerJoin(
      segments,
      and(
        eq(segments.bookId, clips.bookId),
        eq(segments.chapterId, clips.chapterId),
        eq(segments.id, clips.segmentId),
      ),
    )
    .where(and(eq(clips.bookId, bookId), eq(clips.url, url)))
    .get();
}

type At = { bookId: string; chapterId: number };
const atBook = sql.placeholder("bookId");
const atChapter = sql.placeholder("chapterId");
/** `prepared` keys for `replaceScript`'s statements. */
const dropScript = Symbol("drop a chapter's script");
const moveRevision = Symbol("move a chapter's revision");

/** Null when there is no such chapter. */
export function scriptRevision(db: Db | Tx, bookId: string, chapterId: number): number | null {
  const query = prepared(db, scriptRevision, (h) =>
    h
      .select({ revision: chapters.scriptRevision })
      .from(chapters)
      .where(and(eq(chapters.bookId, atBook), eq(chapters.id, atChapter)))
      .prepare(),
  );
  return query.get({ bookId, chapterId } satisfies At)?.revision ?? null;
}

export class ScriptConflict extends Error {
  override readonly name = "ScriptConflict";
  constructor(
    readonly expected: number,
    readonly found: number | null,
  ) {
    super(
      found == null
        ? "The chapter no longer exists, so its script was not written"
        : "The chapter's script changed while this ran, so the result was not written over it",
    );
  }
}

/** A deleted effect must not come back through an old copy of a script (a stale tab, history, a file). */
function knownEffects(tx: Tx, segs: readonly Segment[]): readonly Segment[] {
  if (!segs.some((s) => s.effects?.length)) return segs;
  const known = new Set(
    tx
      .select({ id: effects.id })
      .from(effects)
      .all()
      .map((e) => e.id),
  );
  return segs.map((s) =>
    s.effects?.some((id) => !known.has(id))
      ? { ...s, effects: s.effects.filter((id) => known.has(id)) }
      : s,
  );
}

/**
 * Replace a chapter's script inside the caller's transaction, and move its revision. When the
 * chapter has moved past `ifRevision`, nothing is written and a `ScriptConflict` is thrown.
 */
export function replaceScript(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
  { ifRevision }: { ifRevision?: number } = {},
): { revision: number } {
  const current = scriptRevision(tx, bookId, chapterId);
  if (current == null) throw new ScriptConflict(ifRevision ?? 0, null);
  if (ifRevision != null && current !== ifRevision) throw new ScriptConflict(ifRevision, current);
  segs = knownEffects(tx, segs);

  // prepared once: the demo seed writes ~300 chapters in one transaction
  const at: At = { bookId, chapterId };
  // clips cascade from their segment
  prepared(tx, dropScript, (h) =>
    h
      .delete(segments)
      .where(and(eq(segments.bookId, atBook), eq(segments.chapterId, atChapter)))
      .prepare(),
  ).run(at);
  insertRows(
    tx,
    segments,
    segs.map((s, i) => segmentValues(bookId, chapterId, s, i)),
  );
  insertRows(
    tx,
    clips,
    segs.flatMap((s) => segmentClipValues(bookId, chapterId, s)),
  );

  prepared(tx, moveRevision, (h) =>
    h
      .update(chapters)
      .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
      .where(and(eq(chapters.bookId, atBook), eq(chapters.id, atChapter)))
      .prepare(),
  ).run(at);
  return { revision: current + 1 };
}

/** `replaceScript` in a transaction of its own. */
export function writeScript(
  db: Db,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
  options: { ifRevision?: number } = {},
): { revision: number } {
  return db.transaction((tx) => replaceScript(tx, bookId, chapterId, segs, options));
}

// ---------- clips, one line at a time ----------
// Each writes one clip row and leaves the segment row and the line's other clips alone.

/** At most one row: the index only lets takes repeat. */
function roleWhere(
  bookId: string,
  chapterId: number,
  segmentId: number,
  role: "current" | "candidate",
) {
  return and(
    eq(clips.bookId, bookId),
    eq(clips.chapterId, chapterId),
    eq(clips.segmentId, segmentId),
    eq(clips.role, role),
  );
}

/** A line an edit removed while a clip was rendering for it. */
export class LineGone extends AppError {
  constructor(segmentId: number) {
    super(404, `Line ${segmentId} is no longer in the script`);
  }
}

function requireSegment(tx: Tx, bookId: string, chapterId: number, segmentId: number): void {
  const found = tx
    .select({ id: segments.id })
    .from(segments)
    .where(
      and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        eq(segments.id, segmentId),
      ),
    )
    .get();
  if (!found) throw new LineGone(segmentId);
}

/**
 * Put `clip` in one line's `current` or `candidate` slot, replacing whatever was there. The takes
 * are untouched. A line gone from the script throws `LineGone`.
 */
export function writeClip(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
  role: "current" | "candidate",
  clip: SegmentAudio,
): void {
  requireSegment(tx, bookId, chapterId, segmentId);
  tx.delete(clips)
    .where(roleWhere(bookId, chapterId, segmentId, role))
    .run();
  // `takes` on the clip are the line's take rows, not columns of this row
  const { takes: _takes, ...own } = clip;
  tx.insert(clips)
    .values(clipValues(bookId, chapterId, segmentId, role, own))
    .run();
}

export function addTake(tx: Tx, bookId: string, chapterId: number, segmentId: number, take: Take) {
  requireSegment(tx, bookId, chapterId, segmentId);
  tx.insert(clips)
    .values(clipValues(bookId, chapterId, segmentId, "take", take))
    .run();
}

/** Drop a line's retake in any state; true when there was one. */
export function dropCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): boolean {
  return (
    tx
      .delete(clips)
      .where(roleWhere(bookId, chapterId, segmentId, "candidate"))
      .returning({ id: clips.id })
      .all().length > 0
  );
}

/** Freeze a clip as a take: `snapshotTake`, plus the files, which the store never had. */
export function takeOf(a: SegmentAudio): Take {
  return { ...snapshotTake(a), ...(a.url ? { url: a.url } : {}), ...(a.raw ? { raw: a.raw } : {}) };
}

/**
 * Turn a line's retake down. One that rendered joins the takes marked rejected, so it stays
 * playable and its number is never reused; one with no audio just goes. Returns the take, if any.
 */
export function rejectCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): Take | null {
  const row = tx
    .select()
    .from(clips)
    .where(roleWhere(bookId, chapterId, segmentId, "candidate"))
    .get();
  if (!row) return null;
  tx.delete(clips).where(eq(clips.id, row.id)).run();
  if (row.duration <= 0) return null;
  const take: Take = { ...takeOf(toSegmentAudio(row)), rejected: true };
  addTake(tx, bookId, chapterId, segmentId, take);
  return take;
}

/**
 * The retake becomes the line's current clip with `auto` stripped; the clip it displaces joins
 * the takes when it had audio.
 */
export function acceptCandidate(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): void {
  const rows = tx
    .select()
    .from(clips)
    .where(
      and(eq(clips.bookId, bookId), eq(clips.chapterId, chapterId), eq(clips.segmentId, segmentId)),
    )
    .all();
  const candidate = rows.find((r) => r.role === "candidate");
  if (!candidate || candidate.duration <= 0) return;
  const current = rows.find((r) => r.role === "current");
  if (current) {
    tx.delete(clips).where(eq(clips.id, current.id)).run();
    if (current.duration > 0)
      addTake(tx, bookId, chapterId, segmentId, takeOf(toSegmentAudio(current)));
  }
  tx.update(clips).set({ role: "current", auto: null }).where(eq(clips.id, candidate.id)).run();
}

export function clearFlag(tx: Tx, bookId: string, chapterId: number, segmentId: number): void {
  setFlag(tx, bookId, chapterId, segmentId, null);
}

/** `null` takes the flag down; false when the line is not in the script. */
export function setFlag(
  tx: Db | Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
  flag: SegmentFlag | null,
): boolean {
  return !!tx
    .update(segments)
    .set({ flag })
    .where(
      and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        eq(segments.id, segmentId),
      ),
    )
    .returning({ id: segments.id })
    .get();
}

/** One line's words, flag and current clip url, for a transcription; undefined when gone. */
export function lineNow(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  segmentId: number,
): { text: string; flag: SegmentFlag | null; url: string | null } | undefined {
  return db
    .select({ text: segments.text, flag: segments.flag, url: clips.url })
    .from(segments)
    .leftJoin(
      clips,
      and(
        eq(clips.bookId, segments.bookId),
        eq(clips.chapterId, segments.chapterId),
        eq(clips.segmentId, segments.id),
        eq(clips.role, "current"),
      ),
    )
    .where(
      and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        eq(segments.id, segmentId),
      ),
    )
    .get();
}

/**
 * Move a chapter's script revision on by one and return it. Every transaction that writes clips
 * calls this once: a client writes the script back whole, so an edit from a copy read before a
 * clip landed must get a 409 rather than overwrite the clip.
 */
export function bumpRevision(tx: Tx, bookId: string, chapterId: number): number {
  const revision = tx
    .update(chapters)
    .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
    .where(chapterAt(bookId, chapterId))
    .returning({ revision: chapters.scriptRevision })
    .get()?.revision;
  if (revision == null) throw new ScriptConflict(0, null);
  return revision;
}

// ---------- the same words elsewhere in the book ----------

// One fold for both sides of the comparison: `foldLine` in JS, `foldedText` in SQLite, whose
// `lower` and `trim` only know ASCII. So only ASCII is lower-cased, and only these are spaces.
const SPACES = ["\t", "\n", "\r", "\u00a0", "\u2009", "\u202f", "\u3000"];
const SPACE_RUN = new RegExp(`[ ${SPACES.join("")}]+`, "g");

/** Whitespace runs as one space, trimmed, ASCII lower-cased. */
export const foldLine = (text: string): string =>
  text
    .replace(SPACE_RUN, " ")
    .replace(/^ | $/g, "")
    .replace(/[A-Z]+/g, (s) => s.toLowerCase());

function foldedText() {
  let e = sql`lower(${segments.text})`;
  for (const c of SPACES) e = sql`replace(${e}, ${c}, ' ')`;
  // a run of spaces as one: each becomes \1\2, then every \2\1 inside a run goes
  e = sql`replace(replace(replace(${e}, ' ', char(1, 2)), char(2, 1), ''), char(1, 2), ' ')`;
  return sql`trim(${e}, ' ')`;
}

/** Lines in the book's other chapters that `foldLine` to one of `folded`, for the site-text detector. */
export function linesElsewhere(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  folded: readonly string[],
): { chapterId: number; text: string }[] {
  if (!folded.length) return [];
  return db
    .select({ chapterId: segments.chapterId, text: segments.text })
    .from(segments)
    .where(
      and(
        eq(segments.bookId, bookId),
        ne(segments.chapterId, chapterId),
        sql`${foldedText()} in (select value from json_each(${JSON.stringify(folded)}))`,
      ),
    )
    .all();
}

// ---------- lines by speaker ----------

/**
 * Give every line `from` reads to `to` (a rename or merge). Returns the moved lines by chapter so
 * an Undo can put exactly those back.
 */
export function reattribute(
  tx: Tx,
  bookId: string,
  from: string,
  to: string,
  alike: ReadsAlike,
): RevisedLines[] {
  const rows = tx
    .select({ chapterId: segments.chapterId, id: segments.id })
    .from(segments)
    .where(and(eq(segments.bookId, bookId), eq(segments.speaker, from)))
    .orderBy(asc(segments.chapterId), asc(segments.position))
    .all();
  const byChapter = new Map<number, number[]>();
  for (const r of rows) byChapter.set(r.chapterId, [...(byChapter.get(r.chapterId) ?? []), r.id]);
  const moved = [...byChapter].map(([chapterId, ids]) => ({ chapterId, ids }));
  return attributeLines(tx, bookId, moved, to, alike);
}

/** Whether a line moved from one speaker to another keeps its clip (`sameReading`). */
export type ReadsAlike = (from: string, to: string) => boolean;

/**
 * Put `speaker` on exactly these lines; missing lines are skipped, not refused. Each touched
 * chapter's revision moves, so an in-flight job cannot land over it. A done clip goes stale
 * unless its old speaker and `speaker` read alike.
 */
export function attributeLines(
  tx: Tx,
  bookId: string,
  lines: readonly ChapterLines[],
  speaker: string,
  alike: ReadsAlike,
): RevisedLines[] {
  const moved: RevisedLines[] = [];
  for (const { chapterId, ids } of lines) {
    let changed = 0;
    for (const part of chunked(ids)) {
      const where = and(
        eq(segments.bookId, bookId),
        eq(segments.chapterId, chapterId),
        inArray(segments.id, part),
      );
      const was = tx
        .select({ id: segments.id, speaker: segments.speaker })
        .from(segments)
        .where(where)
        .all();
      if (!was.length) continue;
      tx.update(segments).set({ speaker }).where(where).run();
      changed += was.length;
      const respoken = was.filter((s) => !alike(s.speaker, speaker)).map((s) => s.id);
      if (respoken.length)
        tx.update(clips)
          .set({ status: "stale" })
          .where(
            and(
              eq(clips.bookId, bookId),
              eq(clips.chapterId, chapterId),
              inArray(clips.segmentId, respoken),
              eq(clips.role, "current"),
              eq(clips.status, "done"),
            ),
          )
          .run();
    }
    if (!changed) continue;
    const revision = tx
      .update(chapters)
      .set({ scriptRevision: sql`${chapters.scriptRevision} + 1` })
      .where(chapterAt(bookId, chapterId))
      .returning({ revision: chapters.scriptRevision })
      .get()?.revision;
    if (revision != null) moved.push({ chapterId, ids, revision });
  }
  return moved;
}

/**
 * Current clips done and failed per endpoint id, across every book, for the Queue's pool. Polled,
 * so read from the `clips_endpoint` index alone.
 */
export function clipsByEndpoint(db: Db | Tx): Map<string, { done: number; failed: number }> {
  const rows = db
    .select({
      endpoint: clips.endpoint,
      done: sql<number>`sum(case when ${clips.status} = 'done' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${clips.status} = 'failed' then 1 else 0 end)`,
    })
    .from(clips)
    .where(and(eq(clips.role, "current"), sql`${clips.endpoint} is not null`))
    .groupBy(clips.endpoint)
    .all();
  return new Map(
    rows.map((r) => [r.endpoint!, { done: Number(r.done), failed: Number(r.failed) }]),
  );
}

// ---------- what a transcription heard ----------
// Keyed by clip file, not row: every script save rewrites the rows (`heard` in the schema).

/** By file; a file never heard is absent. */
export function readHeard(
  db: Db | Tx,
  bookId: string,
  files: readonly string[],
): Map<string, HeardLine> {
  const out = new Map<string, HeardLine>();
  for (const part of chunked(files))
    for (const row of db
      .select()
      .from(heard)
      .where(and(eq(heard.bookId, bookId), inArray(heard.file, part)))
      .all())
      out.set(row.file, toHeardLine(row));
  return out;
}

export function writeHeard(
  db: Db | Tx,
  bookId: string,
  file: string,
  line: HeardLine,
  endpoint: string,
): void {
  const values = { ...line, endpoint };
  db.insert(heard)
    .values({ bookId, file, ...values })
    .onConflictDoUpdate({ target: [heard.bookId, heard.file], set: values })
    .run();
}

// ---------- the whole book ----------

/**
 * Drop every script in the book, leaving each chapter as an import left it, and return every clip
 * file name for the caller to remove. Revisions move on, so a stale write cannot land; what was
 * heard goes too. Text, cast, history and audiobooks are kept.
 */
export function dropBookScripts(tx: Tx, bookId: string): string[] {
  const files = tx
    .select({ url: clips.url, raw: clips.raw })
    .from(clips)
    .where(eq(clips.bookId, bookId))
    .all()
    .flatMap(clipFiles);
  // clips cascade from their segment
  tx.delete(segments).where(eq(segments.bookId, bookId)).run();
  tx.delete(heard).where(eq(heard.bookId, bookId)).run();
  tx.update(chapters)
    .set({
      scripting: "none",
      scriptingProgress: 0,
      narration: "none",
      narrationProgress: 0,
      duration: 0,
      recap: null,
      scriptRevision: sql`${chapters.scriptRevision} + 1`,
    })
    .where(eq(chapters.bookId, bookId))
    .run();
  return files;
}
