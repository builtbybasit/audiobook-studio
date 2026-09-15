// Export: what a build would produce, what it did produce, and why a finished one no longer matches
// the book. A build makes one *export*, which is one or more files; grouping decides how many.
import type { VoiceRef } from "./common";

export type ExportStatus = "building" | "done" | "failed" | "cancelled" | "replaced";

/** The container the audiobook is written in. */
export type ExportFormat = "m4b" | "mp3";

/** How the selected chapters are cut into files. */
export type ExportGrouping = "single" | "volume" | "chapter";

/** Integrated loudness target, LUFS. */
export type LoudnessTarget = -23 | -18 | -16;

export interface ExportVolume {
  number: number;
  name: string;
  of: number;
}

/**
 * What a selection *claimed*, so a finished export knows which chapters it is responsible for
 * keeping up with. A build of everything the book can give follows the book; three chapters picked
 * on purpose stay those three, and anything narrated elsewhere is offered separately rather than
 * folded in behind your back.
 */
export type ExportScope = "book" | "volumes" | "chosen";

/** One chapter of a finished export, as it played when the export was built. */
export interface ExportTimelineEntry {
  id: number;
  title: string;
  /** seconds, as rendered at build time — not as the chapter stands now */
  duration: number;
}

/**
 * Everything one build needs. Gaps *inside* a chapter are deliberately absent: they belong to the
 * book's pacing and its per-line overrides, which the reader, the ledger, the chapter duration and
 * the player already share. `chapterGap` is the one piece of silence Export owns, because the join
 * between two chapters only exists once they are stitched into a file.
 */
export interface ExportSettings {
  filename: string;
  title: string;
  series: string;
  author: string;
  narrator: string;
  year: number;
  description: string;
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
  /** the user chose, explicitly, to build with clips the script has moved under */
  useStale: boolean;
}

/** One output file of a plan or a finished export. */
export interface ExportFile {
  name: string;
  chapterIds: number[];
  duration: number;
  /** MB */
  size: number;
  /** chapter marks written inside this file; 0 when the file is one chapter, or the format has none */
  markers: number;
  volume: ExportVolume | null;
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

/** What one chapter contributes to a build. */
export type ChapterReadiness =
  | "ready"
  | "stale"
  | "partial"
  | "failed"
  | "missing"
  | "running"
  | "skipped";

/** Something wrong with the selection, and the ways out of it. */
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

/** One voice in the selection and what normalisation would do to it. Simulated, never measured. */
export interface VoiceLoudness {
  ref: VoiceRef;
  label: string;
  endpoint: string;
  segments: number;
  /** integrated loudness, LUFS */
  lufs: number;
  /** dB that normalisation would apply */
  gain: number;
}

export interface LoudnessReport {
  voices: VoiceLoudness[];
  /** LU between the quietest and the loudest voice */
  spread: number;
  target: number;
  enabled: boolean;
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
  /** which chapters this export claims; absent on entries built before it was recorded */
  scope?: ExportScope;
  /** everything it was built with, so an update starts from it rather than from the defaults */
  settings?: ExportSettings;
  /** the chapters as they played when it was built, so it can be heard as built */
  timeline?: ExportTimelineEntry[];
  /** id of the export this one supersedes */
  replaces: number | null;
  status: ExportStatus;
  progress?: number;
  customCover?: boolean;
  /** what each chapter's audio was when this was built — how "needs an update" is decided */
  state: Record<number, string>;
  /** chapters re-encoded by the build that made this version */
  rebuilt?: number;
  /** chapters carried over from the previous version untouched */
  reused?: number;
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
  /** narrated, and outside what this export claims — offered separately, never folded in */
  outside: number[];
  /** in the export, and the audio has changed since */
  changed: number[];
  /** in the export, and the clips are stale now */
  stale: number[];
  /** in the export, and the audio has gone */
  missing: number[];
  /** output settings that differ from the form as it stands */
  settings: string[];
  /** chapters that can be carried over untouched */
  reusable: number;
  needed: boolean;
}
