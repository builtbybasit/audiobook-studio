// A book's script as it leaves the install, and the plan an import answers with before it writes
// anything. See docs/script-transfer.md.
//
// **Nothing here is local to one install.** No segment ids, no annotation ids, no `VoiceRef`: an
// endpoint id means nothing on another machine, so a voice travels as a hint the importing side
// judges for itself. Expression tags travel inside a line's `text` as `{tag}` markers.
import type { Gender, VoiceRef } from "@/types/common";
import type { Segment, SegmentType } from "@/types/segment";
import type { KeptSample, Voice } from "@/types/voice";

// ---------- the file ----------

/** One line of a chapter file: what `scriptOnly` keeps, minus the id, with tags as inline markers. */
export interface ScriptFileLine {
  speaker: string;
  type: SegmentType;
  /** the line's words with `{tag}`, `{tag!}` (omitted) and `{tag?}` (needs review) markers; `{{` is a literal brace */
  text: string;
  direction?: string;
  pause?: number;
  sep?: string;
  edited?: boolean;
  fallback?: boolean;
  fallbackCount?: number;
  fallbackMismatch?: string;
}

/** `chapters/NNNN-slug.json` — complete on its own, so it can be imported without the zip. */
export interface ScriptFileChapter {
  format: "audiobook-studio/script-chapter";
  version: 1;
  title: string;
  /** `sha256:<hex>` over the chapter's source words, from the one shared `sourceHash` */
  sourceHash: string;
  /** how many source words that is, for display */
  words: number;
  lines: ScriptFileLine[];
}

/** The manifest's table of contents; where it and a chapter file disagree, the chapter file wins. */
export interface ScriptManifestChapter {
  /** path inside the zip, relative to the manifest */
  file: string;
  title: string;
  sourceHash: string;
  words: number;
}

export interface ScriptManifest {
  format: "audiobook-studio/script";
  version: 1;
  title: string;
  author: string;
  chapters: ScriptManifestChapter[];
}

/**
 * Which voice a speaker had, said so another install can recognise it. `provider` is the host of
 * the endpoint's base URL (endpoints have no provider column); `endpoint` is the endpoint's name,
 * shown to a person and never matched on.
 */
export interface VoiceHint {
  endpoint: string;
  provider: string;
  voiceId: string;
  voiceLabel: string;
}

/** One entry of `cast.json`. */
export interface ScriptFileSpeaker {
  name: string;
  aliases: string[];
  gender: Gender;
  description: string;
  style: string;
  color?: string;
  major?: boolean;
  voice?: VoiceHint;
  /**
   * `voices/<slug>/`, when the export was asked to carry this speaker's voice samples: the folder
   * in the zip holding the recordings and their `samples.json`.
   */
  samples?: string;
}

/** `voices/<slug>/samples.json`: which recordings the folder holds. */
export interface ScriptFileVoice {
  format: "audiobook-studio/voice-samples";
  version: 1;
  /** what the voice was called where it was kept */
  title: string;
  /** the recordings, by their names inside the folder */
  samples: { file: string; name: string; format: KeptSample["format"] }[];
}

/** One entry of `lexicon.json`. */
export interface ScriptFileTerm {
  term: string;
  say: string;
  ipa?: string;
  note?: string;
  matchCase?: boolean;
  enabled: boolean;
}

// ---------- the plan an import answers with ----------

/** A file chapter paired with a chapter of the target book. */
export interface ImportChapter {
  /** the target book's chapter */
  chapterId: number;
  /** the target chapter's title, as this book has it */
  title: string;
  /** the title the file gave it */
  fileTitle: string;
  /** where in the upload it came from */
  file: string;
  /**
   * The file's lines as segments: ids `1…n`, `audio` `{ status: "none", endpoint: null, ms: 0,
   * duration: 0 }`, expressions parsed back from the markers with `label`/`token`/`kind` filled from
   * the tags of the endpoint that would speak the line (a tag it does not offer arrives
   * `needsReview`), fresh `annotationId`s. Ready for `planRestore(current, segments, …)`.
   */
  segments: Segment[];
}

