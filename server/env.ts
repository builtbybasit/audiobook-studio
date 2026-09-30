// Server configuration, read once and validated at startup.
//
// A missing or malformed setting stops the process here with a message naming the variable, rather
// than surfacing as a confusing failure three layers into a request. Nothing in this file has a
// provider credential in it: a real provider's base URL, model and key are the Endpoints page's,
// kept in the database. The `.env` variables the live tests read are theirs alone.
import * as v from "valibot";

import { MAX_SAMPLES_BYTES } from "@/lib/voiceSamples";

const Env = v.object({
  /** where the server listens; the Vite dev server proxies /api and /demo/api here */
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
  /**
   * The demo library's SQLite file. A database of its own rather than rows beside the real ones:
   * the demo is emptied and seeded again on request, and what does that is never given the real
   * library's database to do it to. Seeded at boot while it holds no endpoint and no book, and
   * left as it is once it does.
   */
  DEMO_DATABASE_URL: v.optional(v.string(), "./data/demo.db"),
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
   * Hard ceiling on an uploaded script file, in megabytes. Apart from the EPUB's because a script
   * can carry voice samples (docs/script-transfer.md, slice 3), and audio barely compresses: a
   * few voices' recordings are hundreds of megabytes whatever the zip does. A script without them
   * is text, and nowhere near either limit.
   */
  MAX_SCRIPT_UPLOAD_MB: v.pipe(
    v.optional(v.string(), "512"),
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
  /**
   * Where the recordings a cloned voice was made from are kept: one directory per voice. Apart from
   * the clips and the audiobooks, because these are recordings of a person rather than anything
   * this server rendered — measured, backed up and cleared on their own terms.
   */
  VOICE_DIR: v.optional(v.string(), "./data/voices"),
  /**
   * Where the demo library keeps its files: `audio/`, `exports/` and `voices/` under this one, the
   * demo's own versions of the three above. A reset of the demo removes all three.
   */
  DEMO_DIR: v.optional(v.string(), "./data/demo"),
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
 * The most a request body carrying a file of up to `mb` megabytes may be: the file at its limit, and
 * the multipart envelope around it — the boundaries, the field names, a title — which a megabyte
 * covers many times over.
 */
export const uploadBodyBytes = (mb: number): number => (mb + 1) * 1024 * 1024;

/** The most an import's request body may be; see `uploadBodyBytes`. */
export const importBodyBytes = (e: Env = env): number => uploadBodyBytes(e.MAX_UPLOAD_MB);

/** The same for a script file, which may carry voice samples: see `MAX_SCRIPT_UPLOAD_MB`. */
export const scriptBodyBytes = (e: Env = env): number => uploadBodyBytes(e.MAX_SCRIPT_UPLOAD_MB);

/**
 * The largest body the clone and keep routes read: the samples, and a little over for the multipart
 * envelope around them. The server's own ceiling (`maxRequestBodySize`) is set above it, so these
 * routes are the ones that answer.
 */
export const CLONE_BODY_BYTES = MAX_SAMPLES_BYTES + 256 * 1024;
