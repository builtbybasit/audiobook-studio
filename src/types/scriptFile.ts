// A book's script as an exported file, and the plan an import answers with before writing anything.
// Nothing here is local to one install: no segment or annotation ids, no `VoiceRef`. A voice
// travels as a hint the importer judges; expression tags travel in `text` as `{tag}` markers.
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
 * `provider` is the host of the endpoint's base URL (endpoints have no provider column);
 * `endpoint` is the endpoint's name, shown to a person and never matched on.
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
  /** the speaker in this file they are a persona of (`Character.personaOf`), by name */
  personaOf?: string;
  /** `voices/<slug>/`: the zip folder with this speaker's recordings and `samples.json` */
  samples?: string;
}

/** `voices/<slug>/samples.json`: which recordings the folder holds. */
export interface ScriptFileVoice {
  format: "audiobook-studio/voice-samples";
  version: 1;
  /** what the voice was called where it was kept */
  title: string;
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
  chapterId: number;
  /** as this book has it */
  title: string;
  /** the title the file gave it */
  fileTitle: string;
  /** path in the upload */
  file: string;
  /**
   * The file's lines as segments (ids `1…n`, no audio, fresh `annotationId`s), with expressions
   * filled from the speaking endpoint's tags; a tag it lacks arrives `needsReview`. Ready for
   * `planRestore(current, segments, …)`.
   */
  segments: Segment[];
}

export type RefusalReason =
  /** no chapter of this book has these source words: the EPUB changed, or it is another book */
  | "unmatched"
  /** the lines drift from the source by more than `fidelity` allows */
  | "fidelity"
  | "malformed";

export interface RefusedChapter {
  file: string;
  /** the file's title for it, when it could be read */
  title: string;
  words: number;
  reason: RefusalReason;
  /** actionable: the schema path that broke, or the words that are missing */
  detail: string;
}

/** The fields a speaker replace changes. */
export interface SpeakerDetails {
  gender: Gender;
  description: string;
  style: string;
}

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
 * What the file's voice for a speaker can become here:
 *   here       same provider host, id and label on an enabled endpoint (maybe several)
 *   public     the provider can hand it over: add `voice` to `endpointId`
 *   private    a clone on someone else's account; only Keep or Replace…
 *   unchecked  the provider could not be asked in time; shown as a failed lookup, not as private
 */
export type VoiceMatch =
  | { kind: "here"; options: { endpointId: string; endpointName: string; ref: VoiceRef }[] }
  | { kind: "public"; endpointId: string; endpointName: string; voice: Voice }
  | { kind: "private" }
  | { kind: "unchecked"; reason: string };

export interface VoiceRow {
  speaker: string;
  isNew: boolean;
  /** the book's voice for them now; null = none of their own */
  current: VoiceRef | null;
  hint: VoiceHint;
  match: VoiceMatch;
  /** ticked on arrival only when `isNew` or `current` is null, and `match` is not private */
  ticked: boolean;
  samples?: VoiceRowSamples;
}

/**
 * A folder with a non-audio file, or over the clone limits, is refused whole; the lines and cast
 * still import.
 */
export type VoiceRowSamples =
  | { kind: "ok"; count: number; bytes: number }
  | { kind: "refused"; reason: string };

export interface ScriptImportPlan {
  /** a lone chapter file has neither */
  title: string;
  author: string;
  /** the uploaded file's name, for history's "Imported from …" label */
  name: string;
  chapters: ImportChapter[];
  refused: RefusedChapter[];
  /** entries in the upload nothing reads */
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
 * Recordings from a script file for a speaker whose voice is a private clone not here. They wait
 * with the speaker until cloned on the Voices tab or discarded.
 */
export interface SpeakerSamples {
  id: number;
  speaker: string;
  /** the voice's title where it was kept; the clone form starts from it */
  title: string;
  /** the script file they came in */
  source: string;
  samples: KeptSample[];
}

/** What ticking "Include voice samples" would add to an export: one entry per speaker. */
export interface ScriptExportSamples {
  voices: { speaker: string; title: string; count: number; bytes: number }[];
}
