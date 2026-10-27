// The audiobook encoder: AAC in an M4B, or MP3, with chapter marks, via the installed ffmpeg
// (required at boot, `server/index.ts`). Clips go in as raw PCM on stdin, a few decoded ahead.
// Loudness is measured per chapter and levelled with one gain per file (`loudness.ts`); an M4B is
// joined from per-chapter AAC kept between builds (`segments.ts`), so a rebuild encodes only what
// changed. An MP3, or chapters too close to join cleanly, is encoded in one pass.
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ExportSettings } from "@/types";
import { formatOfFile } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import { inBackground } from "~/lib/background";
import {
  filterOf,
  keeps,
  levelOf,
  limiterOf,
  loudnessOf,
  measuredOf,
  type Levelling,
  type Measured,
} from "~/providers/loudness";
import {
  adtsFrames,
  alive,
  FRAME,
  joinable,
  keyOf,
  leadOf,
  pruneSegments,
  segmentStore,
  tailOf,
  type Segment,
} from "~/providers/segments";
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
/** chapters measured or encoded at once: AAC and ebur128 each take one core */
const JOBS = Math.max(1, Math.min(8, availableParallelism() - 1));

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
  onChapter?: (index: number) => void,
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
    onChapter?.(i);
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

const versions = new Map<string, Promise<string | null>>();
const versionOf = (bin: string): Promise<string | null> => {
  if (!versions.has(bin)) versions.set(bin, ffmpegAvailable(bin));
  return versions.get(bin)!;
};

/**
 * A chapter's samples as a key. A clip rewritten in place has a new size or modified time, so a
 * changed voice, effect or line misses even at the same length.
 */
async function audioKey(c: EncodeChapter, f: WavFormat, version: string): Promise<string> {
  const parts = await Promise.all(
    c.parts.map(async (p) => {
      if (p.kind === "silence") return `silence ${Math.round(p.seconds * 1000)}`;
      const s = await stat(p.path);
      return `${resolve(p.path)} ${s.size} ${s.mtimeMs}`;
    }),
  );
  return keyOf(version, formatLabel(f), ...parts);
}

/** A chapter's samples after `lead` samples of silence and before `tailOf` more; counted at the end. */
async function* padded(
  chapter: AsyncIterable<Uint8Array>,
  f: WavFormat,
  lead: number,
  counted: { audio: number; samples: number },
): AsyncGenerator<Uint8Array> {
  const frame = (f.channels * f.bits) / 8;
  const silence = (n: number) => new Uint8Array(n * frame).fill(silentByte(f));
  if (lead > 0) yield silence(lead);
  let bytes = 0;
  for await (const pcm of chapter) {
    bytes += pcm.byteLength;
    yield pcm;
  }
  counted.audio = bytes / frame;
  const tail = tailOf(lead + counted.audio);
  counted.samples = lead + counted.audio + tail;
  yield silence(tail);
}

