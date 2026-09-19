// Finished audiobooks, between rows and the shapes the Export page reads.
//
// `ExportItem` carries two per-chapter maps — `state`, the signature of the audio each chapter was
// built from, and `timeline`, the duration each chapter had at build time. They are one table here,
// `export_chapters`, because they are two facts about the same thing. `files` carries which
// chapters landed in each output file, so the file index is stored on the chapter row and the file
// list is rebuilt from it.
import type { ExportFile, ExportItem, ExportTimelineEntry } from "@/types";
import type { exportChapters, exportFiles, exportItems } from "~/db/schema";

type ExportRow = typeof exportItems.$inferSelect;
type FileRow = typeof exportFiles.$inferSelect;
type ChapterRow = typeof exportChapters.$inferSelect;

export function toExportItem(
  row: ExportRow,
  fileRows: readonly FileRow[],
  chapterRows: readonly ChapterRow[],
): ExportItem {
  const ordered = [...chapterRows].sort((a, b) => a.position - b.position);
  const files: ExportFile[] = [...fileRows]
    .sort((a, b) => a.position - b.position)
    .map((f) => ({
      name: f.name,
      chapterIds: ordered.filter((c) => c.fileIndex === f.position).map((c) => c.chapterId),
      duration: f.duration,
      size: f.size,
      markers: f.markers,
      volume: f.volume ?? null,
    }));

  const e: ExportItem = {
    id: row.id,
    bookId: row.bookId,
    key: row.key,
    filename: row.filename,
    title: row.title,
    series: row.series,
    author: row.author,
    narrator: row.narrator,
    year: row.year ?? 0,
    description: row.description,
    format: row.format,
    grouping: row.grouping,
    files,
    chapterIds: ordered.map((c) => c.chapterId),
    chapters: row.chapterCount,
    duration: row.duration,
    bitrate: row.bitrate ?? 0,
    chapterGap: row.chapterGap ?? 0,
    normalize: row.normalize ?? false,
    loudness: (row.loudness ?? -18) as ExportItem["loudness"],
    size: row.size,
    markers: row.markers,
    createdAt: new Date(row.createdAt).toISOString().slice(0, 10),
    version: row.version,
    replaces: row.replaces,
    status: row.status,
    state: Object.fromEntries(
      ordered.filter((c) => c.signature != null).map((c) => [c.chapterId, c.signature!]),
    ),
  };
  if (row.scope != null) e.scope = row.scope;
  if (row.settings != null) e.settings = row.settings;
  if (row.progress != null) e.progress = row.progress;
  if (row.customCover) e.customCover = true;
  if (row.rebuilt != null) e.rebuilt = row.rebuilt;
  if (row.reused != null) e.reused = row.reused;
  if (row.stale != null) e.stale = row.stale;
  if (row.error != null) e.error = row.error;
  if (row.jobId != null) e.jobId = row.jobId;
  // The chapters as they played when it was built. Absent on an export made before the timeline
  // was recorded — which is why a missing duration is null and not zero: inventing a timeline of
  // silent chapters would be worse than having none.
  if (ordered.some((c) => c.duration != null)) {
    const timeline: ExportTimelineEntry[] = ordered.map((c) => ({
      id: c.chapterId,
      title: c.title ?? "",
      duration: c.duration ?? 0,
    }));
    e.timeline = timeline;
  }
  return e;
}

export function exportValues(e: ExportItem, createdAt: number): typeof exportItems.$inferInsert {
  return {
    id: e.id,
    bookId: e.bookId,
    key: e.key,
    version: e.version,
    replaces: e.replaces,
    status: e.status,
    progress: e.progress ?? null,
    error: e.error ?? null,
    jobId: e.jobId ?? null,
    filename: e.filename,
    title: e.title,
    series: e.series,
    author: e.author,
    narrator: e.narrator,
    year: e.year,
    description: e.description,
    customCover: e.customCover ?? null,
    format: e.format,
    grouping: e.grouping,
    bitrate: e.bitrate,
    chapterGap: e.chapterGap,
    normalize: e.normalize,
    loudness: e.loudness,
    chapterCount: e.chapters,
    duration: e.duration,
    size: e.size,
    markers: e.markers,
    createdAt,
    scope: e.scope ?? null,
    settings: e.settings ?? null,
    rebuilt: e.rebuilt ?? null,
    reused: e.reused ?? null,
    stale: e.stale ?? null,
  };
}

export const exportFileValues = (
  exportId: number,
  f: ExportFile,
  position: number,
): typeof exportFiles.$inferInsert => ({
  exportId,
  position,
  name: f.name,
  duration: f.duration,
  size: f.size,
  markers: f.markers,
  volume: f.volume,
});

/** One row per chapter of the export, carrying its build-time duration and its audio signature. */
export function exportChapterValues(e: ExportItem): (typeof exportChapters.$inferInsert)[] {
  const fileOf = new Map<number, number>();
  e.files.forEach((f, i) => {
    for (const id of f.chapterIds) fileOf.set(id, i);
  });
  const timeline = new Map(e.timeline?.map((t) => [t.id, t]) ?? []);
  return e.chapterIds.map((id, position) => ({
    exportId: e.id,
    bookId: e.bookId,
    chapterId: id,
    position,
    fileIndex: fileOf.get(id) ?? null,
    title: timeline.get(id)?.title ?? null,
    duration: timeline.get(id)?.duration ?? null,
    signature: e.state?.[id] ?? null,
  }));
}
