// What building an audiobook needs from an encoder, and nothing else.
//
// The build job decides *what* goes into each output file — which chapters, in what order, with
// which silence between them — and hands that down as a list of parts. What container it lands in,
// what it costs and what it sounds like are the encoder's business, the way a line's audio is the
// speech provider's. There is one: ffmpeg (`ffmpegEncoder.ts`), which the server requires.
//
// Two things come back that the job cannot work out for itself. `seconds` is how long the file
// actually plays, which is the encoder's answer and not the estimate the plan drew, and
// `chapters` says how long each chapter in it plays.
import type { ExportSettings } from "@/types";
import type { AudiobookFiles } from "~/exports/files";

/** One piece of an output file, laid down from the book's own audio in order. */
export type EncodePart =
  /** a rendered clip, by the path its file is kept at; its extension says its format */
  | { kind: "clip"; path: string }
  /** silence: the book's pacing inside a chapter, or the export's gap between two */
  | { kind: "silence"; seconds: number };

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
   * null or absent for none.
   */
  cover?: { path: string; type: "image/jpeg" | "image/png" } | null;
  /**
   * What the file says about itself — title, author, narrator — for a player's library to list
   * it by rather than by its file name.
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

/** Where one chapter ended up in its file, and how long it plays. */
export interface EncodedChapter {
  id: number;
  start: number;
  length: number;
  seconds: number;
}

export interface EncodedFile {
  /** the size on disk */
  bytes: number;
  /** how long it plays, as written rather than as estimated */
  seconds: number;
  chapters: EncodedChapter[];
  /**
   * The integrated loudness of what went in, LUFS, where the encoder measured it before levelling
   * it to the build's target; absent when nothing was measured.
   */
  measuredLufs?: number;
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
