// The demo world (`makeWorld()`) written into a library's database, filling in what the world
// leaves out: each chapter's prose as an import would store it; clip urls with no file behind them
// (`audio/demoClips.ts` makes a tone on first read); and endpoint urls rewritten to `simulated://`,
// so the demo never reaches the network or bills anything.
import { chapterParts, partsText } from "~/demo/seed/world/text";
import { makeCredentials } from "~/demo/seed/fixtures/credentials";
import type {
  Book,
  Chapter,
  ChapterHistory,
  Character,
  Endpoint,
  ExportItem,
  Job,
  Profile,
  RequestRecord,
  Segment,
  SegmentAudio,
  SegmentMap,
  Take,
  World,
} from "@/types";
import type { Db, Tx } from "~/db/client";
import { replaceLexicon } from "~/db/cast";
import type { EndpointConfig } from "~/db/endpoints";
import { insertBook } from "~/db/library";
import * as rows from "~/db/rows";
import {
  characters,
  exportChapters,
  exportFiles,
  exportItems,
  jobEvents,
  jobs,
  openingSpend,
  requests,
  scriptHeads,
  scriptVersions,
} from "~/db/schema";
import { insertRows } from "~/db/prepared";
import { replaceScript } from "~/db/script";
import { SAMPLE_RATE } from "~/providers/fakeSpeech";

// ---------- the library ----------

const bodiesOf = (book: Book, chs: readonly Chapter[]) =>
  chs.map((c) => ({
    chapterId: c.id,
    body: partsText(chapterParts(book.id, c.id, c, book.sample)),
  }));

export function writeBook(
  db: Db | Tx,
  book: Book,
  chs: readonly Chapter[],
  addedAt = Date.parse(book.addedAt),
): void {
  insertBook(db, book, chs, bodiesOf(book, chs), addedAt);
}

export function writeCast(db: Db | Tx, bookId: string, cast: readonly Character[]): void {
  insertRows(
    db,
    characters,
    cast.map((c, i) => rows.characterValues(bookId, c, i)),
  );
}

// read as UTC, so the day it reads back is the world's wherever the server is
const exportedAt = (e: ExportItem): number => Date.parse(`${e.createdAt.replace(" ", "T")}Z`);

export function writeExport(db: Db | Tx, e: ExportItem, createdAt = exportedAt(e)): void {
  insertRows(db, exportItems, [rows.exportValues(e, createdAt)]);
  insertRows(
    db,
    exportFiles,
    e.files.map((f, i) => rows.exportFileValues(e.id, f, i)),
  );
  insertRows(db, exportChapters, rows.exportChapterValues(e));
}

export function writeJob(db: Db | Tx, job: Job): void {
  insertRows(db, jobs, [rows.jobValues(job)]);
  insertRows(
    db,
    jobEvents,
    (job.activity ?? []).map((e) => rows.jobEventValues(job.id, e)),
  );
}

export function writeHistory(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  history: ChapterHistory,
): void {
  insertRows(db, scriptHeads, [rows.scriptHeadValues(bookId, chapterId, history)]);
  insertRows(
    db,
    scriptVersions,
    history.versions.map((v) => rows.scriptVersionValues(bookId, chapterId, v)),
  );
}

// ---------- the clips ----------

/** A take always has audio; a clip once rendered. */
const rendered = (clip: SegmentAudio | Take): boolean =>
  !("status" in clip) || clip.status === "done" || clip.status === "stale";

/** Gives every rendered clip of a line its file url and sample rate. */
function withFiles(seg: Segment, fileAt: (clip: SegmentAudio | Take) => Partial<Take>): Segment {
  const give = <T extends SegmentAudio | Take>(clip: T): T =>
    rendered(clip) ? { ...clip, ...fileAt(clip) } : clip;
  const audio = give(seg.audio);
  const takes = seg.audio.takes?.map(give);
  return {
    ...seg,
    audio: takes ? { ...audio, takes } : audio,
    ...(seg.candidate ? { candidate: give(seg.candidate) } : {}),
  };
}

