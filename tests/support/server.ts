// A server to test against: the real routes, schema and queue over an in-memory database.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EffectRunner } from "~/audio/effects";
import type { ThoughtEffect } from "~/audio/thoughtEffect";
import type { TrimSilence } from "~/audio/trim";
import { createApp } from "~/app";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { connect, openDb, type Db } from "~/db/client";
import { enqueueJob } from "~/db/jobs";
import { migrate } from "~/db/migrate";
import { audiobookFiles } from "~/exports/files";
import { transcribeHandler } from "~/jobs/transcribe";
import { effectsHandler } from "~/jobs/effects";
import { exportHandler } from "~/jobs/export";
import { narrationHandler } from "~/jobs/narration";
import { createRunner, type JobContext, type JobHandlers, type Runner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { createLogger, type Logger } from "~/log";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AudiobookEncoder, EncoderChoice, ExportPorts } from "~/providers/encoder";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { createSpeechGate, type SpeechGate } from "~/providers/gate";
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";
import type {
  ScriptAnswer,
  ScriptInput,
  ScriptedLine,
  ScriptingProvider,
} from "~/providers/scripting";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";
import type { VoiceCloner } from "~/providers/clone";
import type { TranscriptionProvider } from "~/providers/transcription";
import type { VoiceLister } from "~/providers/voices";
import type { LocalServers } from "~/servers/localServers";
import { voiceFiles } from "~/voices/files";
import type { VoiceMeter } from "~/voices/measure";
import type { FetchLike } from "@/services/http";
import type { Book, Character, Endpoint, Job } from "@/types";
import { epubFile, type EpubInput } from "./epub";

export interface TestApi {
  db: Db;
  /** the queue the API enqueues into; `await runner.idle()` to let queued work finish */
  runner: Runner;
  /** where this API's clips are written and served from */
  files: AudioFiles;
  audioDir: string;
  /** what this API's builds write with, and where they put it */
  exports: ExportPorts;
  exportDir: string;
  /** where this API keeps the recordings a cloned voice was made from */
  voiceDir: string;
  /** the gate every job sends through; the endpoint routes read and wake it */
  gate: SpeechGate;
  /** `fetch` for a client, answered by this app without a network */
  fetch: FetchLike;
  /** every line this API logged */
  logs: Record<string, unknown>[];
  /** Call the API the way the browser will. */
  request<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** POST an EPUB through the real multipart path. */
  import<T = unknown>(
    file: File,
    fields?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
}

export interface TestApiOptions {
  /** the scripting model the queue sends chapters to; the deterministic fake by default */
  scripting?: ScriptingProvider;
  /** the speech model the queue sends lines to; the tone-rendering fake by default */
  speech?: SpeechProvider;
  /** where the Voices tab's lists come from; the real lister, over the network, by default */
  voices?: VoiceLister;
  /**
   * Renders Voice tab samples; by default one that fails the test, so no test pays for a request.
   */
  samples?: SpeechProvider;
  /** what makes a voice from recordings; like `samples`, one that fails the test by default */
  cloner?: VoiceCloner;
  /** what hears a recording back as words; like `samples`, one that fails the test by default */
  transcription?: TranscriptionProvider;
  /** where clips are written; a fresh temporary directory by default */
  audioDir?: string;
  /** where built audiobooks are written; a fresh temporary directory by default */
  exportDir?: string;
  /** where cloned voices' recordings are kept; a fresh temporary directory by default */
  voiceDir?: string;
  /** what a build writes its files with; ffmpeg by default */
  encoder?: AudiobookEncoder | EncoderChoice;
  /** handlers for other kinds, or an override for `scripting` or `narration` */
  handlers?: JobHandlers;
  /** the speech gate; one of this API's own by default, shared by its runner and its routes */
  gate?: SpeechGate;
  /** what runs voice effects; none by default, so no test runs Python unasked */
  effects?: EffectRunner;
  /** what a thought line is given where `effects` cannot run; none by default, nor ffmpeg */
  thoughtEffect?: ThoughtEffect;
  /** what cuts a clip's silent ends; none by default, nor ffmpeg */
  trim?: TrimSilence;
  /** the local servers the endpoint routes start and stop; none by default, as in the demo */
  servers?: LocalServers;
  /** what measures a voice's samples; none by default, so no test runs Python unasked */
  meter?: VoiceMeter;
  /** what a voice profile reads pages with; the network by default, so give one */
  pageFetch?: FetchLike;
}

/** Per-test directories, so no two suites read each other's files. */
export const tempAudioDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-audio-"));

export const tempExportDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-built-"));

export const tempVoiceDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-voices-"));

/** Both halves of building a file, wherever this test keeps them. */
export const testExports = (options: TestApiOptions = {}): ExportPorts => ({
  encoders: !options.encoder
    ? ffmpegEncoders()
    : "for" in options.encoder
      ? options.encoder
      : { name: options.encoder.name, for: () => options.encoder as AudiobookEncoder },
  files: audiobookFiles(options.exportDir ?? tempExportDir()),
});

/**
 * A logger that keeps its lines instead of printing them, so a test can assert on what was logged.
 */
export function collectingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: "trace",
    format: "json",
    out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { log, lines };
}

