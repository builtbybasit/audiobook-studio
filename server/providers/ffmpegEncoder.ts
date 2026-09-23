// An encoder that writes a real audiobook: AAC in an M4B, or MP3, with chapter marks a player
// reads, using an ffmpeg already installed on the machine.
//
// It is the first thing in this server that depends on something outside it, so the dependency is
// declared rather than discovered: `EXPORT_ENCODER=ffmpeg` fails at boot with a sentence naming
// the binary if it is not on `PATH`, instead of every build failing later with a spawn error. The
// default stays `wav`, which needs nothing, so a fresh clone and the test suite never depend on a
// binary being installed.
//
// **Three things ffmpeg does here that the stitcher cannot.**
//
// *Chapter marks.* An M4B's marks are a chapter list in the container, and the way to write one
// is an FFMETADATA file: `[CHAPTER]` blocks with a timebase and a start and end in it. The spans
// come out of the same lay-down the stitcher records, so a mark falls exactly where the chapter
// starts in the file and not at an estimate of where it should.
//
// *Loudness.* `loudnorm` is EBU R128, and it is run in two passes — measure, then correct with
// the measurements — because the single-pass form is a dynamic normaliser that changes how the
// reading sounds. The Export page's Loudness panel invents its numbers from a voice's identity;
// these are measured off the audio.
//
// *A container people's players open.* The clips go in as one concat stream, the silence with
// them, and what comes out is an `.m4b` an app will read as an audiobook.
//
// **Clips in MP3 or Opus are decoded first.** The concat demuxer reads every file in its list as the
// first one's format, and the spans and the silence are counted in samples, so every clip is made a
// WAV in the file's format before the list is drawn: one `ffmpeg` per encoded clip, a few at once,
// into the build's own work directory. After that the list, the rate check, the spans and the
// silence are exactly what they are for a book narrated in WAV, and a book narrated in a mix of
// the three builds the same way. The file's format is the first clip's — its header for a WAV,
// what `probeClip` reads for the others, at 16 bits.
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExportSettings } from "@/types";
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type {
  AudiobookEncoder,
  EncodeChapter,
  EncodeInput,
  EncodeTags,
  EncodedChapter,
  EncodedFile,
  EncoderChoice,
} from "~/providers/encoder";
import {
  byteRate,
  formatLabel,
  readWavHeader,
  silenceBytes,
  silentByte,
  type WavFormat,
} from "~/providers/wavEncoder";

export type FfmpegFormat = "m4b" | "mp3";

export interface FfmpegOptions {
  /** what to write; `m4b` is AAC in an MP4 container, which is the one that carries marks */
  format?: FfmpegFormat;
  /** kbps */
  bitrate?: number;
  /** integrated loudness to correct to, in LUFS; absent means leave the levels alone */
  loudness?: number;
  /** the binary, for a machine that keeps it somewhere of its own */
  bin?: string;
}

const CODEC: Record<FfmpegFormat, string> = { m4b: "aac", mp3: "libmp3lame" };
const MIME: Record<FfmpegFormat, string> = { m4b: "audio/mp4", mp3: "audio/mpeg" };

/** Is there an ffmpeg to run? Asked once at boot so a misconfiguration is not a failed build. */
export async function ffmpegAvailable(bin = "ffmpeg"): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "-version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out.split("\n")[0]?.trim() || bin;
  } catch {
    return null;
  }
}