export type RefusalReason =
  /** no chapter of this book has these source words — the EPUB changed it, or it is another book */
  | "unmatched"
  /** the lines drift from the source by more than `fidelity` allows */
  | "fidelity"
  /** the chapter file is not valid JSON, or fails its schema */
  | "malformed";

export interface RefusedChapter {
  file: string;
  /** the file's title for it, when it could be read */
  title: string;
  words: number;
  reason: RefusalReason;
  /** one line a person can act on: the schema path that broke, or the words that are missing */
  detail: string;
}

/** The fields a speaker replace changes. */
export interface SpeakerDetails {
  gender: Gender;
  description: string;
  style: string;
}

/** A speaker both have, whose details differ. */
export interface SpeakerDiff {
  name: string;
  book: SpeakerDetails;
  file: SpeakerDetails;
}

/** The fields a term replace changes. */
export interface TermDetails {
  say: string;
  ipa?: string;
  note?: string;
  matchCase?: boolean;
  enabled: boolean;
}

export interface TermDiff {
  term: string;
  book: TermDetails;
  file: TermDetails;
}

/**
 * What the file's voice for a speaker can become here.
 *
 *   here     this install has that voice (same provider host, id and label) on an enabled endpoint;
 *            several endpoints can offer it
 *   public   not here yet, but the provider can hand it over: add `voice` to `endpointId` and use it
 *   private  a clone on someone else's account; only Keep or Replace…
 *   unchecked  the provider could not be asked in time, so whether it can hand the voice over is
 *              not known; Keep or Replace…, and the row says the lookup failed rather than calling
 *              the voice private
 */
export type VoiceMatch =
  | { kind: "here"; options: { endpointId: string; endpointName: string; ref: VoiceRef }[] }
  | { kind: "public"; endpointId: string; endpointName: string; voice: Voice }
  | { kind: "private" }
  | { kind: "unchecked"; reason: string };

export interface VoiceRow {
  speaker: string;
  /** the speaker is added by this import */
  isNew: boolean;
  /** the book's voice for them now; null = the Narrator's */
  current: VoiceRef | null;
  hint: VoiceHint;
  match: VoiceMatch;
  /** ticked on arrival: only when `isNew` or `current` is null, and only when `match` is not private */
  ticked: boolean;
  /** the recordings the file carries for this voice, when it carries any */
  samples?: VoiceRowSamples;
}

/**
 * What an import found of a voice's recordings: usable, or refused whole — a folder with one file
 * that is not audio, or over the clone limits, is refused and says why, and the lines and cast still
 * import.
 */
export type VoiceRowSamples =
  | { kind: "ok"; count: number; bytes: number }
  | { kind: "refused"; reason: string };

export interface ScriptImportPlan {
  /** the manifest's title and author; a lone chapter file has neither */
  title: string;
  author: string;
  /** the uploaded file's name, which history's "Imported from …" label reads */
  name: string;
  chapters: ImportChapter[];
  refused: RefusedChapter[];
  /** entries in the upload nothing reads, listed so a person knows they were not used */
  ignored: string[];
  cast: {
    /** speakers the book lacks, added whole when the import is applied */
    add: ScriptFileSpeaker[];
    /** speakers both have with different details; the book's are kept unless replaced */
    differ: SpeakerDiff[];
    /** aliases the file knows for a speaker the book has, unioned when applied */
    aliases: { name: string; add: string[] }[];
  };
  lexicon: {
    add: ScriptFileTerm[];
    differ: TermDiff[];
  };
  voices: VoiceRow[];
}

// ---------- voice samples waiting with a speaker ----------

/**
 * Recordings that came in a script file for a speaker whose voice is a private clone this install
 * does not have. They wait with the speaker — no provider has made a voice from them yet — until
 * someone clones them on the Voices tab or discards them.
 */
export interface SpeakerSamples {
  id: number;
  speaker: string;
  /** the voice's title where it was kept, which the clone form starts from */
  title: string;
  /** the name of the script file they came in */
  source: string;
  samples: KeptSample[];
}

/** What ticking "Include voice samples" would add to an export: one entry per speaker. */
export interface ScriptExportSamples {
  voices: { speaker: string; title: string; count: number; bytes: number }[];
}