const noFake = (what: string): Error =>
  new Error(`this test gave no ${what}, and will not reach a real provider without one`);

/** Stands in for `samples` when a test gives none. */
const noSamples: SpeechProvider = {
  name: "No samples provider (test)",
  speak: () => Promise.reject(noFake("samples provider")),
};

/** Stands in for `cloner` when a test gives none. */
const noCloner: VoiceCloner = {
  clone: () => Promise.reject(noFake("cloner")),
};

/** Stands in for `transcription` when a test gives none. */
const noTranscription: TranscriptionProvider = {
  name: "No transcription provider (test)",
  transcribe: () => Promise.reject(noFake("transcription provider")),
};

/** Migrated once per file and copied per test: migrating is 25 ms a time. */
let migrated: Uint8Array | undefined;

export function testDb(): Db {
  if (!migrated) {
    const db = openDb(":memory:");
    migrate(db);
    migrated = db.$client.serialize();
    db.$client.close();
  }
  return connect(Database.deserialize(migrated));
}

export function testRunner(db: Db, log: Logger, options: TestApiOptions = {}): Runner {
  const files = audioFiles(options.audioDir ?? tempAudioDir());
  const gate = options.gate ?? createSpeechGate();
  return createRunner(
    db,
    {
      scripting: scriptingHandler(options.scripting ?? fakeScriptingProvider(), gate),
      narration: narrationHandler(options.speech ?? fakeSpeechProvider(), files, gate, {
        effects: options.effects,
        thoughtEffect: options.thoughtEffect,
        trim: options.trim,
      }),
      export: exportHandler(testExports(options), files),
      transcribe: transcribeHandler(options.transcription ?? noTranscription, files, gate),
      effects: effectsHandler(options.effects, files),
      ...options.handlers,
    },
    { log, pollMs: 60_000 },
  );
}

export function testApi(options: TestApiOptions = {}): TestApi {
  const db = testDb();
  const { log, lines } = collectingLogger();
  const audioDir = options.audioDir ?? tempAudioDir();
  const files = audioFiles(audioDir);
  const exportDir = options.exportDir ?? tempExportDir();
  const exports = testExports({ ...options, exportDir });
  const gate = options.gate ?? createSpeechGate();
  const runner = testRunner(db, log, { ...options, audioDir, exportDir, gate });
  const providers = {
    scripting: options.scripting ?? fakeScriptingProvider(),
    speech: options.speech ?? fakeSpeechProvider(),
    ...(options.voices ? { voices: options.voices } : {}),
    samples: options.samples ?? noSamples,
    cloner: options.cloner ?? noCloner,
    transcription: options.transcription ?? noTranscription,
  };
  const voiceDir = options.voiceDir ?? tempVoiceDir();
  const app = createApp(db, {
    log,
    runner,
    files,
    exports,
    providers,
    voiceFiles: voiceFiles(voiceDir),
    gate,
    effects: options.effects,
    servers: options.servers,
    meter: options.meter,
    pageFetch: options.pageFetch,
  });

  const request = async <T>(path: string, init?: RequestInit) => {
    const res = await app.request(`http://api.test${path}`, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  return {
    db,
    runner,
    files,
    audioDir,
    exports,
    exportDir,
    voiceDir,
    gate,
    fetch: async (input, init) => app.request(new Request(`http://api.test${input}`, init)),
    logs: lines,
    request,
    import: <T>(file: File, fields: Record<string, string> = {}) => {
      const form = new FormData();
      form.set("file", file);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return request<T>("/api/books/import", { method: "POST", body: form });
    },
  };
}

/** `{ ids: [...] }` to a route that takes chapter numbers. */
export const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * A free speech endpoint: two lines at a time, lines whole, one voice (`studio/ash`). `over` is
 * what the test is about, so it reads at the call site.
 */
export const speechEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "studio",
  name: "Studio speech",
  baseUrl: "http://localhost:8880/v1",
  model: "studio-tts",
  concurrency: 2,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 0,
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  ...over,
});