/** Run it, and turn a non-zero exit into an error carrying the part of the log that explains it. */
async function run(
  bin: string,
  args: string[],
  signal: AbortSignal,
  failed = "ffmpeg could not write the file",
): Promise<string> {
  const proc = Bun.spawn([bin, "-nostdin", "-hide_banner", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const abort = (): void => proc.kill();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (signal.aborted) throw signal.reason;
    if (code !== 0) {
      // ffmpeg says what went wrong in its last few lines; the rest is the build it was compiled
      // with, which is of no use to anybody reading a failed job.
      const why = stderr.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(`${failed}${why ? `: ${why}` : ""}`);
    }
    return stderr;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** The measurements `loudnorm`'s first pass prints, as its second pass wants them back. */
function measured(stderr: string): Record<string, string> | null {
  const at = stderr.lastIndexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(stderr.slice(at, stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * The parts of one file as a concat list, with the silence written out as real files.
 *
 * ffmpeg's concat demuxer takes a list of paths, so a pause has to be something on disk. They are
 * short and there are few distinct lengths in a book — a line gap, a turn gap, a chapter gap — so
 * each length is written once and named as often as it is needed.
 */
async function concatList(
  chapters: EncodeChapter[],
  gap: number,
  dir: string,
  format: WavFormat,
  /** the WAV each encoded clip was decoded to, by the clip's own path */
  decoded: Map<string, string>,
): Promise<{ list: string; spans: EncodedChapter[]; seconds: number }> {
  const lines: string[] = [];
  const spans: EncodedChapter[] = [];
  const silences = new Map<number, string>();
  let seconds = 0;

  const silence = async (length: number): Promise<void> => {
    if (length <= 0) return;
    const key = Math.round(length * 1000);
    let path = silences.get(key);
    if (!path) {
      path = join(dir, `silence-${key}.wav`);
      // Whole sample frames, as the stitcher writes them; see `silenceBytes`.
      const size = silenceBytes(format, key / 1000);
      const bytes = new Uint8Array(44 + size).fill(silentByte(format), 44);
      bytes.set(wavHeaderFor(format, size), 0);
      await writeFile(path, bytes);
      silences.set(key, path);
    }
    lines.push(`file '${path.replaceAll("'", "'\\''")}'`);
    seconds += key / 1000;
  };

  for (const [i, chapter] of chapters.entries()) {
    if (i > 0) await silence(gap);
    const start = seconds;
    for (const part of chapter.parts) {
      if (part.kind === "silence") {
        await silence(part.seconds);
        continue;
      }
      // `carries: false`, so the build hands this encoder clips and silence and nothing else.
      if (part.kind === "carry")
        throw new Error("this encoder cannot copy a span out of an audiobook it already wrote");
      const path = decoded.get(part.path) ?? part.path;
      lines.push(`file '${path.replaceAll("'", "'\\''")}'`);
      const head = readWavHeader(new Uint8Array(await Bun.file(path).arrayBuffer()));
      // The concat demuxer reads every file as the first one's format, so a clip at another rate
      // would play at the wrong speed rather than fail. The stitcher refuses it; so does this.
      if (
        head.channels !== format.channels ||
        head.sampleRate !== format.sampleRate ||
        head.bits !== format.bits
      )
        throw new Error(
          `${part.path} is ${formatLabel(head)} and this file is ${formatLabel(format)}`,
        );
      seconds += head.length / byteRate(head);
    }
    spans.push({
      id: chapter.id,
      // A position in *time* here, because a byte offset into an AAC stream means nothing. It is
      // where the chapter's mark goes, rather than something the next version copies out.
      start: Math.round(start * 1000),
      length: Math.round((seconds - start) * 1000),
      seconds: seconds - start,
    });
  }
  return { list: lines.join("\n"), spans, seconds };
}

/** The PCM codec that writes samples of this many bits, as a WAV holds them. */
const PCM: Record<number, string> = {
  8: "pcm_u8",
  16: "pcm_s16le",
  24: "pcm_s24le",
  32: "pcm_s32le",
};

/** How many clips are decoded at once: enough to hide a process's start-up, few enough to share. */
const DECODERS = 4;

/**
 * Every MP3 or Opus clip in these chapters as a WAV in `format`, written into `dir`: the map from
 * each clip's path to its WAV's. A WAV clip is not in it and is read where it is kept.
 */
async function decodeClips(
  bin: string,
  chapters: EncodeChapter[],
  format: WavFormat,
  dir: string,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const encoded = [
    ...new Set(
      chapters.flatMap((c) =>
        c.parts.flatMap((p) =>
          p.kind === "clip" && (formatOfFile(p.path) ?? "wav") !== "wav" ? [p.path] : [],
        ),
      ),
    ),
  ];
  const codec = PCM[format.bits];
  if (encoded.length && !codec)
    throw new Error(
      `this file is ${formatLabel(format)}, which an MP3 or Opus clip cannot be decoded to`,
    );
  const decoded = new Map<string, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < encoded.length) {
      if (signal.aborted) throw signal.reason;
      const clip = encoded[next];
      const wav = join(dir, `clip-${next++}.wav`);
      await run(
        bin,
        [
          "-i",
          clip,
          "-vn",
          "-map_metadata",
          "-1",
          "-ar",
          String(format.sampleRate),
          "-ac",
          String(format.channels),
          "-c:a",
          codec,
          "-f",
          "wav",
          "-y",
          wav,
        ],
        signal,
        `ffmpeg could not decode ${clip}`,
      );
      decoded.set(clip, wav);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DECODERS, encoded.length) }, worker));
  return decoded;
}

/** The format of the file being built: the first clip's, read from its header or its stream. */
async function sourceFormat(path: string): Promise<WavFormat> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const kept = formatOfFile(path) ?? "wav";
  if (kept === "wav") {
    const head = readWavHeader(bytes);
    return { channels: head.channels, sampleRate: head.sampleRate, bits: head.bits };
  }
  try {
    const info = await probeClip(bytes, kept);
    return { channels: info.channels, sampleRate: info.sampleRate, bits: 16 };
  } catch (e) {
    throw new Error(`${path} could not be read as audio: ${(e as Error).message}`, { cause: e });
  }
}

/** The 44 bytes a generated silence file needs in front of it. */
function wavHeaderFor(f: WavFormat, samples: number): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.sampleRate, true);
  view.setUint32(28, byteRate(f), true);
  view.setUint16(32, (f.channels * f.bits) / 8, true);
  view.setUint16(34, f.bits, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  return bytes;
}

