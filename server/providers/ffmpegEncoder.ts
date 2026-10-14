// The audiobook encoder: AAC in an M4B, or MP3, with chapter marks, via the installed ffmpeg
// (required at boot, `server/index.ts`). Marks come from spans counted off the clips as laid down.
// `loudnorm` runs in two passes because its one-pass form is a dynamic normaliser. MP3/Opus clips
// are decoded to WAV first: the concat demuxer reads every file as the first one's format.
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
} from "~/providers/wav";

export type FfmpegFormat = "m4b" | "mp3";

export interface FfmpegOptions {
  /** `m4b` (AAC in MP4) is the one that carries marks */
  format?: FfmpegFormat;
  /** kbps */
  bitrate?: number;
  /** integrated loudness target in LUFS; absent leaves the levels alone */
  loudness?: number;
  bin?: string;
}

const CODEC: Record<FfmpegFormat, string> = { m4b: "aac", mp3: "libmp3lame" };
const MIME: Record<FfmpegFormat, string> = { m4b: "audio/mp4", mp3: "audio/mpeg" };

/** The ffmpeg version line, or null when there is none to run. */
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

/** Throws on a non-zero exit with the log's last lines. */
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
      // the cause is in the last few lines; the rest is build info
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

/** One concat-list line, absolute: ffmpeg reads a relative path against the list's own folder. */
const listed = (path: string): string => `file '${resolve(path).replaceAll("'", "'\\''")}'`;

/**
 * The parts of one file as a concat list. A pause must be a file on disk; each distinct length is
 * written once and listed as often as needed.
 */
async function concatList(
  chapters: EncodeChapter[],
  gap: number,
  dir: string,
  format: WavFormat,
  /** clip path → the WAV it was decoded to */
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
      // Whole sample frames; see `silenceBytes`.
      const size = silenceBytes(format, key / 1000);
      const bytes = new Uint8Array(44 + size).fill(silentByte(format), 44);
      bytes.set(wavHeaderFor(format, size), 0);
      await writeFile(path, bytes);
      silences.set(key, path);
    }
    lines.push(listed(path));
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
      const path = decoded.get(part.path) ?? part.path;
      lines.push(listed(path));
      const head = readWavHeader(new Uint8Array(await Bun.file(path).arrayBuffer()));
      // A mismatched clip would play at the wrong speed rather than fail, so refuse it.
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
      // ms, not bytes: a byte offset into AAC means nothing
      start: Math.round(start * 1000),
      length: Math.round((seconds - start) * 1000),
      seconds: seconds - start,
    });
  }
  return { list: lines.join("\n"), spans, seconds };
}

/** PCM codec by bits per sample. */
const PCM: Record<number, string> = {
  8: "pcm_u8",
  16: "pcm_s16le",
  24: "pcm_s24le",
  32: "pcm_s32le",
};

const DECODERS = 4;

/** Decodes every MP3/Opus clip to a WAV in `format` under `dir`; WAV clips are left out. */
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

/** The first clip's format; an encoded clip decodes to 16 bits. */
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

/** An FFMETADATA file, one `[CHAPTER]` block per chapter. */
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
 * ffmpeg's generic keys map to both ID3 frames and iTunes atoms. The narrator goes in as composer,
 * where Apple and Audiobookshelf look; `media_type` 2 (`stik`) files an M4B as an audiobook.
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
  // passed as arguments, not through a shell, so nothing needs escaping
  return pairs
    .map(([key, value]) => [key, value.trim()] as const)
    .filter(([, value]) => value)
    .flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

export function ffmpegEncoder(options: FfmpegOptions = {}): AudiobookEncoder {
  const format = options.format ?? "m4b";
  const bin = options.bin ?? "ffmpeg";
  const bitrate = options.bitrate ?? 64;
  // an MP3 has no marks every player reads
  const markers = format === "m4b";

  return {
    name: `ffmpeg (${format}, ${CODEC[format]} ${bitrate}k)`,
    ext: format,
    mime: MIME[format],
    markers,
    normalizes: options.loudness != null,

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
        let measuredLufs: number | undefined;
        if (options.loudness != null) {
          // pass one only measures
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
          // Silence measures -inf, which pass two refuses ("Result too large"); write it as is.
          const silent = stats != null && !Number.isFinite(Number(stats.input_i));
          if (stats && !silent) measuredLufs = Number(stats.input_i);
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
        // The cover is an `attached_pic`, not a video track. ID3v2.3 is always asked for: ffmpeg's
        // default 2.4 is unreadable to Windows and older car stereos.
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
        // All inputs before any output option: ffmpeg binds an option to the next file on the line.
        args.push(
          ...(markers ? ["-map_metadata", "1", "-map_chapters", "1"] : []),
          "-map",
          "0:a",
          ...picture,
          ...(tags ? metadataArgs(tags, format) : []),
          ...(format === "mp3" ? ["-id3v2_version", "3"] : []),
          ...filter,
          // `loudnorm` resamples to 192 kHz; without this the AAC comes out at 96 kHz.
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
        return { bytes: Bun.file(out).size, seconds, chapters: spans, measuredLufs };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/** ffmpeg configured per build from the export settings; `normalize` off skips `loudnorm`. */
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
