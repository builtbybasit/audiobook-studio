// What an export is, decided from chapters and settings alone (pure). The Export page previews
// with `planOf` and `reviewOf`, and the store builds exactly that plan. Silence inside a chapter is
// the book's pacing; export owns only the gap between chapters (`durationOf`).
import { heardLines } from "@/lib/siteText";
import { pauseAfter } from "@/lib/speech";
import type {
  Book,
  Chapter,
  ChapterReadiness,
  ExportBlocker,
  ExportFile,
  ExportFormat,
  ExportGrouping,
  ExportItem,
  ExportPlan,
  ExportPlanFile,
  ExportReview,
  ExportScope,
  ExportSettings,
  Pacing,
  Segment,
  Volume,
} from "@/types";

// ---------- formats and grouping ----------

export interface FormatOption {
  value: ExportFormat;
  label: string;
  ext: string;
  hint: string;
  /** chapter markers inside the file; MP3 has no equivalent every player reads */
  markers: boolean;
  /** size factor over the raw stream: container, cover art and tags */
  overhead: number;
}

export const FORMATS: FormatOption[] = [
  {
    value: "m4b",
    label: "M4B",
    ext: "m4b",
    hint: "AAC in an audiobook container — chapter marks, cover and bookmarks",
    markers: true,
    overhead: 1.04,
  },
  {
    value: "mp3",
    label: "MP3",
    ext: "mp3",
    hint: "plays anywhere; chapters come from the files themselves",
    markers: false,
    overhead: 1.02,
  },
];

export const formatOf = (f: ExportFormat): FormatOption =>
  FORMATS.find((x) => x.value === f) ?? FORMATS[0];

export interface GroupingOption {
  value: ExportGrouping;
  label: string;
  /** what the segmented control has room for */
  short: string;
  hint: string;
}

export const GROUPINGS: GroupingOption[] = [
  {
    value: "single",
    label: "One audiobook",
    short: "One file",
    hint: "every selected chapter in one file",
  },
  {
    value: "volume",
    label: "One file per volume",
    short: "Per volume",
    hint: "one file for each volume — players group them as a series",
  },
  {
    value: "chapter",
    label: "One file per chapter",
    short: "Per chapter",
    hint: "a folder of numbered tracks, one per chapter",
  },
];

/** Bitrates worth offering for speech. Above 128 kbps nothing audible is gained. */
export const BITRATES = [32, 48, 64, 96, 128] as const;

// ---------- names ----------

/** Replaces characters no file system agrees on and collapses runs of space. */
export const safeName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** "Vol. 2 · Down the Mountain" → "Vol. 2" */
export const shortVolume = (name: string): string => name.split("·")[0].trim();

export const baseName = (s: ExportSettings): string =>
  safeName(s.filename || s.title || "audiobook").replace(/\.(m4b|mp3)$/i, "") || "audiobook";

/** 007 of 214, 07 of 18. */
export const trackNo = (n: number, total: number): string =>
  String(n).padStart(Math.max(2, String(total).length), "0");

/** One file is named by itself; a set of files by its folder. */
export const setLabel = (s: ExportSettings, files: { name: string }[]): string =>
  files.length === 1 ? files[0].name : `${baseName(s)}/`;

/** Identity for versioning: same name, format and grouping ⇒ the same audiobook, built again. */
export const exportKey = (s: ExportSettings): string =>
  `${baseName(s).toLowerCase()}|${s.format}|${s.grouping}`;

/** The title tag a player lists a file by. */
export function fileTitle(
  s: ExportSettings,
  volume: string | null,
  chapters: { title: string }[],
): string {
  if (volume) return `${s.title} · ${shortVolume(volume)}`;
  if (s.grouping === "chapter" && chapters.length) return chapters[0].title;
  return s.title;
}

/** The volume a chapter's mark may name: none in a one-volume book, where it says nothing. */
export const markVolume = (volumes: Volume[], c: Chapter): string | null =>
  volumes.length > 1 ? (volumes.find((v) => v.id === c.volumeId)?.name ?? null) : null;

export function markerTitle(
  c: Chapter,
  n: number,
  s: ExportSettings,
  volume: string | null,
): string {
  const prefix =
    volume && s.volPrefix && s.grouping === "single" ? `${shortVolume(volume)} · ` : "";
  // a replacer function, so a `$` in a title is a dollar sign and not a pattern
  return (s.markerPattern || "{title}").replace(/\{(n|title)\}/g, (_, key: string) =>
    key === "n" ? String(n) : prefix + c.title,
  );
}

/**
 * `useStale` is off so building with stale clips is always a deliberate choice. `normalize` is on:
 * voices from several providers arrive at different levels.
 */
