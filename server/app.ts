// The API as a value, built around a database handle so a test can drive the real routes over a
// `:memory:` database. The demo is the same app under `/demo/api` (`server/libraries.ts`).
import { isIP } from "node:net";

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { pinoLogger, type Env as PinoEnv } from "hono-pino";

import type { EffectRunner } from "~/audio/effects";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { coverFiles } from "~/covers/files";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { audiobookFiles } from "~/exports/files";
import { createRunner, type Runner } from "~/jobs/runner";
import { AppError, codeFor, fail, type ApiError } from "~/lib/errors";
import type { Logger } from "~/log";
import { log as defaultLog } from "~/log";
import type { ExportPorts } from "~/providers/encoder";
import { createSpeechGate, type SpeechGate } from "~/providers/gate";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import type { Providers } from "~/providers/target";
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { audioRoutes } from "~/routes/audio";
import { bookRoutes } from "~/routes/books";
import { castRoutes } from "~/routes/cast";
import { demoRoutes, type DemoControls } from "~/routes/demo";
import { effectRoutes, settingRoutes } from "~/routes/effects";
import { endpointRoutes } from "~/routes/endpoints";
import { exportRoutes } from "~/routes/exports";
import { jobRoutes } from "~/routes/jobs";
import { scriptRoutes } from "~/routes/script";
import { speakerSampleRoutes } from "~/routes/speakerSamples";
import { transferRoutes } from "~/routes/transfer";
import { bookUsageRoutes, endpointUsageRoutes } from "~/routes/usage";
import type { LocalServers } from "~/servers/localServers";
import { voiceFiles as voiceFilesIn, type VoiceFiles } from "~/voices/files";
import type { VoiceFingerprinter } from "~/voices/fingerprint";
import type { VoiceMeter } from "~/voices/measure";
import type { FetchLike } from "@/services/http";

/** Messages for Hono refusals that come without one. */
const REFUSED: Partial<Record<number, string>> = {
  403: "That request came from another site, and was refused",
};

/**
 * DNS rebinding: a page whose own name resolves to this machine is same-origin with the API, but
 * its `Host` still says that name. An IP or `localhost` can't be rebound (Vite's dev server allows
 * the same set), and `HOST` is what the server was told to answer to.
 */
function machineHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.split(":")[0];
  return (
    isIP(name) !== 0 || name === "localhost" || name.endsWith(".localhost") || name === env.HOST
  );
}

export interface AppOptions {
  /** route prefix, also used in clip and cover urls: `/api` or `/demo/api` */
  base?: string;
  log?: Logger;
  /** The default has no handlers, so an enqueued job fails at once, saying so. */
  runner?: Runner;
  files?: AudioFiles;
  /** must match the runner's, so a download is the file the build wrote */
  exports?: ExportPorts;
  /** what a connection test asks; the same pair the runner's handlers use */
  providers?: Providers;
  voiceFiles?: VoiceFiles;
  /** the runner's narration gate: told when endpoints are saved, read for live status */
  gate?: SpeechGate;
  /** what a preview of an effect is rendered with; none by default, so previews answer 503 */
  effects?: EffectRunner;
  /** what measures a voice's samples; none = profiles are filled unmeasured, as without uv */
  meter?: VoiceMeter;
  /** what fingerprints kept samples to compare voices; none = no comparison, as without uv */
  fingerprinter?: VoiceFingerprinter;
  /** what reads a character page for a voice profile; the network by default */
  pageFetch?: FetchLike;
  /** `<base>/demo/*` controls; given to the demo library alone so the real one can't be emptied */
  demo?: DemoControls;
  /** the servers on this machine the endpoints start; none = none listed or started (the demo) */
  servers?: LocalServers;
}

export function createApp(
  db: Db,
  {
    base = "/api",
    log = defaultLog,
    runner = createRunner(db, {}, { log }),
    files = audioFiles(env.AUDIO_DIR, base),
    exports = { encoders: ffmpegEncoders(), files: audiobookFiles(env.EXPORT_DIR) },
    providers = { scripting: endpointScriptingProvider(), speech: endpointSpeechProvider() },
    voiceFiles = voiceFilesIn(env.VOICE_DIR),
    gate = createSpeechGate(),
    effects,
    meter,
    fingerprinter,
    pageFetch,
    demo,
    servers,
  }: AppOptions = {},
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.use(
    pinoLogger({
      pino: log,
      http: {
        // Not the default's every header: noisy, and it would log `authorization`.
        onReqBindings: (c) => ({ req: { method: c.req.method, url: c.req.path } }),
        onResBindings: (c) => ({ res: { status: c.res.status } }),
        /** A 4xx is an answer, not a fault; hono-pino's default logs it as `error`. */
        onResLevel: (c) => (c.res.status >= 500 ? "error" : c.res.status >= 400 ? "warn" : "info"),
      },
    }),
  );

  // Every browser sends `Host`; a request without one is a script on this machine already.
  app.use(`${base}/*`, (c, next) => {
    const host = c.req.header("host");
    if (host && !machineHost(host)) fail(403, "That request named another host, and was refused");
    return next();
  });
  // Loopback keeps other machines out (`HOST`); this keeps other sites out of no-preflight
  // requests. Only browser requests (with `Origin` or `Sec-Fetch-Site`) are checked; a script or
  // `curl` is on this machine already.
  const sameSite = csrf();
  app.use(`${base}/*`, (c, next) =>
    c.req.header("origin") || c.req.header("sec-fetch-site") ? sameSite(c, next) : next(),
  );
  app.use(`${base}/*`, secureHeaders());

  app.get(`${base}/health`, (c) => c.json({ ok: true }));
  app.route(
    `${base}/books`,
    bookRoutes(db, runner, files, exports.files, providers.scripting, effects),
  );
  app.route(`${base}/books`, castRoutes(db, runner, providers.scripting, pageFetch));
  app.route(`${base}/books`, scriptRoutes(db, runner));
  app.route(`${base}/books`, exportRoutes(db, runner, exports, coverFiles(files)));
  app.route(`${base}/books`, transferRoutes(db, providers, files, voiceFiles));
  app.route(`${base}/books`, speakerSampleRoutes(db, files));
  app.route(`${base}/books`, bookUsageRoutes(db));
  app.route(`${base}/jobs`, jobRoutes(db, runner));
  app.route(
    `${base}/endpoints`,
    endpointRoutes(db, providers, voiceFiles, gate, runner, effects, servers, {
      meter,
      fetch: pageFetch,
      fingerprinter,
    }),
  );
  app.route(`${base}/endpoints`, endpointUsageRoutes(db));
  app.route(`${base}/effects`, effectRoutes(db, files, effects));
  app.route(`${base}/settings`, settingRoutes(db));
  app.route(`${base}/audio`, audioRoutes(files));
  if (demo) app.route(`${base}/demo`, demoRoutes(demo));

  app.notFound((c) =>
    c.json(
      {
        error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` },
      } satisfies ApiError,
      404,
    ),
  );

  // AppError and Hono refusals answer in the API's error shape; anything else is a bug, logged
  // with its stack, and the client gets one generic sentence.
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.body(), err.status);
    if (err instanceof HTTPException)
      return c.json(
        {
          error: {
            code: codeFor(err.status),
            message: err.message || REFUSED[err.status] || "That request was refused",
          },
        } satisfies ApiError,
        err.status,
      );
    (c.var.logger ?? log).error({ err }, "unhandled request error");
    return c.json(
      {
        error: { code: "internal", message: "Something went wrong on the server" },
      } satisfies ApiError,
      500,
    );
  });

  return app;
}
