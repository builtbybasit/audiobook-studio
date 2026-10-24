// Segments, their clips and a chapter's script history. Current clip, retake and takes share one
// table split by `role`. A `Take` is a strict subset of `SegmentAudio`, so reading one back must
// stop at a take's fields or it round-trips with an extra `status`.
import type {
  ChapterHistory,
  HeardLine,
  Segment,
  SegmentAudio,
  ScriptVersion,
  Take,
} from "@/types";
import type { ClipRole } from "~/db/schema";
import type { clips, heard, scriptHeads, scriptVersions, segments } from "~/db/schema";

type SegmentRow = typeof segments.$inferSelect;
type ClipRow = typeof clips.$inferSelect;
type VersionRow = typeof scriptVersions.$inferSelect;
type HeadRow = typeof scriptHeads.$inferSelect;

/** Fields both `SegmentAudio` and `Take` carry. */
function auditOf(row: ClipRow): Partial<Take> {
  return {
    ...(row.voiceRef != null ? { voiceRef: row.voiceRef } : {}),
    ...(row.voice != null ? { voice: row.voice } : {}),
    ...(row.model != null ? { model: row.model } : {}),
    ...(row.direction != null ? { direction: row.direction } : {}),
    ...(row.style != null ? { style: row.style } : {}),
    ...(row.instructions != null ? { instructions: row.instructions } : {}),
    ...(row.type != null ? { type: row.type } : {}),
    ...(row.text != null ? { text: row.text } : {}),
    ...(row.said != null ? { said: row.said } : {}),
    ...(row.pronounced != null ? { pronounced: row.pronounced } : {}),
    ...(row.expressionSignature != null ? { expressionSignature: row.expressionSignature } : {}),
    ...(row.expressions != null ? { expressions: row.expressions } : {}),
    ...(row.sampleRate != null ? { sampleRate: row.sampleRate } : {}),
    ...(row.speed != null ? { speed: row.speed } : {}),
    ...(row.sound != null ? { sound: row.sound } : {}),
    ...(row.raw != null ? { raw: row.raw } : {}),
    ...(row.cost != null ? { cost: row.cost } : {}),
    ...(row.charge != null ? { charge: row.charge } : {}),
  };
}

/** The clip the chapter plays, or a retake waiting beside it. */
export function toSegmentAudio(row: ClipRow, takes: readonly ClipRow[] = []): SegmentAudio {
  const a: SegmentAudio = {
    status: row.status,
    endpoint: row.endpoint ?? null,
    ms: row.ms,
    duration: row.duration,
    ...auditOf(row),
  };
  if (row.url != null) a.url = row.url;
  if (row.startedAt != null) a.startedAt = row.startedAt;
  if (row.at != null) a.at = row.at;
  if (row.lex != null) a.lex = row.lex;
  if (row.parts != null) a.parts = row.parts;
  if (row.splitAt != null) a.splitAt = row.splitAt;
  if (row.cuts != null) a.cuts = row.cuts;
  if (row.auto) a.auto = true;
  if (row.n != null) a.n = row.n;
  if (row.error != null) a.error = row.error;
  if (takes.length) a.takes = takes.map(toTake);
  return a;
}

/** A superseded clip; deliberately narrower than `SegmentAudio`. */
export function toTake(row: ClipRow): Take {
  const t: Take = {
    n: row.n ?? 1,
    at: row.at ?? 0,
    ms: row.ms,
    duration: row.duration,
    endpoint: row.endpoint ?? null,
    ...auditOf(row),
  };
  if (row.url != null) t.url = row.url;
  if (row.rejected) t.rejected = true;
  return t;
}

/** One clip, flattened; `role` tells the three kinds apart. */
export function clipValues(
  bookId: string,
  chapterId: number,
  segmentId: number,
  role: ClipRole,
  clip: SegmentAudio | Take,
): Omit<typeof clips.$inferInsert, "id"> {
  const full = clip as Partial<SegmentAudio> & Take;
  return {
    bookId,
    chapterId,
    segmentId,
    role,
    n: full.n ?? null,
    status: full.status ?? "done",
    endpoint: full.endpoint ?? null,
    ms: full.ms ?? 0,
    duration: full.duration ?? 0,
    url: full.url ?? null,
    startedAt: full.startedAt ?? null,
    at: full.at ?? null,
    voiceRef: full.voiceRef ?? null,
    voice: full.voice ?? null,
    model: full.model ?? null,
    direction: full.direction ?? null,
    style: full.style ?? null,
    instructions: full.instructions ?? null,
    type: full.type ?? null,
    text: full.text ?? null,
    said: full.said ?? null,
    lex: full.lex ?? null,
    pronounced: full.pronounced ?? null,
    expressionSignature: full.expressionSignature ?? null,
    expressions: full.expressions ?? null,
    sampleRate: full.sampleRate ?? null,
    speed: full.speed ?? null,
    sound: full.sound ?? null,
    raw: full.raw ?? null,
    parts: full.parts ?? null,
    splitAt: full.splitAt ?? null,
    cuts: full.cuts ?? null,
    auto: full.auto ?? null,
    rejected: full.rejected ?? null,
    cost: full.cost ?? null,
    charge: full.charge ?? null,
    error: full.error ?? null,
  };
}