/** `each` over `items`, `JOBS` at a time; the first failure stops the rest, their ffmpeg killed. */
async function inParallel<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  each: (item: T, i: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const stop = new AbortController();
  const quit = (): void => stop.abort(signal.reason);
  signal.addEventListener("abort", quit, { once: true });
  if (signal.aborted) quit();
  const out: R[] = [];
  let next = 0;
  let failed = null as { error: unknown } | null;
  const worker = async (): Promise<void> => {
    while (!stop.signal.aborted && next < items.length) {
      const i = next++;
      try {
        out[i] = await each(items[i], i, stop.signal);
      } catch (error) {
        failed ??= { error };
        stop.abort(error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(JOBS, items.length) }, worker));
  } finally {
    signal.removeEventListener("abort", quit);
  }
  if (signal.aborted) throw signal.reason;
  if (failed) throw failed.error;
  return out;
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

    async encode(input: EncodeInput): Promise<EncodedFile> {
      const { chapters, gap, out, signal, cover, tags } = input;
      const first = chapters.flatMap((c) => c.parts).find((p) => p.kind !== "silence");
      if (!first) throw new Error("there was nothing to write");
      const source = await sourceFormat(first.path);
      const raw = RAW[source.bits];
      if (!raw) throw new Error(`this file is ${formatLabel(source)}, which ffmpeg cannot take`);
      const rate = source.sampleRate;
      const pcm = ["-f", raw, "-ar", String(rate), "-ac", String(source.channels), "-i", "pipe:0"];
      const reader = (signal: AbortSignal) => (path: string) => readClip(bin, path, source, signal);
      /** one chapter's samples, as if it were the whole file */
      const alone = (c: EncodeChapter, signal: AbortSignal) =>
        samples([c], 0, source, reader(signal), { spans: [], bytes: 0 });

      const work = join(tmpdir(), `${WORK}${process.pid}-${crypto.randomUUID()}`);
      await mkdir(work, { recursive: true });
      try {
        // without a cache folder, chapters are kept for this build only
        const store = segmentStore(input.cache ?? work);
        await mkdir(store.dir, { recursive: true });
        const version = (await versionOf(bin)) ?? bin;
        const keys = await Promise.all(chapters.map((c) => audioKey(c, source, version)));

        /** every chapter's loudness, through the limiter at `probe` dB where one is named */
        const measure = (probe: number | null, onEach?: (i: number) => void) =>
          inParallel(chapters, signal, async (c, i, signal) => {
            const name = `${keyOf(keys[i], probe ?? "")}.loudness.json`;
            let m = await store.read<Measured>(name);
            if (!m) {
              const limiter = probe == null ? "" : `${limiterOf(probe)},`;
              const af = `${limiter}ebur128=peak=true:metadata=1,ametadata=mode=print:key=lavfi.r128.M`;
              const { log } = await run(bin, [...pcm, "-af", af, "-f", "null", "-"], signal, {
                input: alone(c, signal),
              });
              m = measuredOf(log);
              await store.write(name, m);
            }
            onEach?.(i);
            return m;
          });

        let filter: string[] = [];
        let measuredLufs: number | undefined;
        let levelled: EncodedFile["levelled"];
        const target = options.loudness;
        // silence has no gain to level it by; it is written as is
        const m = target == null ? null : loudnessOf(await measure(null, input.onMeasured));
        if (target != null && m) {
          const through = async (probe: number | null) =>
            probe == null ? m : ((await measure(probe).then(loudnessOf)) ?? m);
          // An earlier build's gain is kept while it lands within `TOLERANCE`: a new gain would
          // re-encode every chapter.
          const kept = (await store.read<Record<string, Levelling>>("levelling.json")) ?? {};
          const was = kept[target];
          const wasAfter = was && (await through(was.probe));
          let l: Levelling;
          let after: { i: number };
          if (was && wasAfter && keeps(was, target, m, wasAfter)) [l, after] = [was, wasAfter];
          else {
            l = levelOf(target, m);
            after = m;
            // the limiter takes loudness off with the peaks, so the gain is set from what it leaves
            if (l.ceiling != null) {
              after = await through(l.ceiling);
              l = levelOf(target, { i: after.i, peak: m.peak }, l.ceiling);
            }
            await store.write("levelling.json", { ...kept, [target]: l });
          }
          filter = ["-af", filterOf(l)];
          measuredLufs = m.i;
          levelled = {
            lufs: after.i + l.gain,
            limited: l.ceiling == null ? 0 : m.peak - l.ceiling,
            kept: l === was,
          };
        }

        const encoding = [
          ...filter,
          "-ar",
          String(rate),
          "-c:a",
          CODEC[format],
          "-b:a",
          `${bitrate}k`,
        ];
        const gapSamples = Math.round(gap * rate);
        let spans: EncodedChapter[];
        let samplesOut: number;
        let reused = 0;
        let audio: { args: string[]; feed?: AsyncIterator<Uint8Array> };
        if (format === "m4b" && (chapters.length === 1 || joinable(gapSamples))) {
          const segment = async (
            c: EncodeChapter,
            key: string,
            lead: number,
            signal: AbortSignal,
          ) => {
            const tmp = store.draft(key);
            try {
              const counted = { audio: 0, samples: 0 };
              await run(bin, [...pcm, ...encoding, "-f", "adts", "-y", tmp], signal, {
                input: padded(alone(c, signal), source, lead, counted),
              });
              // the layout every join is counted on: one frame of priming, then whole frames
              const frames = adtsFrames(await Bun.file(tmp).bytes());
              const expected = counted.samples / FRAME + 1;
              if (frames !== expected)
                throw new Error(
                  `ffmpeg wrote “${c.title}” as ${frames ?? "unreadable"} AAC frames where ${expected} were expected`,
                );
              const seg: Segment = { lead, ...counted, bytes: Bun.file(tmp).size };
              await store.keep(key, tmp, seg);
              return seg;
            } finally {
              await rm(tmp, { force: true });
            }
          };
          const segments = await inParallel(chapters, signal, async (c, i, signal) => {
            const lead = i === 0 ? 0 : leadOf(gapSamples);
            const key = keyOf(keys[i], lead, encoding.join(" "));
            let seg = await store.segment(key);
            if (seg) reused++;
            else seg = await segment(c, key, lead, signal);
            input.onChapter?.(i);
            return { ...seg, path: store.audio(key) };
          });
          let at = 0;
          spans = segments.map((s, i) => {
            // the later stream's priming plays inside the gap
            if (i > 0) at += FRAME;
            const span: EncodedChapter = {
              id: chapters[i].id,
              start: Math.round(((at + s.lead) / rate) * 1000),
              length: Math.round((s.audio / rate) * 1000),
              seconds: s.audio / rate,
            };
            at += s.samples;
            return span;
          });
          // ponytail: the file ends with the last chapter's tail, one to two frames of silence; a
          // stream copy cuts only whole frames, and ffmpeg sets no edit-list end on copied AAC
          samplesOut = at;
          audio = {
            // the first stream's priming is skipped with an edit list
            args: ["-itsoffset", (-FRAME / rate).toFixed(6), "-f", "aac", "-i", "pipe:0"],
            feed: (async function* () {
              for (const s of segments) yield await Bun.file(s.path).bytes();
            })(),
          };
        } else {
          const path = join(work, format === "m4b" ? "audio.m4a" : "audio.mp3");
          const sent: Sent = { spans: [], bytes: 0 };
          await run(bin, [...pcm, ...encoding, "-y", path], signal, {
            input: samples(chapters, gap, source, reader(signal), sent, input.onChapter),
          });
          spans = sent.spans;
          samplesOut = sent.bytes / ((source.channels * source.bits) / 8);
          audio = { args: ["-i", path] };
        }

        const args = [...audio.args];
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
          "-c:a",
          "copy",
          ...(format === "m4b" ? ["-f", "mp4", "-movflags", "+faststart"] : []),
          "-y",
          out,
        );
        await run(bin, args, signal, { input: audio.feed });
        // awaited, so it is over before anything can remove the book's folder
        if (input.cache) await pruneSegments(input.cache);

        return {
          bytes: Bun.file(out).size,
          seconds: samplesOut / rate,
          chapters: spans,
          measuredLufs,
          levelled,
          reused,
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/**
 * ffmpeg configured per build from the export settings; `normalize` off skips levelling. Made
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