/** Save these as the library's speech endpoints, replacing any. */
export const saveEndpoints = (api: TestApi, endpoints: Endpoint[]) =>
  api.request("/api/endpoints", {
    ...jsonBody({ endpoints, profiles: [], credentials: [] }),
    method: "PUT",
  });

/** Script these chapters and wait for the runner to finish. */
export async function scriptChapters(api: TestApi, id: string, ids: number[]): Promise<void> {
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids }));
  await api.runner.idle();
}

/** Narrate these chapters and wait for the runner to finish; returns the queued jobs. */
export async function narrateChapters(api: TestApi, id: string, ids: number[]): Promise<Job[]> {
  const { body } = await api.request<{ jobs: Job[] }>(
    `/api/books/${id}/chapters/narrate`,
    jsonBody({ ids }),
  );
  await api.runner.idle();
  return body.jobs;
}

/** Import an EPUB and shelve it. Throws, saying why, if the import was refused. */
async function shelved(api: TestApi, input: EpubInput): Promise<Book> {
  const { status, body } = await api.import<{ book: Book }>(await epubFile(input));
  if (status !== 201)
    throw new Error(`the import was refused (${status}): ${JSON.stringify(body)}`);
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return body.book;
}

export interface VoicedBookOptions {
  /** saved first, as the library's speech endpoints; left out, whatever the test saved stands */
  endpoints?: Endpoint[];
  /** every chapter's paragraphs */
  paragraphs: string[];
  /** the voice every speaker is cast with — `studio/ash` — or one per speaker */
  voiceOf: string | ((speaker: string) => string);
  /** the chapters' titles, each with the same paragraphs; one chapter, "One", by default */
  chapters?: string[];
}

/** Imported, shelved, scripted, and every speaker cast; nothing narrated. Returns the book's id. */
export async function voicedBook(
  api: TestApi,
  { endpoints, paragraphs, voiceOf, chapters = ["One"] }: VoicedBookOptions,
): Promise<string> {
  if (endpoints) await saveEndpoints(api, endpoints);
  const { id } = await shelved(api, {
    chapters: chapters.map((title) => ({ title, paragraphs })),
  });
  const all = chapters.map((_, i) => i + 1);
  await scriptChapters(api, id, all);
  const cast = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  for (const c of cast.body.characters)
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: typeof voiceOf === "string" ? voiceOf : voiceOf(c.name) }),
      method: "PUT",
    });
  return id;
}

export interface NarratedBookOptions {
  /** one chapter per pair, its title and its one paragraph (`line(title)` from `./epub`) */
  chapters: [title: string, line: string][];
  /** the chapters to narrate; every one by default. Every chapter is scripted either way. */
  ids?: number[];
  /** the rest of the EPUB — a title, a cover */
  epub?: Omit<EpubInput, "chapters">;
}

/**
 * Imported, shelved, scripted, and `ids` narrated. One paragraph a chapter keeps it to a few
 * seconds of audio: a build costs the length of what it reads.
 */
