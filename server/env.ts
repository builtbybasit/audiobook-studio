// Server configuration, validated at startup so a bad setting fails here, naming the variable.
// No provider credentials: those live in the endpoints table; `.env` ones are for live tests.
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
   * The demo library's own SQLite file, so a demo reset can never touch the real library.
   * Seeded at boot only while it holds no endpoint and no book.
   */
  DEMO_DATABASE_URL: v.optional(v.string(), "./data/demo.db"),
  /** how much is logged: trace, debug, info, warn, error, fatal, or silent */
  LOG_LEVEL: v.optional(
    v.picklist(["trace", "debug", "info", "warn", "error", "fatal", "silent"]),
    "info",
  ),
  /** `pretty` or `json`; unset picks from whether stdout is a terminal. */
  LOG_FORMAT: v.optional(v.picklist(["pretty", "json"])),
  /**
   * Loopback by default: the API has no accounts and deletes books on request.
   * `0.0.0.0` opens it to everyone on the network.
   */
  HOST: v.optional(v.string(), "127.0.0.1"),
  /** hard ceiling on an uploaded EPUB, in megabytes */
  MAX_UPLOAD_MB: v.pipe(
    v.optional(v.string(), "64"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /** hard ceiling on an uploaded script file, in megabytes; it may carry voice samples */
  MAX_SCRIPT_UPLOAD_MB: v.pipe(
    v.optional(v.string(), "512"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /**
   * Hard ceiling on an EPUB's total unzipped size, in megabytes (zip-bomb guard). Generous because
   * images are most of a big book; MAX_DOCUMENT_MB is what protects the parser.
   */
  MAX_UNZIPPED_MB: v.pipe(
    v.optional(v.string(), "512"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /**
   * Hard ceiling on one unzipped EPUB document, in megabytes. It is parsed into a DOM at many times
   * its size; a whole novel in one file is around 10 MB.
   */
  MAX_DOCUMENT_MB: v.pipe(
    v.optional(v.string(), "32"),
    v.transform(Number),
    v.number(),
    v.minValue(1),
  ),
  /** rendered clips, one directory per book; clip urls point here */
  AUDIO_DIR: v.optional(v.string(), "./data/audio"),
  /** ffmpeg binary, for a machine that keeps it off `PATH`; required, checked at boot */
  FFMPEG_BIN: v.optional(v.string(), "ffmpeg"),
  /** built audiobooks, one directory per book; apart from clips so each is cleared separately */
  EXPORT_DIR: v.optional(v.string(), "./data/exports"),
  /** a cloned voice's source recordings, one directory per voice */
  VOICE_DIR: v.optional(v.string(), "./data/voices"),
  /** the local servers the app started, so a restart adopts them rather than starting them twice */
  LOCAL_SERVERS_FILE: v.optional(v.string(), "./data/local-servers.json"),
  /** the demo's `audio/`, `exports/` and `voices/`; a demo reset removes all three */
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

/** Body limit for a file of up to `mb` megabytes, plus a megabyte for the multipart envelope. */
export const uploadBodyBytes = (mb: number): number => (mb + 1) * 1024 * 1024;

export const importBodyBytes = (e: Env = env): number => uploadBodyBytes(e.MAX_UPLOAD_MB);

export const scriptBodyBytes = (e: Env = env): number => uploadBodyBytes(e.MAX_SCRIPT_UPLOAD_MB);

/**
 * Body limit for the clone and keep routes: the samples plus the multipart envelope. Kept below
 * `maxRequestBodySize` so these routes, not the server, answer.
 */
export const CLONE_BODY_BYTES = MAX_SAMPLES_BYTES + 256 * 1024;
