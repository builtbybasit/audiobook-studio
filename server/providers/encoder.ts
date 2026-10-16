// The encoder port. The build job decides which parts go in each file; the container, cost and
// sound are the encoder's (`ffmpegEncoder.ts`). It answers how long the file and each chapter in it
// actually play.
import type { ExportSettings } from "@/types";
import type { AudiobookFiles } from "~/exports/files";

export type EncodePart =
  /** its extension says its format */
  | { kind: "clip"; path: string }
  /** pacing inside a chapter, or the export's gap between two */
  | { kind: "silence"; seconds: number };

export interface EncodeChapter {
  id: number;
  title: string;
  parts: EncodePart[];
}

export interface EncodeInput {
  /** in reading order */
  chapters: EncodeChapter[];
  /** seconds of silence between two chapters; none after the last */
  gap: number;
  out: string;
  signal: AbortSignal;
  /** already checked to be a JPEG or PNG on disk */
  cover?: { path: string; type: "image/jpeg" | "image/png" } | null;
  tags?: EncodeTags | null;
  /** called as each chapter lands, for the Queue's progress */
  onChapter?: (chapter: EncodedChapter, index: number) => void;
}

/** In the book's terms; the ID3 frame or MP4 atom is the encoder's. A blank field is left out. */
export interface EncodeTags {
  /** this file's own title: the book's, a volume's or a chapter's */
  title: string;
  /** groups a set of files as one book */
  book: string;
  author: string;
  narrator: string;
  series: string;
  /** 0 for none */
  year: number;
  description: string;
  /** place in a file-per-chapter set */
  track?: { n: number; of: number };
  /** place in a file-per-volume set */
  disc?: { n: number; of: number };
}

/** Where one chapter landed in its file. */
export interface EncodedChapter {
  id: number;
  start: number;
  length: number;
  seconds: number;
}

export interface EncodedFile {
  bytes: number;
  /** as written, not as estimated */
  seconds: number;
  chapters: EncodedChapter[];
  /** LUFS of the input, where it was measured before levelling */
  measuredLufs?: number;
  /** what levelling did, as the encoder reported it: one gain or a dynamic normaliser, peaks limited by `limited` dB first */
  levelled?: { linear: boolean; lufs: number; limited: number };
}

export interface AudiobookEncoder {
  readonly name: string;
  readonly ext: string;
  readonly mime: string;
  /** whether it writes chapter marks a player can read */
  readonly markers: boolean;
  /** whether it measures and corrects loudness, so the build can say which happened */
  readonly normalizes: boolean;
  encode(input: EncodeInput): Promise<EncodedFile>;
}

/** Chosen per build: the format lives in the settings. */
export interface EncoderChoice {
  /** for the boot log */
  readonly name: string;
  for(settings: ExportSettings): AudiobookEncoder;
}

export interface ExportPorts {
  encoders: EncoderChoice;
  files: AudiobookFiles;
}