export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  filename: "",
  title: "",
  series: "",
  author: "",
  narrator: "",
  year: new Date().getFullYear(),
  description: "",
  cover: null,
  format: "m4b",
  grouping: "single",
  bitrate: 64,
  markers: true,
  markerPattern: "{n}. {title}",
  volPrefix: true,
  chapterGap: 2,
  normalize: true,
  loudness: -18,
  useStale: false,
};

// ---------- the cover ----------

/** Players read nothing else reliably in M4B or MP3. */
export const COVER_TYPES = ["image/jpeg", "image/png"] as const;
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

/** A pre-upload check in the server's words; the server still decides, from the bytes. */
export function coverRefusal(file: { type: string; size: number }): string | null {
  if (!(COVER_TYPES as readonly string[]).includes(file.type))
    return "A cover has to be a JPEG or PNG image";
  if (file.size > COVER_MAX_BYTES) return "That image is larger than 10 MB";
  return null;
}

export const MARKER_PATTERNS = [
  { value: "{n}. {title}", sample: "1. The Silent Peak" },
  { value: "Chapter {n} — {title}", sample: "Chapter 1 — The Silent Peak" },
  { value: "{title}", sample: "The Silent Peak" },
  { value: "Chapter {n}", sample: "Chapter 1" },
];

// ---------- size and duration ----------

/** Megabytes at this bitrate, container overhead included. */
export const sizeOf = (seconds: number, s: ExportSettings): number =>
  Math.max(
    seconds > 0 ? 1 : 0,
    Math.round(((seconds * s.bitrate) / 8 / 1024) * formatOf(s.format).overhead),
  );

/**
 * A chapter's duration already includes its inner silence (`store._retime`); joining adds one
 * chapter gap between each pair. The only place chapter time is added up.
 */
export const durationOf = (chapters: Chapter[], chapterGap: number): number =>
  chapters.reduce((a, c) => a + c.duration, 0) + Math.max(0, chapters.length - 1) * chapterGap;

// ---------- the plan ----------

export interface PlanInput {
  /** the selected chapters, in reading order */
  chapters: Chapter[];
  volumes: Volume[];
  settings: ExportSettings;
}

/**
 * What Build will produce: every file, in order, with its chapters. Count, names, duration and
 * size all come off this one structure, so they cannot disagree.
 */
export function planOf({ chapters, volumes, settings }: PlanInput): ExportPlan {
  const s = settings;
  const ext = formatOf(s.format).ext;
  const base = baseName(s);
  const markers = s.markers && formatOf(s.format).markers;
  const groups: { name: string; chapters: Chapter[]; volume: Volume | null }[] =
    s.grouping === "volume"
      ? volumes
          .map((v) => ({
            name: `${base} - ${safeName(shortVolume(v.name))}`,
            chapters: chapters.filter((c) => c.volumeId === v.id),
            volume: v,
          }))
          .filter((g) => g.chapters.length)
      : s.grouping === "chapter"
        ? chapters.map((c, i) => ({
            name: `${base}/${trackNo(i + 1, chapters.length)} - ${safeName(c.title)}`,
            chapters: [c],
            volume: volumes.find((v) => v.id === c.volumeId) ?? null,
          }))
        : [{ name: base, chapters, volume: null }];

  const files: ExportPlanFile[] = groups.map((g, i) => {
    const duration = durationOf(g.chapters, s.chapterGap);
    return {
      name: `${g.name}.${ext}`,
      title: fileTitle(s, s.grouping === "volume" ? (g.volume?.name ?? null) : null, g.chapters),
      chapterIds: g.chapters.map((c) => c.id),
      volume:
        s.grouping === "volume" && g.volume
          ? { number: i + 1, name: g.volume.name, of: groups.length }
          : null,
      duration,
      size: sizeOf(duration, s),
      // a one-chapter file needs no marks inside it: the file is the chapter
      markers: markers && g.chapters.length > 1 ? g.chapters.length : 0,
    };
  });
  const duration = files.reduce((a, f) => a + f.duration, 0);
  return {
    files,
    label: setLabel(s, files),
    chapters: chapters.length,
    duration,
    size: files.reduce((a, f) => a + f.size, 0),
    markers: files.reduce((a, f) => a + f.markers, 0),
    gaps: files.reduce((a, f) => a + Math.max(0, f.chapterIds.length - 1), 0) * s.chapterGap,
  };
}

// ---------- readiness ----------

export function readinessOf(c: Chapter): ChapterReadiness {
  if (c.excluded) return "skipped";
  if (c.narration === "running" || c.narration === "queued") return "running";
  if (c.narration === "done") return "ready";
  if (c.narration === "stale") return "stale";
  if (c.narration === "failed") return c.duration > 0 ? "partial" : "failed";
  return "missing";
}

