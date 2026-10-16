// Export: what a build would produce, what it did produce, and why a finished one no longer matches
// the book. A build makes one *export*, which is one or more files; grouping decides how many.
export type ExportStatus = "building" | "done" | "failed" | "cancelled" | "replaced";

export type ExportFormat = "m4b" | "mp3";

export type ExportGrouping = "single" | "volume" | "chapter";

/** Integrated loudness target, LUFS. */
export type LoudnessTarget = -23 | -18 | -16;

export interface ExportVolume {
  number: number;
  name: string;
  of: number;
}

/**
 * The chapters an export keeps up with. `book` follows the book; `chosen` stays those chapters, and
 * anything narrated elsewhere is offered separately, never folded in.
 */
export type ExportScope = "book" | "volumes" | "chosen";

/** One chapter of a finished export, as it played when the export was built. */
export interface ExportTimelineEntry {
  id: number;
  title: string;
  /** seconds, as rendered at build time */
  duration: number;
}

/**
 * Gaps inside a chapter are absent on purpose: they belong to the book's pacing. `chapterGap` is
 * the one silence Export owns, since a chapter join only exists once stitched into a file.
 */
export interface ExportSettings {
  filename: string;
  title: string;
  series: string;
  author: string;
  narrator: string;
  year: number;
  description: string;
  /**
   * The image written in place of the EPUB's cover, or null for the EPUB's: the uploaded url
   * (`/api/books/:id/covers/…`, or `/demo/api/…`), or a data URL in the serverless demo.
   */
  cover: string | null;
  format: ExportFormat;
  grouping: ExportGrouping;
  /** kbps */
  bitrate: number;
  markers: boolean;
  markerPattern: string;
  /** prefix marker titles with the volume, when one file holds several volumes */
  volPrefix: boolean;
  /** seconds of silence between two chapters inside one file */
  chapterGap: number;
  normalize: boolean;
  loudness: LoudnessTarget;
  /** the user explicitly chose to build with clips the script has moved under */
  useStale: boolean;
}

/** One output file of a plan or a finished export. */
export interface ExportFile {
  name: string;
  chapterIds: number[];
  duration: number;
  /** MB */
  size: number;
  /** chapter marks in this file; 0 when it is one chapter, or the format has none */
  markers: number;
  volume: ExportVolume | null;
  /** where it is on the server's disk, once written */
  path?: string;
}

export interface ExportPlanFile extends ExportFile {
  title: string;
}

/** What pressing Build would produce. Computing it mutates nothing. */
export interface ExportPlan {
  files: ExportPlanFile[];
  /** the single file's name, or the folder a set is written to */
  label: string;
  chapters: number;
  duration: number;
  size: number;
  markers: number;
  /** total silence added between chapters */
  gaps: number;
}

export type ChapterReadiness =
  | "ready"
  | "stale"
  | "partial"
  | "failed"
  | "missing"
  | "running"
  | "skipped";

export interface ExportBlocker {
  kind: "empty" | "missing" | "failed" | "partial" | "running" | "stale";
  ids: number[];
  title: string;
  detail: string;
  /** `narrate` fixes it upstream, `drop` takes the chapters out, `stale` accepts the old audio */
  actions: ("narrate" | "drop" | "stale")[];
}

export interface ExportReview {
  ready: number[];
  stale: number[];
  partial: number[];
  failed: number[];
  missing: number[];
  running: number[];
  /** selected chapters that carry audio a build could use */
  usable: number[];
  blockers: ExportBlocker[];
  /** stale chapters the user has explicitly accepted */
  usingStale: number;
}

export interface ExportItem {
  id: number;
  bookId: string;
  /** same name + format + grouping ⇒ the same audiobook, built again */
  key: string;
  /** the file, or the folder a set of files lives in */
  filename: string;
  title: string;
  series: string;
  author: string;
  narrator: string;
  year: number;
  description: string;
  format: ExportFormat;
  grouping: ExportGrouping;
  files: ExportFile[];
  chapterIds: number[];
  chapters: number;
  duration: number;
  bitrate: number;
  chapterGap: number;
  normalize: boolean;
  loudness: LoudnessTarget;
  /** MB */
  size: number;
  /** chapter marks written across every file */
  markers: number;
  createdAt: string;
  version: number;
  /** absent on entries built before it was recorded */
  scope?: ExportScope;
  /** what it was built with, so an update starts from it rather than the defaults */
  settings?: ExportSettings;
  /** the chapters as they played when built */
  timeline?: ExportTimelineEntry[];
  /** id of the export this one supersedes */
  replaces: number | null;
  status: ExportStatus;
  progress?: number;
  customCover?: boolean;
  /** each chapter's audio and place when this was built; decides "needs an update" */
  state: Record<number, string>;
  /** a finished one's chapters whose `state` no longer matches the book, as the server read it */
  changed?: number[];
  /** clips that were already stale when this was built, accepted on purpose */
  stale?: number;
  /** why a failed build failed */
  error?: string;
  jobId?: number;
}

/** Why a finished export no longer matches the book, chapter by chapter. */
export interface ExportUpdate {
  /** narrated since, inside this export's scope, and not in it */
  added: number[];
  /** narrated, outside what this export claims; offered separately, never folded in */
  outside: number[];
  /** in the export, and the audio has changed since */
  changed: number[];
  /** in the export, and the clips are stale now */
  stale: number[];
  /** in the export, and the audio has gone */
  missing: number[];
  /** output settings that differ from the form as it stands */
  settings: string[];
  needed: boolean;
}
