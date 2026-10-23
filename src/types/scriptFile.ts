// A book's script as an exported file, and the plan an import answers with before writing anything.
// Nothing here is local to one install: no segment or annotation ids, no `VoiceRef`. A voice
// travels as a hint the importer judges; expression tags travel in `text` as `{tag}` markers.
import type { BookPrompt } from "@/types/scripting";
import type { CharacterVoice, GenderSlot, Pacing } from "@/types/book";
import type { Age, Gender, VoiceRef } from "@/types/common";
import type { Step } from "@/types/effect";
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
  /** line effects by effect name: ids are local to an install (`effects.json` defines them) */
  effects?: string[];
}

/** `chapters/NNNN-slug.json` — complete on its own, so it can be imported without the zip. */
export interface ScriptFileChapter {
  format: "audiobook-studio/script-chapter";
  version: 2;
  title: string;
  /** `sha256:<hex>` over the chapter's source words, from the one shared `sourceHash` */
  sourceHash: string;
  words: number;
  lines: ScriptFileLine[];
  /** where the chapter leaves off, as the scripting model summed it up; the next one's context */
  recap?: string;
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
  version: 2;
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
  /** `Character.speed`; absent = their voice's */
  speed?: number;
  color?: string;
  major?: boolean;
  voice?: VoiceHint;
  /** the speaker in this file they are a persona of (`Character.personaOf`), by name */
  personaOf?: string;
  /** `voices/<slug>/`: the zip folder with this speaker's recordings and `samples.json` */
  samples?: string;
  /** the effect they wear, by name */
  effect?: string;
  /** their thought effect: an effect name or `"none"` */
  thoughts?: string;
}

/** One entry of `effects.json`: every library effect the file's lines, speakers and book name. */
export interface ScriptFileEffect {
  name: string;
  chain: Step[];
  useWhen?: string;
}

/**
 * `book.json`: the book's own settings that shape its script and reading. Budgets and check-by-ear
 * stay with the install. A voice travels as a hint, an effect by name.
 */
export interface ScriptFileBook {
  pacing?: Pacing;
  prompt?: BookPrompt;
  readNotes?: boolean;
  /** an effect name or `"none"` */
  thoughts?: string;
  characterVoice?: {
    by: CharacterVoice["by"];
    one?: VoiceHint;
    male?: VoiceHint;
    female?: VoiceHint;
    other?: VoiceHint;
    ages?: { slot: GenderSlot; age: Age; voice: VoiceHint }[];
  };
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
   * `planRestore(current, segments, …)`. `effects` hold local ids, or `NEW_EFFECT + name` for an
   * effect in `plan.effects.add` (the apply step swaps in the id it creates, or drops it).
   */
  segments: Segment[];
  /**
   * `source`: the book has the very words the script was made from. `text`: no chapter had them,
   * so this one was picked by overlap; its lines were moved onto the book's words.
   */
  pairedBy: "source" | "text";
  /** for `text`: source words missing plus added between the file's chapter and this one */
  wordsDiffer?: number;
  /** for `text`: ids (in `segments`) of lines whose words were changed to this book's */
  retexted?: number[];
  /** the file's recap for the chapter, written with its script */
  recap?: string;
  /** with `recap`: the chapter's own now ("" for none), which an Undo writes back */
  recapBefore?: string;
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
  /** absent = their voice's */
  speed?: number;
  /** effect names, as the file writes them; absent = none of their own */
  effect?: string;
  thoughts?: string;
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
  /** effects are matched by name; everything in the plan names them as the file does */
  effects: {
    /** file effects this library has by name; `sameChain` false = the library's chain is kept */
    known: { name: string; id: string; sameChain: boolean }[];
    /** file effects the library lacks, added to the library (for all books) when ticked */
    add: ScriptFileEffect[];
    /** names used in the file that neither it nor the library defines; dropped */
    missing: string[];
  };
  /** absent when the file has no `book.json` or nothing in it differs; applied only when ticked */
  book?: {
    file: ImportBookSettings;
    /** the settings that differ from this book's */
    differ: (keyof ScriptFileBook)[];
  };
}

/** `book.json` as this install can apply it: voices resolved, effects by name. */
export interface ImportBookSettings {
  pacing?: Pacing;
  prompt?: BookPrompt;
  readNotes?: boolean;
  /** an effect name or `"none"` */
  thoughts?: string;
  /** only slots whose hint matched a voice here (`VoiceMatch` "here"); the rest are null */
  characterVoice?: CharacterVoice;
  /** slots whose voice is not on this install; `age` for a gender's voice for one age */
  unmatchedVoices?: { slot: "one" | GenderSlot; age?: Age }[];
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
