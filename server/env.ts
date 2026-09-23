// Server configuration, read once and validated at startup.
//
// A missing or malformed setting stops the process here with a message naming the variable, rather
// than surfacing as a confusing failure three layers into a request. Nothing in this file has a
// provider credential in it: the first backend slice reads EPUBs and stores books, and makes no
// paid requests at all.
import * as v from "valibot";

const Env = v.object({
  /** where the server listens; the Vite dev server proxies /api here */
  PORT: v.pipe(
    v.optional(v.string(), "8787"),
    v.transform(Number),
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(65535),
  ),
  /** the SQLite file. `:memory:` is how the tests get a private database per run. */
  DATABASE_URL: v.optional(v.string(), "./data/library.db"),
  /** how much is logged: trace, debug, info, warn, error, fatal, or silent */
  LOG_LEVEL: v.optional(
    v.picklist(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
    "info",
  ),
  /**
   * `pretty` for a person at a terminal, `json` for anything a machine reads.
   *
   * Unset means "decide from whether stdout is a terminal", which is right almost always and wrong
   * exactly when something is piping a dev server's output somewhere it wants parsed.
   */
  LOG_FORMAT: v.optional(v.picklist(["pretty", "json"])),
  /**
   * The address the server listens on. Loopback by default: the API has no accounts and deletes
   * books on request, so it answers this machine and nothing else unless told otherwise. `0.0.0.0`
   * opens it to the network, and everyone on it.
   */
  HOST: v.optional(v.string(), "127.0.0.1"),
  /** hard ceiling on an uploaded EPUB, in megabytes */
  MAX_UPLOAD_MB: v.pipe(
    v.optional(v.string(), "64"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /**
   * Hard ceiling on what an uploaded EPUB unzips to, in megabytes, everything in it together.
   *
   * The upload limit is on the zip, and a zip can be a thousand times smaller than its contents.
   * Images are most of a big book, so this is generous; the limit that protects the parser is the
   * next one.
   */
  MAX_UNZIPPED_MB: v.pipe(
    v.optional(v.string(), "512"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /**
   * Hard ceiling on any one document inside an EPUB — a chapter file, above all — in megabytes,
   * unzipped. A document is held whole, parsed into a DOM and converted, at many times its own
   * size; a whole novel in a single file is around 10 MB.
   */
  MAX_DOCUMENT_MB: v.pipe(
    v.optional(v.string(), "32"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /**
   * Which scripting model the queue sends chapters to.
   *
   * Only `fake` exists: it reads the prose and never the network, so nothing this server does can
   * spend money. A real provider is a value here, an implementation under `server/providers/`,
   * and a key read from this environment by that implementation — never from the browser.
   */
  SCRIPTING_PROVIDER: v.optional(v.picklist(["fake"]), "fake"),
  /**
   * Which speech model the queue sends lines to. The same arrangement as scripting: only `fake`
   * exists, it renders a tone and never reaches the network, and a real provider is a value here
   * and an implementation under `server/providers/` that reads its own key from this environment.
   */
  SPEECH_PROVIDER: v.optional(v.picklist(["fake"]), "fake"),
  /**
   * Where rendered clips are kept: one directory per book under this one, and a file per render.
   * A clip's url points here and nowhere else, so moving the directory means moving the files
   * with it.
   */
  AUDIO_DIR: v.optional(v.string(), "./data/audio"),
  /**
   * Which encoder a build writes its audiobook with.
   *
   * `wav` is the default and needs nothing installed: it stitches the rendered clips into one
   * real, playable file per output file, so a fresh clone and the test suite build an audiobook
   * without a binary on the machine. It is not an M4B and writes no chapter marks, and the build
   * says so in its log rather than naming the file as though it were one.
   *
   * `ffmpeg` writes what the settings actually asked for — AAC in an M4B with the chapter marks a
   * player reads, or an MP3 — and corrects the loudness with EBU R128 when the build asks for it.
   * It runs the ffmpeg already on this machine, so it is checked at boot and refuses to start
   * when there is none rather than failing every build later.
   */
  EXPORT_ENCODER: v.optional(v.picklist(["wav", "ffmpeg"]), "wav"),
  /** the ffmpeg to run, for a machine that keeps it somewhere off `PATH` */
  FFMPEG_BIN: v.optional(v.string(), "ffmpeg"),
  /**
   * Where built audiobooks are kept: one directory per book, one file per output file. Apart from
   * the clips on purpose — a clip is an input the next build reads again, an audiobook is the
   * deliverable — so the two can be measured, backed up and cleared separately.
   */
  EXPORT_DIR: v.optional(v.string(), "./data/exports"),
});

export type Env = v.InferOutput<typeof Env>;

export function readEnv(source: Record<string, string | undefined> = Bun.env): Env {
  const parsed = v.safeParse(Env, source);
  if (parsed.success) return parsed.output;
  const problems = parsed.issues
    .map((i) => `  ${i.path?.map((p) => String(p.key)).join(".") ?? "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Server configuration is not usable:\n${problems}`);
}

export const env: Env = readEnv();

/**
 * The most an import's request body may be: the file at its limit, and the multipart envelope
 * around it — the boundaries, the field names, a title — which a megabyte covers many times over.
 */
export const importBodyBytes = (e: Env = env): number => (e.MAX_UPLOAD_MB + 1) * 1024 * 1024;