export async function narratedBook(
  api: TestApi,
  { chapters, ids, epub = {} }: NarratedBookOptions,
): Promise<{ id: string; book: Book }> {
  const book = await shelved(api, {
    ...epub,
    chapters: chapters.map(([title, line]) => ({ title, paragraphs: [line] })),
  });
  const all = chapters.map((_, i) => i + 1);
  await scriptChapters(api, book.id, all);
  await narrateChapters(api, book.id, ids ?? all);
  return { id: book.id, book };
}

/** Queues straight into `db` and runs nothing, so a test can run the handlers itself. */
export const queueOnly = (db: Db): Pick<Runner, "enqueue"> => ({
  enqueue: (input) => enqueueJob(db, input),
});

/** What the runner hands a handler, for running one by hand; notes and progress go nowhere. */
export const jobContext = (db: Db, job: Job): JobContext => ({
  job,
  db,
  signal: new AbortController().signal,
  log: collectingLogger().log,
  progress: () => {},
  note: () => {},
});

/**
 * Holds every request sent `through` it until `open`, counting how many are in at once.
 * `reached(n)` resolves once n are held.
 */
export function door() {
  let inside = 0;
  let most = 0;
  let opened = false;
  const held: (() => void)[] = [];
  let watch: { n: number; resolve(): void } | null = null;
  return {
    get inside() {
      return inside;
    },
    get most() {
      return most;
    },
    reached: (n: number) =>
      new Promise<void>((resolve) => (held.length >= n ? resolve() : (watch = { n, resolve }))),
    open() {
      opened = true;
      for (const go of held.splice(0)) go();
    },
    async through<T>(request: () => Promise<T>): Promise<T> {
      inside++;
      most = Math.max(most, inside);
      try {
        if (!opened)
          await new Promise<void>((go) => {
            held.push(go);
            if (watch && held.length >= watch.n) watch.resolve();
          });
        return await request();
      } finally {
        inside--;
      }
    },
  };
}

/**
 * A scripting provider a test holds the door on: `started` resolves once a job is inside, nothing
 * comes out until `release`, so a test can act on a run genuinely in flight. Abort rejects as a
 * real request would.
 */
export function gatedProvider(
  answer: ScriptedLine[] = [{ type: "narration", speaker: "Narrator", text: "Rain fell." }],
): { provider: ScriptingProvider; started: Promise<ScriptInput>; release(): void } {
  let onStart!: (input: ScriptInput) => void;
  let onRelease!: () => void;
  const started = new Promise<ScriptInput>((r) => (onStart = r));
  const gate = new Promise<void>((r) => (onRelease = r));
  return {
    started,
    release: () => onRelease(),
    provider: {
      name: "Gated scripting (test)",
      script(input) {
        onStart(input);
        return new Promise<ScriptAnswer>((resolve, reject) => {
          const abort = () => reject(input.signal.reason);
          if (input.signal.aborted) return abort();
          input.signal.addEventListener("abort", abort, { once: true });
          void gate.then(() => {
            input.signal.removeEventListener("abort", abort);
            resolve({ lines: answer });
          });
        });
      },
    },
  };
}

/** `gatedProvider` for speech: only the first line waits for `release`; the rest answer at once. */
export function gatedSpeechProvider(answer: Partial<RenderedClip> = {}): {
  provider: SpeechProvider;
  started: Promise<SpeechInput>;
  release(): void;
} {
  const fake = fakeSpeechProvider();
  let onStart!: (input: SpeechInput) => void;
  let onRelease!: () => void;
  let released = false;
  const started = new Promise<SpeechInput>((r) => (onStart = r));
  const gate = new Promise<void>((r) => (onRelease = r));
  return {
    started,
    release: () => {
      released = true;
      onRelease();
    },
    provider: {
      name: "Gated speech (test)",
      async speak(input) {
        onStart(input);
        if (!released)
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(input.signal.reason);
            if (input.signal.aborted) return abort();
            input.signal.addEventListener("abort", abort, { once: true });
            void gate.then(() => {
              input.signal.removeEventListener("abort", abort);
              resolve();
            });
          });
        return { ...(await fake.speak(input)), ...answer };
      },
    },
  };
}