const keyOf = (key: string) => {
  const i = key.lastIndexOf(":");
  return { bookId: key.slice(0, i), chapterId: Number(key.slice(i + 1)) };
};

/**
 * Each book's seeded narration cost, as its opening balance. Taken before a situation moves any
 * clip.
 */
export function openingOf(segments: SegmentMap): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, segs] of Object.entries(segments)) {
    const { bookId } = keyOf(key);
    out.set(bookId, (out.get(bookId) ?? 0) + segs.reduce((n, s) => n + (s.audio.cost ?? 0), 0));
  }
  return out;
}

// ---------- the whole of it ----------

/** Everything the demo's database is seeded with, beside its endpoints. */
export interface DemoWorld {
  world: World;
  /** settled jobs only: the runner starts any job that is not */
  jobs: Job[];
  /** by `book:chapter` */
  histories: Record<string, ChapterHistory>;
  requests: RequestRecord[];
  /** `openingOf` */
  opening: Map<string, number>;
}

export interface WorldOptions {
  base: string;
  /** the added date of a book the world says was added "just now" */
  now: number;
}

const addedAtOf = (book: Book, now: number): number => {
  const at = Date.parse(book.addedAt);
  return Number.isNaN(at) ? now : at;
};

/** Everything but the endpoints, which are saved as the Endpoints page does (`worldEndpoints`). */
export function writeWorld(tx: Tx, demo: DemoWorld, { base, now }: WorldOptions): void {
  const { world } = demo;
  for (const book of world.books) {
    writeBook(tx, book, world.chapters[book.id] ?? [], addedAtOf(book, now));
    writeCast(tx, book.id, world.characters[book.id] ?? []);
    replaceLexicon(tx, book.id, world.lexicon[book.id] ?? []);
  }

  const rates = new Map(world.endpoints.map((e) => [e.id, e.sampleRate ?? SAMPLE_RATE]));
  for (const [key, segs] of Object.entries(world.segments)) {
    const { bookId, chapterId } = keyOf(key);
    const fileAt = (clip: SegmentAudio | Take) => ({
      url: `${base}/audio/${bookId}/${crypto.randomUUID()}.wav`,
      sampleRate: rates.get(clip.endpoint ?? "") ?? SAMPLE_RATE,
    });
    replaceScript(
      tx,
      bookId,
      chapterId,
      segs.map((s) => withFiles(s, fileAt)),
    );
  }
  for (const [key, history] of Object.entries(demo.histories)) {
    const { bookId, chapterId } = keyOf(key);
    writeHistory(tx, bookId, chapterId, history);
  }

  insertRows(
    tx,
    openingSpend,
    [...demo.opening].map(([bookId, amount]) => ({ bookId, amount })),
  );
  insertRows(
    tx,
    requests,
    demo.requests.map((r) => rows.requestValues(r)),
  );
  for (const e of world.exports) writeExport(tx, e);
  for (const job of demo.jobs) writeJob(tx, job);
}

// ---------- the endpoints ----------

/** `https://api.openai.com/v1` → `simulated://api.openai.com/v1` */
const offline = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "simulated://");

const simulatedEndpoint = (e: Endpoint): Endpoint => ({
  ...e,
  baseUrl: offline(e.baseUrl),
  needsKey: false,
  // tags are keyed by address, which moved with the endpoint
  ...(e.expressions
    ? { expressions: { ...e.expressions, baseUrl: offline(e.expressions.baseUrl) } }
    : {}),
});

const simulatedProfile = (p: Profile): Profile => ({
  ...p,
  baseUrl: offline(p.baseUrl),
  needsKey: false,
});

/** Every endpoint and profile simulated; credentials are names only, with no keys. */
export const worldEndpoints = (world: World): EndpointConfig => ({
  endpoints: world.endpoints.map(simulatedEndpoint),
  profiles: world.profiles.map(simulatedProfile),
  credentials: makeCredentials(),
});
