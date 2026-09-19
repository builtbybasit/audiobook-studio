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
  /** hard ceiling on an uploaded EPUB, in megabytes */
  MAX_UPLOAD_MB: v.pipe(
    v.optional(v.string(), "64"),
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