/** An FFMETADATA file: the marks a player shows, one block per chapter. */
function chapterMetadata(chapters: EncodeChapter[], spans: EncodedChapter[]): string {
  const title = new Map(chapters.map((c) => [c.id, c.title]));
  const lines = [";FFMETADATA1"];
  for (const s of spans) {
    lines.push(
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${s.start}`,
      `END=${s.start + s.length}`,
      // `=`, `;`, `#`, `\` and a newline are the escapes this format asks for.
      `title=${(title.get(s.id) ?? "").replaceAll(/([=;#\\\n])/g, "\\$1")}`,
    );
  }
  return lines.join("\n");
}

/**
 * The book's words as `-metadata` options. ffmpeg's generic keys are what it spells as ID3 frames
 * in an MP3 and as iTunes atoms in an MP4 — `album` is TALB and ©alb, `composer` TCOM and ©wrt —
 * so one list serves both. The narrator goes in as the composer, which is where Apple's and
 * Audiobookshelf's readers look for one; the series as the grouping. An M4B is also marked as an
 * audiobook (`stik` 2) rather than as music, so a phone files it with its books.
 */
function metadataArgs(tags: EncodeTags, format: FfmpegFormat): string[] {
  const pairs: [string, string][] = [
    ["title", tags.title],
    ["album", tags.book],
    ["artist", tags.author],
    ["album_artist", tags.author],
    ["composer", tags.narrator],
    ["grouping", tags.series],
    ["date", tags.year > 0 ? String(tags.year) : ""],
    ["comment", tags.description],
    ["description", tags.description],
    ["genre", "Audiobook"],
    ["track", tags.track ? `${tags.track.n}/${tags.track.of}` : ""],
    ["disc", tags.disc ? `${tags.disc.n}/${tags.disc.of}` : ""],
  ];
  if (format === "m4b") pairs.push(["media_type", "2"]);
  // Handed over as arguments rather than through a shell or a metadata file, so nothing in them
  // needs escaping.
  return pairs
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value)
    .flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

