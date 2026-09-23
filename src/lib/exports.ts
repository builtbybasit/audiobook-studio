// What an export *is*, decided from chapters and settings alone. Nothing here mutates, nothing here
// reaches the store: the Export page previews a build with `planOf` and `reviewOf` before a single
// job is queued, and the store builds exactly the plan the page showed.
//
// Two ideas hold the page together:
//
//  - **A plan is the whole deliverable.** One build makes one *export*, which is one or more files.
//    Grouping decides how many; nothing else changes. So the file count, the names, the order, the
//    duration and the size are all read off one structure and can never disagree with each other.
//  - **Silence has one owner.** Gaps *inside* a chapter belong to the book's pacing (and the
//    per-line overrides on top of it) — the same numbers the reader, the ledger and the player use.
//    Export only owns the gap *between* two chapters, because that join does not exist until the
//    chapters are stitched. `durationOf` is therefore the only place chapter time is added up.
import { pauseAfter, silenceOf } from "@/lib/speech";
import type {
  Chapter,
  ChapterReadiness,
  ExportBlocker,
  ExportFormat,
  ExportGrouping,
  ExportItem,
  ExportPlan,
  ExportPlanFile,
  ExportReview,
  ExportSettings,
  LoudnessReport,
  Pacing,
  Segment,
  VoiceLoudness,
  VoiceRef,
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
  /** bytes per second per kbps, over the raw stream — container, cover art and tags */
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

/** Characters no file system agrees on, plus runs of space. Never touches the user's words. */
export const safeName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** "Vol. 2 · Down the Mountain" → "Vol. 2" — the part that belongs in a filename. */
export const shortVolume = (name: string): string => name.split("·")[0].trim();

export const baseName = (s: ExportSettings): string =>
  safeName(s.filename || s.title || "audiobook").replace(/\.(m4b|mp3)$/i, "") || "audiobook";

/** Zero-padded track number, wide enough for the whole set: 007 of 214, 07 of 18. */
export const trackNo = (n: number, total: number): string =>
  String(n).padStart(Math.max(2, String(total).length), "0");

/**
 * What to call the whole deliverable. One file is named by itself; a set of files lives in a folder,
 * so the page can say "42 files in one folder" instead of listing forty-two paths.
 */
export const setLabel = (s: ExportSettings, files: { name: string }[]): string =>
  files.length === 1 ? files[0].name : `${baseName(s)}/`;

/** Identity for versioning: same name, format and grouping ⇒ the same audiobook, built again. */
export const exportKey = (s: ExportSettings): string =>
  `${baseName(s).toLowerCase()}|${s.format}|${s.grouping}`;

/**
 * What one file is called inside itself — the title a player lists it by, which the plan shows
 * and the build writes as the file's tag: the book's for a single file, the book's and its
 * volume's for a file per volume, the chapter's for a file per chapter.
 */
export function fileTitle(
  s: ExportSettings,
  volume: string | null,
  chapters: { title: string }[],
): string {
  if (volume) return `${s.title} · ${shortVolume(volume)}`;
  if (s.grouping === "chapter" && chapters.length) return chapters[0].title;
  return s.title;
}

/** One chapter marker as the player will list it. */
export function markerTitle(
  c: Chapter,
  n: number,
  s: ExportSettings,
  volume: string | null,
): string {
  const prefix =
    volume && s.volPrefix && s.grouping === "single" ? `${shortVolume(volume)} · ` : "";
  return (s.markerPattern || "{title}")
    .replace("{n}", String(n))
    .replace("{title}", prefix + c.title);
}

/**
 * What a build starts as. Two of these are opinions worth stating:
 *  - `useStale` is false, so building with clips the script has moved under is always a choice
 *    someone made rather than a default they inherited.
 *  - `normalize` is on, because a book read by several voices from several providers arrives at
 *    several different levels, and a listener notices that long before they notice the bitrate.
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

/**
 * The images a cover can be. M4B and MP3 both carry a JPEG or a PNG and players read nothing else
 * reliably, so the server refuses anything else and the demo keeps the same rule rather than
 * promising to embed an image a real build would turn away.
 */
export const COVER_TYPES = ["image/jpeg", "image/png"] as const;
/** The largest cover the server keeps, in bytes. */
export const COVER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Why this file cannot be a cover, in the server's words, or null when it can. Asked before
 * anything is uploaded, so a PDF picked by mistake is turned away without a round trip — the
 * server still decides, from the bytes rather than the name.
 */
export function coverRefusal(file: { type: string; size: number }): string | null {
  if (!(COVER_TYPES as readonly string[]).includes(file.type))
    return "A cover has to be a JPEG or PNG image";
  if (file.size > COVER_MAX_BYTES) return "That image is larger than 10 MB";
  return null;
}

/**
 * A file as a `data:` URL: how the demo holds a picked cover, having nowhere to upload it. Read
 * through `arrayBuffer` rather than `FileReader`, so it is the same code in a test as on the page.
 */
export async function dataUrlOf(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // in slices: spreading a whole image into one call overflows the argument limit
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
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
 * How long a run of chapters plays. Each chapter already carries its clips *and* the silence the
 * book's pacing stitches inside it (`store._retime`); stitching two chapters together adds one
 * chapter gap between them, and none after the last.
 */
export const durationOf = (chapters: Chapter[], chapterGap: number): number =>
  chapters.reduce((a, c) => a + c.duration, 0) + Math.max(0, chapters.length - 1) * chapterGap;

/** The silence the book's pacing puts inside one chapter — quoted so Export can show its share. */
export const silenceInside = (segments: Segment[], pacing: Pacing): number =>
  silenceOf(segments, pacing);

// ---------- the plan ----------

export interface PlanInput {
  /** the selected chapters, in reading order */
  chapters: Chapter[];
  volumes: Volume[];
  settings: ExportSettings;
}

/** What pressing Build will produce: every file, in order, with its chapters. */
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

/** What one chapter contributes to a build, in the words the page uses for it. */
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

/** Chapters that carry audio a build can actually use. */
export const usable = (c: Chapter): boolean => {
  const r = readinessOf(c);
  return r === "ready" || r === "stale" || r === "partial";
};

/**
 * Everything wrong with a selection, as a list of things to *do* rather than a list of complaints.
 * A blocker stops the build; a warning is worth saying and nothing more. Nothing is ever dropped
 * quietly: leaving a chapter out is one of the offered actions, and taking it removes it from the
 * selection, so what the list shows and what gets built are the same set.
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
// Simulated. Nothing is measured and nothing is processed: these numbers come from the voice's
// identity, so the same voice always reads the same and the control can be exercised end to end.
// Every screen that shows them says so.

/** FNV-1a. Used for the invented loudness figures and for identifying a preview's timeline. */
export const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Integrated loudness a voice would measure at, LUFS. Deterministic, invented, never measured. */
export function measuredLoudness(ref: VoiceRef): number {
  // endpoints differ systematically (one model simply renders hotter), voices vary inside that
  const [endpointId] = ref.split("/");
  const centre = -21 + (hash(endpointId) % 700) / 100; // −21 … −14
  const spread = ((hash(ref) % 400) - 200) / 100; // ±2 LU
  return Math.round((centre + spread) * 10) / 10;
}

export const LOUDNESS_TARGETS = [
  { value: -23, label: "−23 LUFS", hint: "EBU R128 · broadcast" },
  { value: -18, label: "−18 LUFS", hint: "spoken word · what most audiobook stores expect" },
  { value: -16, label: "−16 LUFS", hint: "louder · podcast apps and phone speakers" },
] as const;

/** What normalisation would do to each voice in a selection, and how far apart they are now. */
export function loudnessReport(
  voices: { ref: VoiceRef; label: string; endpoint: string; segments: number }[],
  settings: ExportSettings,
): LoudnessReport {
  const rows: VoiceLoudness[] = voices
    .map((v) => {
      const lufs = measuredLoudness(v.ref);
      return {
        ...v,
        lufs,
        gain: Math.round((settings.loudness - lufs) * 10) / 10,
      };
    })
    .sort((a, b) => a.lufs - b.lufs);
  const levels = rows.map((r) => r.lufs);
  return {
    voices: rows,
    spread: rows.length ? Math.round((Math.max(...levels) - Math.min(...levels)) * 10) / 10 : 0,
    target: settings.loudness,
    enabled: settings.normalize,
  };
}

// ---------- what changed since a build ----------

/**
 * A fingerprint of a chapter's *audio*, as it stands now. An export stores one per chapter; when
 * they stop matching, that chapter — and only that chapter — needs encoding again.
 *
 * It deliberately covers the stitched silence as well as the clips: a pause costs nothing and
 * invalidates no audio, but it does change the file, so an export built before it is out of date.
 */
export function chapterSignature(c: Chapter, segments: Segment[], pacing: Pacing): string {
  const clips = segments.filter((s) => s.audio.duration > 0);
  let h = 0;
  let silence = 0;
  // Each pause is folded in *where it falls*, not just added to a total: two pauses that swap
  // places — 1s then 2s, 2s then 1s — leave the running time alone and still change the file.
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

/** Settings that change the bytes, so a rebuild is a different file rather than the same one. */
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
 * The settings of a finished export, so the page can diff a form against it and an update can start
 * from it. A build records everything it ran with; entries from before that — the seeded ones —
 * are read back from the fields they kept, and a setting they never recorded stays `undefined`
 * rather than pretending to be the default.
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

/**
 * Would a rebuild write the same bytes for a chapter that has not moved? Only then can that chapter
 * be carried over instead of encoded again. The plan's estimate and the build itself both ask here,
 * so what the page promises and what the build does cannot drift apart.
 */
export function sameOutput(prev: ExportItem, s: ExportSettings): boolean {
  // A setting the export did not record cannot be compared, so it cannot rule reuse out either.
  const was = settingsOf(prev);
  return OUTPUT_KEYS.every((k) => was[k] === undefined || was[k] === s[k]);
}

/**
 * The chapters a build would carry over from `prev` untouched rather than encode again.
 *
 * The page's estimate, the build itself and the server's build all come here, so what the plan
 * panel promises and what is actually copied cannot drift apart. A setting that changes the bytes
 * rules the whole thing out at once: a different bitrate or layout is a different file, and
 * nothing in it can be carried over from the last one.
 */
export function reusedChapters(
  prev: ExportItem | null | undefined,
  ids: readonly number[],
  settings: ExportSettings,
  now: Record<number, string>,
): number[] {
  if (!prev || !sameOutput(prev, settings)) return [];
  return ids.filter((id) => !!prev.state?.[id] && prev.state[id] === now[id]);
}