export const READINESS: Record<
  ChapterReadiness,
  { label: string; short: string; dot: string; tone: "ok" | "warn" | "bad" | "muted" }
> = {
  ready: { label: "Ready", short: "ready", dot: "done", tone: "ok" },
  stale: {
    label: "Stale audio",
    short: "stale",
    dot: "stale",
    tone: "warn",
  },
  partial: {
    label: "Partly narrated",
    short: "partial",
    dot: "failed",
    tone: "bad",
  },
  failed: { label: "Narration failed", short: "failed", dot: "failed", tone: "bad" },
  missing: { label: "No audio yet", short: "no audio", dot: "none", tone: "muted" },
  running: { label: "Narrating now", short: "running", dot: "running", tone: "warn" },
  skipped: { label: "Skipped", short: "skipped", dot: "none", tone: "muted" },
};

export const usable = (c: Chapter): boolean => {
  const r = readinessOf(c);
  return r === "ready" || r === "stale" || r === "partial";
};

/**
 * What a selection claims. "book" (or whole "volumes") falls behind when another chapter is
 * narrated; a "chosen" handful is finished as picked.
 */
export function scopeOf(
  chapters: readonly Chapter[],
  ids: readonly number[],
  grouping: ExportGrouping,
): ExportScope {
  const chosen = new Set(ids);
  const all = chapters.filter((c) => !c.excluded && usable(c));
  if (grouping === "volume") {
    const vols = new Set(chapters.filter((c) => chosen.has(c.id)).map((c) => c.volumeId));
    return all.every((c) => !vols.has(c.volumeId) || chosen.has(c.id)) ? "volumes" : "chosen";
  }
  return all.every((c) => chosen.has(c.id)) ? "book" : "chosen";
}

/**
 * Everything wrong with a selection, as actions. A blocker stops the build. Nothing is dropped
 * quietly: leaving a chapter out is an offered action that removes it from the selection.
 */
export function reviewOf(chapters: Chapter[], settings: ExportSettings): ExportReview {
  const by = (r: ChapterReadiness) => chapters.filter((c) => readinessOf(c) === r).map((c) => c.id);
  const ready = by("ready");
  const stale = by("stale");
  const partial = by("partial");
  const failed = by("failed");
  const missing = by("missing");
  const running = by("running");
  const blockers: ExportBlocker[] = [];

  if (!chapters.length)
    blockers.push({
      kind: "empty",
      ids: [],
      title: "Nothing selected",
      detail: "Choose the whole book, a volume, or single chapters on the left.",
      actions: [],
    });
  if (missing.length)
    blockers.push({
      kind: "missing",
      ids: missing,
      title: `${missing.length} selected chapter${missing.length === 1 ? " has" : "s have"} no audio`,
      detail: "They have never been narrated, so there is nothing to put in the file.",
      actions: ["narrate", "drop"],
    });
  if (failed.length)
    blockers.push({
      kind: "failed",
      ids: failed,
      title: `${failed.length} selected chapter${failed.length === 1 ? "" : "s"} failed to narrate`,
      detail: "Narration failed and left no clips behind. Retry it, or leave it out of this build.",
      actions: ["narrate", "drop"],
    });
  if (partial.length)
    blockers.push({
      kind: "partial",
      ids: partial,
      title: `${partial.length} selected chapter${partial.length === 1 ? " is" : "s are"} only partly narrated`,
      detail:
        "Some lines failed. Building now would leave gaps where those lines should be — finish them first, or leave the chapters out.",
      actions: ["narrate", "drop"],
    });
  if (running.length)
    blockers.push({
      kind: "running",
      ids: running,
      title: `${running.length} selected chapter${running.length === 1 ? " is" : "s are"} still narrating`,
      detail: "Wait for the run to finish, or leave them out and update the export afterwards.",
      actions: ["drop"],
    });
  if (stale.length && !settings.useStale)
    blockers.push({
      kind: "stale",
      ids: stale,
      title: `${stale.length} selected chapter${stale.length === 1 ? " has" : "s have"} stale audio`,
      detail:
        "The script, a voice or the pronunciation changed after these clips were rendered. Using them anyway is a choice worth making on purpose.",
      actions: ["narrate", "stale", "drop"],
    });

  return {
    ready,
    stale,
    partial,
    failed,
    missing,
    running,
    usable: chapters.filter(usable).map((c) => c.id),
    blockers,
    usingStale: settings.useStale ? stale.length : 0,
  };
}

// ---------- loudness ----------
// The build measures and levels with ffmpeg's two-pass EBU R128; nothing here guesses a level.