export function ffmpegEncoder(options: FfmpegOptions = {}): AudiobookEncoder {
  const format = options.format ?? "m4b";
  const bin = options.bin ?? "ffmpeg";
  const bitrate = options.bitrate ?? 64;
  // An MP4 carries a chapter list; an MP3 has no marks every player reads, which is exactly what
  // the Export page's format hint already says.
  const markers = format === "m4b";

  return {
    name: `ffmpeg (${format}, ${CODEC[format]} ${bitrate}k)`,
    ext: format,
    mime: MIME[format],
    markers,
    normalizes: options.loudness != null,
    // A span of AAC cannot be spliced beside audio encoded in this run; see `carries` on the port.
    carries: false,
    // An MP4 cover atom and an MP3 picture frame both take the JPEG or PNG as it is.
    covers: true,
    // An MP3's ID3 frames and an M4B's atoms both have a place for every field the page asks for.
    tags: true,
    // Every clip that is not a WAV is decoded to one first; see the top of this file.
    decodes: true,

    async encode({
      chapters,
      gap,
      out,
      signal,
      onChapter,
      cover,
      tags,
    }: EncodeInput): Promise<EncodedFile> {
      const first = chapters.flatMap((c) => c.parts).find((p) => p.kind !== "silence");
      if (!first) throw new Error("there was nothing to write");
      const source = await sourceFormat(first.path);

      const work = join(tmpdir(), `audiobook-ffmpeg-${crypto.randomUUID()}`);
      await Bun.write(join(work, ".keep"), "");
      try {
        const decoded = await decodeClips(bin, chapters, source, work, signal);
        const { list, spans, seconds } = await concatList(chapters, gap, work, source, decoded);
        const listPath = join(work, "concat.txt");
        await writeFile(listPath, list);
        const input = ["-f", "concat", "-safe", "0", "-i", listPath];

        let filter: string[] = [];
        if (options.loudness != null) {
          // Pass one measures; nothing is written, so the output goes nowhere.
          const stats = measured(
            await run(
              bin,
              [
                ...input,
                "-af",
                `loudnorm=I=${options.loudness}:TP=-1.5:LRA=11:print_format=json`,
                "-f",
                "null",
                "-",
              ],
              signal,
            ),
          );
          // Silence measures as -inf, which the second pass refuses outright ("Result too large");
          // there is nothing in it to level, so it is written as it is.
          const silent = stats != null && !Number.isFinite(Number(stats.input_i));
          filter = silent
            ? []
            : [
                "-af",
                stats
                  ? `loudnorm=I=${options.loudness}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`
                  : `loudnorm=I=${options.loudness}:TP=-1.5:LRA=11`,
              ];
        }

        const args = [...input];
        if (markers) {
          await writeFile(join(work, "chapters.txt"), chapterMetadata(chapters, spans));
          args.push("-i", join(work, "chapters.txt"));
        }
        // The cover is one more input, copied in untouched and marked as the file's picture rather
        // than a video track — which is what a player reads as cover art. An MP3 gets the frame
        // spelled the way ID3v2.3 readers expect: a front cover, described as one.
        //
        // ID3v2.3 is asked for whether or not there is a picture: ffmpeg's default is 2.4, which
        // Windows and older car stereos do not read, and a title nobody can see is not a title.
        const picture: string[] = [];
        if (cover) {
          args.push("-i", cover.path);
          picture.push(
            "-map",
            `${markers ? 2 : 1}:v`,
            "-c:v",
            "copy",
            "-disposition:v:0",
            "attached_pic",
            ...(format === "mp3"
              ? ["-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
              : []),
          );
        }
        // Every input is named before any option of the output: ffmpeg reads an option as belonging
        // to the next file on the line, and the chapter list's mapping in front of the cover's `-i`
        // is read as an option of the cover.
        args.push(
          ...(markers ? ["-map_metadata", "1", "-map_chapters", "1"] : []),
          "-map",
          "0:a",
          ...picture,
          ...(tags ? metadataArgs(tags, format) : []),
          ...(format === "mp3" ? ["-id3v2_version", "3"] : []),
          ...filter,
          // At the clips' own rate. `loudnorm` resamples to 192 kHz inside, and left to itself the
          // encoder then picks the nearest rate it has — 96 kHz AAC out of 44.1 kHz speech, a file
          // twice the size for nothing anyone can hear.
          "-ar",
          String(source.sampleRate),
          "-c:a",
          CODEC[format],
          "-b:a",
          `${bitrate}k`,
          ...(format === "m4b" ? ["-f", "mp4", "-movflags", "+faststart"] : []),
          "-y",
          out,
        );
        await run(bin, args, signal);

        for (const [i, span] of spans.entries()) onChapter?.(span, i);
        return { bytes: Bun.file(out).size, seconds, chapters: spans };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/**
 * ffmpeg, following the settings.
 *
 * The format, the bitrate and the loudness target are the listener's, so they are read off each
 * build rather than fixed at boot: the same server writes an M4B for one audiobook and an MP3 for
 * the next. `normalize` off means no `loudnorm` at all, which is the difference between "the
 * levels were left alone" and "they were measured and found already right".
 */
export const ffmpegEncoders = (bin = "ffmpeg"): EncoderChoice => ({
  name: `ffmpeg (${bin})`,
  for: (settings: ExportSettings) =>
    ffmpegEncoder({
      format: settings.format,
      bitrate: settings.bitrate,
      ...(settings.normalize ? { loudness: settings.loudness } : {}),
      bin,
    }),
});
