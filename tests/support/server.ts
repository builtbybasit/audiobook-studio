// A server to test against: the real routes, the real schema, the real queue, a database that
// lives in memory and goes away with the test.
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "~/app";
import { audioFiles, type AudioFiles } from "~/audio/files";
import { connect, openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { audiobookFiles } from "~/exports/files";
import { exportHandler } from "~/jobs/export";
import { narrationHandler } from "~/jobs/narration";
import { createRunner, type JobHandlers, type Runner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { createLogger, type Logger } from "~/log";
import { fakeScriptingProvider } from "~/providers/fake";
import type { AudiobookEncoder, EncoderChoice, ExportPorts } from "~/providers/encoder";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { createSpeechGate, type SpeechGate } from "~/providers/gate";
import { wavEncoders } from "~/providers/wavEncoder";
import type {
  ScriptAnswer,
  ScriptInput,
  ScriptedLine,
  ScriptingProvider,
} from "~/providers/scripting";
import type { RenderedClip, SpeechInput, SpeechProvider } from "~/providers/speech";
import type { VoiceCloner } from "~/providers/clone";
import type { VoiceLister } from "~/providers/voices";
import { voiceFiles } from "~/voices/files";
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
  /** the speech gate narration sends through and the endpoint routes read and wake */
  gate: SpeechGate;
  /** `fetch` for a client, answered by this app without a network */
  fetch: FetchLike;
  /** every line this API wrote, for the tests that are about the logging itself */
  logs: Record<string, unknown>[];
  /** Call the API the way the browser will. Returns the parsed body and the status. */
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
   * What renders the Voices tab's samples. The server's own default is the real provider, over the
   * network; here it is one that fails the test saying none was given, so no test pays for a
   * request it forgot to fake.
   */
  samples?: SpeechProvider;
  /** what makes a voice from recordings; like `samples`, one that fails the test by default */
  cloner?: VoiceCloner;
  /** where clips are written; a fresh temporary directory by default */
  audioDir?: string;
  /** where built audiobooks are written; a fresh temporary directory by default */
  exportDir?: string;
  /** where cloned voices' recordings are kept; a fresh temporary directory by default */
  voiceDir?: string;
  /** what a build writes its files with; the WAV stitcher by default */
  encoder?: AudiobookEncoder | EncoderChoice;
  /** handlers for other kinds, or an override for `scripting` or `narration` */
  handlers?: JobHandlers;
  /** the speech gate; one of this API's own by default, shared by its runner and its routes */
  gate?: SpeechGate;
}

/** A directory of its own for one test's clips, so no two suites can read each other's files. */
export const tempAudioDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-audio-"));

/** The same, for the audiobooks a build writes. */
export const tempExportDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-built-"));

/** The same, for the recordings a cloned voice was made from. */
export const tempVoiceDir = (): string => mkdtempSync(join(tmpdir(), "audiobook-voices-"));

/** Both halves of building a file, wherever this test keeps them. */
export const testExports = (options: TestApiOptions = {}): ExportPorts => ({
  encoders: !options.encoder
    ? wavEncoders()
    : "for" in options.encoder
      ? options.encoder
      : { name: options.encoder.name, for: () => options.encoder as AudiobookEncoder },
  files: audiobookFiles(options.exportDir ?? tempExportDir()),
});

/**
 * A logger that keeps its lines instead of printing them.
 *
 * A suite that prints a line per request is a suite nobody reads the output of, and the output is
 * where a failure explains itself. Collected rather than dropped, so a test can assert on what was
 * logged — and on what was not, which is how the redaction rule is checked.
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

/** The error a test meets when it reaches a real provider it was never given a fake for. */
const noFake = (what: string): Error =>
  new Error(`this test gave no ${what}, and will not reach a real provider without one`);

/** Stands in for `samples` when a test gives none: see `TestApiOptions.samples`. */
const noSamples: SpeechProvider = {
  name: "No samples provider (test)",
  speak: () => Promise.reject(noFake("samples provider")),
};

/** Stands in for `cloner` when a test gives none. */
const noCloner: VoiceCloner = {
  clone: () => Promise.reject(noFake("cloner")),
};

/** A database migrated once per file, copied for each test that asks — migrating is 25 ms a time. */
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
  return createRunner(
    db,
    {
      scripting: scriptingHandler(options.scripting ?? fakeScriptingProvider()),
      narration: narrationHandler(options.speech ?? fakeSpeechProvider(), files, options.gate),
      export: exportHandler(testExports(options), files),
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
 * A speech endpoint as the Endpoints page saves one: free, two lines at a time, every line whole,
 * one voice (`studio/ash`), and no history. `over` is what a test is about — a price, a
 * concurrency, a format — so it reads at the call site.
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

/** Save these as the library's speech endpoints, as the Endpoints page does, replacing any. */
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

/** Narrate these chapters and wait for the runner to finish; the jobs the request queued. */
export async function narrateChapters(api: TestApi, id: string, ids: number[]): Promise<Job[]> {
  const { body } = await api.request<{ jobs: Job[] }>(
    `/api/books/${id}/chapters/narrate`,
    jsonBody({ ids }),
  );
  await api.runner.idle();
  return body.jobs;
}

/** Import an EPUB and shelve it; the book. Fails here, saying why, if the import was refused. */
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

/**
 * A book ready to narrate: imported, shelved, every chapter scripted, and every speaker the script
 * found cast. Nothing is narrated; the book's id.
 */
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
  /** one chapter per pair, its title and its one paragraph — `line(title)` from `./epub` */
  chapters: [title: string, line: string][];
  /** the chapters to narrate; every one by default. Every chapter is scripted either way. */
  ids?: number[];
  /** the rest of the EPUB — a title, a cover */
  epub?: Omit<EpubInput, "chapters">;
}

/**
 * A book narrated, ready to build: imported, shelved, every chapter scripted, and `ids` narrated
 * by the speech the API was given. A chapter is one paragraph, a few seconds of audio: what a build
 * costs is the length of what it reads, and under ffmpeg nearly all of it.
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

/**
 * A scripting provider a test holds the door on.
 *
 * `started` resolves once a job is inside the provider, and nothing comes out until `release` is
 * called — so a test can act on a run that is genuinely in flight (cancel it, edit under it,
 * renumber its book) without a timer to race. Cancelling while it waits rejects the way a real
 * request would.
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

/**
 * A speech provider a test holds the door on: `gatedProvider` for lines.
 *
 * `started` resolves once the run is inside the provider with its first line, and nothing comes
 * out until `release` is called — every line after the first answers at once, so a released run
 * finishes. Cancelling while it waits rejects the way a real request would.
 */
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
