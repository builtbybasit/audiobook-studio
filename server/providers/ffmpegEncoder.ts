// The audiobook encoder: AAC in an M4B, or MP3, with chapter marks, via the installed ffmpeg
// (required at boot, `server/index.ts`). The clips go in as one raw PCM stream on stdin, a few
// decoded ahead, so the only thing on temporary disk is the encoded audio; marks are counted off
// that stream. `loudnorm` runs in two passes because its one-pass form is a dynamic normaliser.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExportSettings } from "@/types";
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import { inBackground } from "~/lib/background";
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
  /** write chapter marks where the format has them; on unless turned off */
  markers?: boolean;
  bin?: string;
}

const CODEC: Record<FfmpegFormat, string> = { m4b: "aac", mp3: "libmp3lame" };
const MIME: Record<FfmpegFormat, string> = { m4b: "audio/mp4", mp3: "audio/mpeg" };
/** ffmpeg's raw PCM format by bits per sample. */
const RAW: Record<number, string> = { 8: "u8", 16: "s16le", 24: "s24le", 32: "s32le" };
/** clips decoding while the encoder takes the one before */
const AHEAD = 4;
/** `<prefix><pid>-<uuid>`: the pid says whether the process that made it is still alive */
const WORK = "audiobook-ffmpeg-";
/** the true-peak ceiling loudnorm levels to */
const TP = -1.5;

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

/** A chunk source as a pull stream, so ffmpeg's pace sets how far ahead it is read. */
function pulled(
  chunks: AsyncIterator<Uint8Array>,
  failed: (e: unknown) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const r = await chunks.next();
          if (r.done) c.close();
          else c.enqueue(r.value);
        } catch (e) {
          failed(e);
          c.close();
        }
      },
      cancel() {
        void chunks.return?.(undefined);
      },
    },
    { highWaterMark: 2 },
  );
}

/**
 * Throws on a non-zero exit with the log's last lines, or with why `input` stopped: a feed that
 * fails ends ffmpeg's stdin early, and the file it finished would be short.
 */