/** Every clip row one segment owns, in the order they must be inserted. */
export function segmentClipValues(
  bookId: string,
  chapterId: number,
  segment: Segment,
): Omit<typeof clips.$inferInsert, "id">[] {
  const rows = [clipValues(bookId, chapterId, segment.id, "current", segment.audio)];
  for (const take of segment.audio.takes ?? [])
    rows.push(clipValues(bookId, chapterId, segment.id, "take", take));
  if (segment.candidate)
    rows.push(clipValues(bookId, chapterId, segment.id, "candidate", segment.candidate));
  return rows;
}

/** One line, with its clips. */
export function toSegment(row: SegmentRow, clipRows: readonly ClipRow[]): Segment {
  const current = clipRows.find((c) => c.role === "current");
  const takes = clipRows.filter((c) => c.role === "take").sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const candidate = clipRows.find((c) => c.role === "candidate");

  const s: Segment = {
    id: row.id,
    type: row.type,
    speaker: row.speaker,
    text: row.text,
    direction: row.direction,
    // always an audio object: the store reads `segment.audio.status` unconditionally
    audio: current
      ? toSegmentAudio(current, takes)
      : { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  if (row.fallback) s.fallback = true;
  if (row.fallbackCount != null) s.fallbackCount = row.fallbackCount;
  if (row.fallbackMismatch != null) s.fallbackMismatch = row.fallbackMismatch;
  if (row.edited) s.edited = true;
  if (row.siteCheck != null) s.siteCheck = row.siteCheck;
  if (row.mended != null) s.mended = row.mended;
  if (row.flag != null) s.flag = row.flag;
  if (row.pause != null) s.pause = row.pause;
  if (candidate) s.candidate = toSegmentAudio(candidate);
  if (row.sep != null) s.sep = row.sep;
  if (row.expressions != null) s.expressions = row.expressions;
  if (row.effects?.length) s.effects = row.effects;
  return s;
}

export function segmentValues(
  bookId: string,
  chapterId: number,
  s: Segment,
  position: number,
): typeof segments.$inferInsert {
  return {
    bookId,
    chapterId,
    id: s.id,
    position,
    type: s.type,
    speaker: s.speaker,
    text: s.text,
    direction: s.direction,
    fallback: s.fallback ?? null,
    fallbackCount: s.fallbackCount ?? null,
    fallbackMismatch: s.fallbackMismatch ?? null,
    edited: s.edited ?? null,
    siteCheck: s.siteCheck ?? null,
    mended: s.mended ?? null,
    pause: s.pause ?? null,
    sep: s.sep ?? null,
    flag: s.flag ?? null,
    expressions: s.expressions ?? null,
    effects: s.effects?.length ? s.effects : null,
  };
}

// ---------- history ----------

export function toScriptVersion(row: VersionRow): ScriptVersion {
  return { id: row.id, at: row.at, origin: row.origin, segments: row.segments };
}

export function scriptVersionValues(
  bookId: string,
  chapterId: number,
  v: ScriptVersion,
): typeof scriptVersions.$inferInsert {
  return { bookId, chapterId, id: v.id, at: v.at, origin: v.origin, segments: v.segments };
}

/** A chapter's history: its versions oldest first, and where the working script stands. */
export function toChapterHistory(head: HeadRow, versions: readonly VersionRow[]): ChapterHistory {
  return {
    versions: [...versions].sort((a, b) => a.id - b.id).map(toScriptVersion),
    head: {
      at: head.at,
      origin: head.origin,
      ...(head.open ? { open: true } : {}),
    },
    nextId: head.nextId,
  };
}

export function scriptHeadValues(
  bookId: string,
  chapterId: number,
  h: ChapterHistory,
): typeof scriptHeads.$inferInsert {
  return {
    bookId,
    chapterId,
    at: h.head.at,
    origin: h.head.origin,
    open: h.head.open ?? null,
    nextId: h.nextId,
  };
}

/** A transcription's finding, without the endpoint (only the ledger needs it). */
export const toHeardLine = (row: typeof heard.$inferSelect): HeardLine => ({
  text: row.text,
  heard: row.heard,
  words: row.words ?? null,
  score: row.score,
  mismatch: row.mismatch,
  at: row.at,
});