/** FNV-1a. Identifies a preview's timeline, so the player knows when it has changed. */
export const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export const LOUDNESS_TARGETS = [
  { value: -23, label: "−23 LUFS", hint: "EBU R128 · broadcast" },
  { value: -18, label: "−18 LUFS", hint: "spoken word · what most audiobook stores expect" },
  { value: -16, label: "−16 LUFS", hint: "louder · podcast apps and phone speakers" },
] as const;

// ---------- what changed since a build ----------

/**
 * A fingerprint of a chapter's audio; an export stores one per chapter and re-encodes only those
 * that stop matching. Covers the heard clips (`heardLines`) and the silence between them, since a
 * pause change invalidates no clip but does change the file.
 */
export function chapterSignature(
  c: Chapter,
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): string {
  const clips = heardLines(segments, book);
  let h = 0;
  let silence = 0;
  // folded in where each pause falls: two pauses swapping places keep the total but change the file
  clips.forEach((s, i) => {
    const pause = Math.round(pauseAfter(s, clips[i + 1], pacing) * 100);
    silence += pause;
    h =
      (Math.imul(h, 31) +
        Math.round(s.audio.duration * 100) +
        (s.audio.at ? s.audio.at % 1000003 : 0) +
        (s.audio.n ?? 1) +
        Math.imul(pause, 131)) |
      0;
  });
  return [c.narration, clips.length, Math.round(c.duration * 100), silence, h].join(":");
}

/**
 * What each chapter of `files` is called and where it lands: its file, that file's title tag and
 * its chapter mark. A rename or a volume move changes these without touching the audio.
 */
export function placesOf(
  files: Pick<ExportFile, "name" | "chapterIds" | "volume">[],
  chapters: Chapter[],
  volumes: Volume[],
  s: ExportSettings,
): Map<number, { file: string; marker: string }> {
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const marks = s.markers && formatOf(s.format).markers;
  const out = new Map<number, { file: string; marker: string }>();
  for (const f of files) {
    const inside = f.chapterIds.flatMap((id) => byId.get(id) ?? []);
    const title = fileTitle(s, s.grouping === "volume" ? (f.volume?.name ?? null) : null, inside);
    inside.forEach((c, i) =>
      out.set(c.id, {
        file: `${f.name}\n${title}`,
        marker: marks ? markerTitle(c, i + 1, s, markVolume(volumes, c)) : "",
      }),
    );
  }
  return out;
}

/** A chapter's fingerprint in one export: its audio (`chapterSignature`), then its place. */
export const chapterState = (audio: string, place: { file: string; marker: string }): string =>
  `${audio}|${hash(`${place.file}\n${place.marker}`)}`;

/** Exports recorded before places were fingerprinted are compared on their audio alone. */
export const sameState = (was: string | undefined, now: string): boolean =>
  was === now || (!!was && !was.includes("|") && now.slice(0, now.indexOf("|")) === was);

/** `chapterSignature` for each of `ids` the book has. */
export function chapterStates(
  chapters: Chapter[],
  ids: number[],
  segmentsOf: (chId: number) => Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const id of ids) {
    const c = chapters.find((x) => x.id === id);
    if (c) out[id] = chapterSignature(c, segmentsOf(id), pacing, book);
  }
  return out;
}

/** Settings that change the bytes. */
export const OUTPUT_KEYS = [
  "format",
  "grouping",
  "bitrate",
  "chapterGap",
  "normalize",
  "loudness",
  "markers",
  "markerPattern",
  "volPrefix",
  "cover",
  "title",
  "series",
  "author",
  "narrator",
  "year",
  "description",
] as const;

export const SETTING_LABEL: Record<string, string> = {
  format: "Format",
  grouping: "File layout",
  bitrate: "Bitrate",
  chapterGap: "Gap between chapters",
  normalize: "Loudness normalisation",
  loudness: "Loudness target",
  markers: "Chapter markers",
  markerPattern: "Marker titles",
  volPrefix: "Volume prefix in marker titles",
  cover: "Cover image",
  title: "Title",
  series: "Series",
  author: "Author",
  narrator: "Narrator credit",
  year: "Year",
  description: "Description",
};

/**
 * A finished export's settings. Seeded entries without `settings` are read from their own fields;
 * a setting they never recorded stays `undefined` rather than posing as the default.
 */
export function settingsOf(e: ExportItem): Partial<ExportSettings> {
  if (e.settings) return { ...e.settings };
  return {
    format: e.format,
    grouping: e.grouping,
    bitrate: e.bitrate,
    chapterGap: e.chapterGap,
    normalize: e.normalize,
    loudness: e.loudness,
    markers: e.markers > 0,
    title: e.title,
    series: e.series,
    author: e.author,
    narrator: e.narrator,
    year: e.year,
    description: e.description,
  };
}