async function run(
  bin: string,
  args: string[],
  signal: AbortSignal,
  {
    failed = "ffmpeg could not write the file",
    input,
    output = false,
  }: { failed?: string; input?: AsyncIterator<Uint8Array>; output?: boolean } = {},
): Promise<{ log: string; out: Uint8Array | null }> {
  const feed: { error?: unknown } = {};
  const proc = Bun.spawn([bin, "-nostdin", "-hide_banner", ...args], {
    stdin: input
      ? pulled(input, (e) => {
          feed.error = e ?? new Error("the audio could not be read");
          proc.kill();
        })
      : "ignore",
    stdout: output ? "pipe" : "ignore",
    stderr: "pipe",
  });
  const abort = (): void => proc.kill();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const [log, out] = await Promise.all([
      new Response(proc.stderr).text(),
      output ? new Response(proc.stdout as ReadableStream).bytes() : null,
    ]);
    const code = await proc.exited;
    if (signal.aborted) throw signal.reason;
    if (feed.error) throw feed.error;
    if (code !== 0) {
      // the cause is in the last few lines; the rest is build info
      const why = log.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(`${failed}${why ? `: ${why}` : ""}`);
    }
    return { log, out };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** The figures `loudnorm` prints at the end of a pass. */
function loudnormStats(log: string): Record<string, string> | null {
  const at = log.lastIndexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(log.slice(at, log.lastIndexOf("}") + 1)) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Pass two: one linear gain to the target. Linear mode needs the raised peaks under `TP` and the
 * range under its LRA target, or loudnorm quietly goes dynamic; so the range target is the one
 * measured, and peaks the gain would push over are limited first. The limiter sees samples, not
 * true peaks, hence the half-dB margin; it cannot go below −24 dB.
 */
function levelling(target: number, m: Record<string, string>): { filter: string; limited: number } {
  const peak = Number(m.input_tp);
  const gain = target - Number(m.input_i);
  const ceiling = peak + gain > TP ? Math.max(-24, TP - gain - 0.5) : null;
  const loudnorm = [
    `loudnorm=I=${target}:TP=${TP}:LRA=${Math.min(50, Math.max(11, Math.ceil(Number(m.input_lra))))}`,
    `measured_I=${m.input_i}:measured_TP=${ceiling ?? peak}`,
    // 0 reads as "not measured", which rules linear out
    `measured_LRA=${Math.max(0.01, Number(m.input_lra))}:measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}:linear=true:print_format=json`,
  ].join(":");
  return {
    filter:
      ceiling == null
        ? loudnorm
        : `alimiter=limit=${10 ** (ceiling / 20)}:level=false:latency=true,${loudnorm}`,
    limited: ceiling == null ? 0 : peak - ceiling,
  };
}

/** One clip's samples in `f`: a WAV's own, anything else (and 32-bit, maybe float) via ffmpeg. */
async function readClip(
  bin: string,
  path: string,
  f: WavFormat,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if ((formatOfFile(path) ?? "wav") === "wav" && f.bits !== 32) {
    const bytes = await Bun.file(path).bytes();
    const head = readWavHeader(bytes);
    // A mismatched clip would play at the wrong speed rather than fail, so refuse it.
    if (head.channels !== f.channels || head.sampleRate !== f.sampleRate || head.bits !== f.bits)
      throw new Error(`${path} is ${formatLabel(head)} and this file is ${formatLabel(f)}`);
    // whole frames only, though a header may claim more than the file holds
    const frame = (f.channels * f.bits) / 8;
    const length = Math.min(head.length, bytes.byteLength - head.start);
    return bytes.subarray(head.start, head.start + length - (length % frame));
  }
  const { out } = await run(
    bin,
    [
      "-i",
      path,
      "-vn",
      "-ar",
      String(f.sampleRate),
      "-ac",
      String(f.channels),
      "-f",
      RAW[f.bits],
      "-",
    ],
    signal,
    { failed: `ffmpeg could not decode ${path}`, output: true },
  );
  return out!;
}

/** What one pass over the samples has sent: each chapter's span, and the total. */
interface Sent {
  spans: EncodedChapter[];
  bytes: number;
}

/**
 * Every chapter's samples in order, with the gap between two and the pauses as silence, as one
 * raw stream. `onChapter` fires as a chapter's last byte goes in, so a one-file build moves too.
 */
async function* samples(
  chapters: EncodeChapter[],
  gap: number,
  f: WavFormat,
  read: (path: string) => Promise<Uint8Array>,
  sent: Sent,
  onChapter?: EncodeInput["onChapter"],
): AsyncGenerator<Uint8Array> {
  const clips = chapters.flatMap((c) =>
    c.parts.flatMap((p) => (p.kind === "clip" ? [p.path] : [])),
  );
  const ahead: Promise<Uint8Array>[] = [];
  let next = 0;
  const take = (): Promise<Uint8Array> => {
    while (ahead.length < AHEAD && next < clips.length) {
      const clip = read(clips[next++]);
      // awaited in its turn; failing early must not count as unhandled meanwhile
      clip.catch(() => {});
      ahead.push(clip);
    }
    return ahead.shift()!;
  };
  const rate = byteRate(f);
  const silence = (seconds: number): Uint8Array => {
    // whole milliseconds, then whole frames (`silenceBytes`)
    const n = silenceBytes(f, Math.round(seconds * 1000) / 1000);
    sent.bytes += n;
    return new Uint8Array(n).fill(silentByte(f));
  };
  for (const [i, chapter] of chapters.entries()) {
    if (i > 0 && gap > 0) yield silence(gap);
    const start = sent.bytes;
    for (const part of chapter.parts) {
      if (part.kind === "silence") {
        if (part.seconds > 0) yield silence(part.seconds);
        continue;
      }
      const pcm = await take();
      sent.bytes += pcm.byteLength;
      yield pcm;
    }
    const span: EncodedChapter = {
      id: chapter.id,
      // ms, not bytes: a byte offset into AAC means nothing
      start: Math.round((start / rate) * 1000),
      length: Math.round(((sent.bytes - start) / rate) * 1000),
      seconds: (sent.bytes - start) / rate,
    };
    sent.spans.push(span);
    onChapter?.(span, i);
  }
}

/** The first clip's format; an encoded clip decodes to 16 bits. */
async function sourceFormat(path: string): Promise<WavFormat> {
  const kept = formatOfFile(path) ?? "wav";
  if (kept === "wav") {
    // the header is in the first few KB, ahead of the samples
    const head = readWavHeader(
      await Bun.file(path)
        .slice(0, 64 * 1024)
        .bytes(),
    );
    return { channels: head.channels, sampleRate: head.sampleRate, bits: head.bits };
  }
  try {
    const info = await probeClip(await Bun.file(path).bytes(), kept);
    return { channels: info.channels, sampleRate: info.sampleRate, bits: 16 };
  } catch (e) {
    throw new Error(`${path} could not be read as audio: ${(e as Error).message}`, { cause: e });
  }
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

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Removes work folders whose process is gone: a crash never reaches `encode`'s cleanup. One named
 * without a pid (the older layout) goes too.
 */
export async function sweepWork(dir = tmpdir()): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(WORK) || alive(Number(name.slice(WORK.length).split("-")[0]))) continue;
    await rm(join(dir, name), { recursive: true, force: true });
  }
}

