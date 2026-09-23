// What building an audiobook needs from an encoder, and nothing else.
//
// The build job decides *what* goes into each output file — which chapters, in what order, with
// which silence between them, and which of them can be copied out of the version already on disk
// — and hands that down as a list of parts. What container it lands in, what it costs and what it
// sounds like are the encoder's business, the way a line's audio is the speech provider's.
//
// Two things come back that the job cannot work out for itself. `seconds` is how long the file
// actually plays, which is the encoder's answer and not the estimate the plan drew. `chapters`
// says where each chapter landed inside the file, and that is what makes an update cheap: the
// next build copies those spans straight across for every chapter whose audio has not moved,
// instead of reading its clips again.
import type { ExportSettings } from "@/types";
import type { AudiobookFiles } from "~/exports/files";

/** A piece of an output file laid down from the book's own audio. */
export type FreshPart =
  /** a rendered clip, by the path its file is kept at; its extension says its format */
  | { kind: "clip"; path: string }
  /** silence: the book's pacing inside a chapter, or the export's gap between two */
  | { kind: "silence"; seconds: number };

/** One piece of an output file, in the order it is laid down. */
export type EncodePart =
  | FreshPart
  /**
   * A span of a file this export supersedes, copied rather than encoded again — or, if that file
   * is gone by the time it is read, `instead`: the same chapter from its clips. The version it
   * comes from can be removed while the build runs, and that costs the chapter its shortcut
   * rather than costing the build.
   */
  | { kind: "carry"; path: string; start: number; length: number; instead: FreshPart[] };

export interface EncodeChapter {
  id: number;
  title: string;
  parts: EncodePart[];
}

export interface EncodeInput {
  /** the chapters of one output file, in reading order */
  chapters: EncodeChapter[];
  /** seconds of silence between two chapters; there is none after the last */
  gap: number;
  /** where to write it */
  out: string;
  /** aborted when the build is cancelled or the server is stopping; check it between parts */
  signal: AbortSignal;
  /**
   * The picture to carry as the audiobook's cover, already checked to be a JPEG or a PNG on disk;
   * null or absent for none. An encoder that `covers` nothing is not handed one.
   */
  cover?: { path: string; type: "image/jpeg" | "image/png" } | null;
  /**
   * What the file says about itself — title, author, narrator — for a player's library to list
   * it by rather than by its file name. An encoder that `tags` nothing is not handed any.
   */
  tags?: EncodeTags | null;
  /**
   * Called as each chapter lands, so the Queue can count a long file down rather than showing
   * nothing between "writing" and "written".
   */
  onChapter?(chapter: EncodedChapter, index: number): void;
}

/**
 * The words a file carries about itself, in the book's terms rather than a container's: which
 * ID3 frame or MP4 atom each one lands in is the encoder's business. A blank field is left out
 * rather than written empty.
 */
export interface EncodeTags {
  /** this file's own title: the book's, a volume's or a chapter's, as the plan named it */
  title: string;
  /** the whole audiobook's title, which is what groups a set of files as one book */
  book: string;
  author: string;
  narrator: string;
  series: string;
  /** 0 for none */
  year: number;
  description: string;
  /** where this file falls in a file-per-chapter set */
  track?: { n: number; of: number };
  /** where this file falls in a file-per-volume set */
  disc?: { n: number; of: number };
}

/** Where one chapter ended up, so the next version of this audiobook can copy it. */
export interface EncodedChapter {
  id: number;
  start: number;
  length: number;
  seconds: number;
  /** a chapter planned as a carry whose file was gone, so it was laid down from its clips */
  readAgain?: boolean;
}

export interface EncodedFile {
  /** the size on disk */
  bytes: number;
  /** how long it plays, as written rather than as estimated */
  seconds: number;
  chapters: EncodedChapter[];
}

export interface AudiobookEncoder {
  readonly name: string;
  /** the extension the files it writes carry */
  readonly ext: string;
  /** what the download is served as */
  readonly mime: string;
  /** whether it writes chapter marks a player can read */
  readonly markers: boolean;
  /**
   * Whether it measures and corrects loudness when the build asks for it.
   *
   * The page offers a target in LUFS; an encoder that only stitches cannot honour it, and the
   * build says which of the two happened rather than leaving the panel's promise standing.
   */
  readonly normalizes: boolean;
  /**
   * Whether a span of a file it wrote can be copied into the next version of it.
   *
   * True of the stitcher, whose output is raw samples: a chapter that has not moved is the same
   * bytes in the same order, and copying them is exactly what "carried over rather than encoded
   * again" says. False of a lossy encoder, where splicing an already-encoded span beside freshly
   * encoded audio needs both to have been encoded identically — the way to do it is to keep a
   * file per chapter and join those, which is a different arrangement on disk from the one this
   * server has. An encoder that says no is handed no `carry` parts and re-encodes every chapter,
   * and the build says so rather than reporting chapters it did not really reuse.
   */
  readonly carries: boolean;
  /**
   * Whether it writes a cover picture into the file. An M4B has an atom for one and an MP3 a
   * picture frame; a RIFF file has nowhere every player looks, so the stitcher writes none and the
   * build says so rather than leaving the page's "embedded in every file" standing.
   */
  readonly covers: boolean;
  /**
   * Whether it writes title, author and the rest into the file. An MP3 has ID3 frames for them and
   * an M4B the atoms a phone's audiobook app reads; the stitcher writes a bare RIFF header, and
   * the build says so rather than leaving the page's book details looking written.
   */
  readonly tags: boolean;
  /**
   * Whether it reads MP3 and Opus clips as well as WAV. The stitcher joins samples and has none to
   * join in an encoded clip, so a build of a book narrated in either is refused, by chapter, before
   * a byte is written; ffmpeg decodes each one first and builds from any mix.
   */
  readonly decodes: boolean;
  encode(input: EncodeInput): Promise<EncodedFile>;
}

/**
 * What this server can write audiobooks with.
 *
 * The encoder is chosen per build rather than once at boot, because the format is the listener's
 * choice and lives in the settings: an M4B and an MP3 of the same book are two different
 * encoders' work. A server whose encoder cannot honour the format asked for answers with the one
 * it has, and the build says so in its log rather than writing a `.m4b` that is not one.
 */
export interface EncoderChoice {
  /** what this server can write, for the boot log */
  readonly name: string;
  /** The encoder for one build's settings. */
  for(settings: ExportSettings): AudiobookEncoder;
}

/** Both halves of building a file: somewhere to put it, and something to write it. */
export interface ExportPorts {
  encoders: EncoderChoice;
  files: AudiobookFiles;
}