export function ffmpegEncoder(options: FfmpegOptions = {}): AudiobookEncoder {
  const format = options.format ?? "m4b";
  const bin = options.bin ?? "ffmpeg";
  const bitrate = options.bitrate ?? 64;
  // an MP3 has no marks every player reads
  const markers = format === "m4b" && (options.markers ?? true);

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
      const raw = RAW[source.bits];
      if (!raw) throw new Error(`this file is ${formatLabel(source)}, which ffmpeg cannot take`);
      const input = [
        "-f",
        raw,
        "-ar",
        String(source.sampleRate),
        "-ac",
        String(source.channels),
        "-i",
        "pipe:0",
      ];
      const read = (path: string): Promise<Uint8Array> => readClip(bin, path, source, signal);
      const pass = (onEach?: EncodeInput["onChapter"]) => {
        const sent: Sent = { spans: [], bytes: 0 };
        return { sent, feed: samples(chapters, gap, source, read, sent, onEach) };
      };

      const work = join(tmpdir(), `${WORK}${process.pid}-${crypto.randomUUID()}`);
      await mkdir(work, { recursive: true });
      try {
        let filter: string[] = [];
        let measuredLufs: number | undefined;
        let limited = 0;
        if (options.loudness != null) {
          const plain = `loudnorm=I=${options.loudness}:TP=${TP}:LRA=11:print_format=json`;
          // pass one only measures
          const { log } = await run(bin, [...input, "-af", plain, "-f", "null", "-"], signal, {
            input: pass().feed,
          });
          const stats = loudnormStats(log);
          // Silence measures -inf, which pass two refuses ("Result too large"); write it as is.
          if (!stats) filter = ["-af", plain];
          else if (Number.isFinite(Number(stats.input_i))) {
            measuredLufs = Number(stats.input_i);
            const level = levelling(options.loudness, stats);
            filter = ["-af", level.filter];
            limited = level.limited;
          }
        }

        // the audio alone first: its marks need the spans this pass counts
        const audio = join(work, format === "m4b" ? "audio.m4a" : "audio.mp3");
        const { sent, feed } = pass(onChapter);
        const encoded = await run(
          bin,
          [
            ...input,
            ...filter,
            // `loudnorm` resamples to 192 kHz; without this the AAC comes out at 96 kHz.
            "-ar",
            String(source.sampleRate),
            "-c:a",
            CODEC[format],
            "-b:a",
            `${bitrate}k`,
            "-y",
            audio,
          ],
          signal,
          { input: feed },
        );
        // what pass two did, as it says, not as asked
        const levelled = filter.length ? loudnormStats(encoded.log) : null;

        const args = ["-i", audio];
        if (markers) {
          await writeFile(join(work, "chapters.txt"), chapterMetadata(chapters, sent.spans));
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
          "-c:a",
          "copy",
          ...(format === "m4b" ? ["-f", "mp4", "-movflags", "+faststart"] : []),
          "-y",
          out,
        );
        await run(bin, args, signal);

        return {
          bytes: Bun.file(out).size,
          seconds: sent.bytes / byteRate(source),
          chapters: sent.spans,
          measuredLufs,
          ...(levelled && {
            levelled: {
              linear: levelled.normalization_type === "linear",
              lufs: Number(levelled.output_i),
              limited,
            },
          }),
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/**
 * ffmpeg configured per build from the export settings; `normalize` off skips `loudnorm`. Made
 * once per server, so it clears what a crashed one left in the temporary folder.
 */
export function ffmpegEncoders(bin = "ffmpeg"): EncoderChoice {
  inBackground(sweepWork(), "could not clear old ffmpeg work folders");
  return {
    name: `ffmpeg (${bin})`,
    for: (settings: ExportSettings) =>
      ffmpegEncoder({
        format: settings.format,
        bitrate: settings.bitrate,
        markers: settings.markers,
        ...(settings.normalize ? { loudness: settings.loudness } : {}),
        bin,
      }),
  };
}
