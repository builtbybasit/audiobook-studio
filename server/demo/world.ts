// The browser's demo world, written into a library's database.
//
// `makeWorld()` is the world every screen of the demo is built against — four books with volumes
// and notices, a cast and a dictionary each, six thousand script lines with rendered clips and
// frozen receipts, finished and failed exports, endpoints with off-peak schedules and running
// promotions. The demo library holds the same world, so the server's demo shows what the
// browser's does; this is the one place the server reaches into `src/mock` to get it, and only the
// demo's seed calls it. It imports the world's own modules rather than the `@/mock` barrel, which
// would bring the browser's simulators with it.
//
// What the world leaves out, a library needs, and it is filled in here:
//
//   - a chapter's prose, which the browser composes on demand and the server keeps as the body an
//     import would have written, so the contents review, the estimate and a scripting run read it;
//   - a rendered clip's url, in the library's usual form, with no file behind it: the demo makes a
//     clip's file the first time something reads it (`audio/demoClips.ts`), a tone as long as the
//     row says, at the rate the row says — so the rate is the tone's;
//   - where each endpoint sends its work, which in the world is a real provider's host and here is
//     `simulated://` in front of the same host and path, so nothing in the demo reaches the
//     network, and nothing it does is billed, whatever the endpoint is called.
import { chapterParts, partsText } from "@/mock/world/text";
import { credentials } from "@/lib/credentials";
import type {
  Book,
  Chapter,
  Character,
  Endpoint,
  ExportItem,
  Job,
  Profile,
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
} from "~/db/schema";
import { replaceScript } from "~/db/script";
import { SAMPLE_RATE } from "~/providers/fakeSpeech";

/** SQLite takes its parameters one variable at a time, and a cast or an export is many rows. */
const CHUNK = 150;
function insertAll<T>(write: (part: T[]) => void, values: readonly T[]): void {
  for (let i = 0; i < values.length; i += CHUNK) write(values.slice(i, i + CHUNK));
}

// ---------- the library ----------

/** Each chapter's prose, composed the way the browser composes it, as the body an import keeps. */
const bodiesOf = (book: Book, chs: readonly Chapter[]) =>
  chs.map((c) => ({
    chapterId: c.id,
    body: partsText(chapterParts(book.id, c.id, c, book.sample)),
  }));

/** A book, its volumes, its chapters and their prose; added on the day the world says it was. */
export function writeBook(db: Db | Tx, book: Book, chs: readonly Chapter[]): void {
  insertBook(db, book, chs, bodiesOf(book, chs), Date.parse(book.addedAt));
}

export function writeCast(db: Db | Tx, bookId: string, cast: readonly Character[]): void {
  insertAll(
    (part) => db.insert(characters).values(part).run(),
    cast.map((c, i) => rows.characterValues(bookId, c, i)),
  );
}

// The world dates an export to the minute, and the table keeps epoch ms; read as UTC, so the day
// it reads back as is the day the world gives, wherever the server is.
const exportedAt = (e: ExportItem): number => Date.parse(`${e.createdAt.replace(" ", "T")}Z`);

export function writeExport(db: Db | Tx, e: ExportItem, createdAt = exportedAt(e)): void {
  db.insert(exportItems).values(rows.exportValues(e, createdAt)).run();
  insertAll(
    (part) => db.insert(exportFiles).values(part).run(),
    e.files.map((f, i) => rows.exportFileValues(e.id, f, i)),
  );
  insertAll((part) => db.insert(exportChapters).values(part).run(), rows.exportChapterValues(e));
}

export function writeJob(db: Db | Tx, job: Job): void {
  db.insert(jobs).values(rows.jobValues(job)).run();
  for (const e of job.activity ?? [])
    db.insert(jobEvents).values(rows.jobEventValues(job.id, e)).run();
}

// ---------- the clips ----------

/** Whether a clip has audio to play: a take always does; a clip once it has been rendered. */
const rendered = (clip: SegmentAudio | Take): boolean =>
  !("status" in clip) || clip.status === "done" || clip.status === "stale";

/**
 * Give every rendered clip of a line the url its file will be made at, and the rate it will be
 * made at: the endpoint's own, when it asks for one, as a simulated endpoint answers at it.
 */
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
 * What each book's clips had cost before the demo began: its opening balance, summed over the line
 * each clip is on now, as the browser's demo sums it (`useUsageStore`), so the two agree on what a
 * book has spent.
 */
function openingOf(segments: SegmentMap): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, segs] of Object.entries(segments)) {
    const { bookId } = keyOf(key);
    out.set(bookId, (out.get(bookId) ?? 0) + segs.reduce((n, s) => n + (s.audio.cost ?? 0), 0));
  }
  return out;
}

// ---------- the whole of it ----------

export interface WorldOptions {
  /** the library's API base, which a clip's url is under */
  base: string;
  /** the queue's history: only settled jobs, since the runner starts any job that is not */
  jobs: readonly Job[];
}

/**
 * The world's books, casts, dictionaries, scripts and clips, opening balances, exports and queue
 * history, into the caller's transaction. The endpoints are not among them: they are saved as the
 * Endpoints page saves them (`worldEndpoints`).
 */
export function writeWorld(tx: Tx, world: World, { base, jobs: history }: WorldOptions): void {
  for (const book of world.books) {
    writeBook(tx, book, world.chapters[book.id] ?? []);
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

  for (const [bookId, amount] of openingOf(world.segments))
    tx.insert(openingSpend).values({ bookId, amount }).run();
  for (const e of world.exports) writeExport(tx, e);
  for (const job of history) writeJob(tx, job);
}

// ---------- the endpoints ----------

/** The same host and path, answered by this server: `https://api.openai.com/v1` → `simulated://api.openai.com/v1`. */
const offline = (url: string): string => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "simulated://");

const simulatedEndpoint = (e: Endpoint): Endpoint => ({
  ...e,
  baseUrl: offline(e.baseUrl),
  needsKey: false,
  // the tags are known for a model at an address, and the address has moved with the endpoint
  ...(e.expressions
    ? { expressions: { ...e.expressions, baseUrl: offline(e.expressions.baseUrl) } }
    : {}),
});

const simulatedProfile = (p: Profile): Profile => ({
  ...p,
  baseUrl: offline(p.baseUrl),
  needsKey: false,
});

/**
 * The world's speech endpoints and scripting profiles, every one simulated, and the credential
 * registry they name — names only, as ever, and no key behind any of them.
 */
export const worldEndpoints = (world: World): EndpointConfig => ({
  endpoints: world.endpoints.map(simulatedEndpoint),
  profiles: world.profiles.map(simulatedProfile),
  credentials: credentials.map(({ id, label, note }) => ({ id, label, note })),
});
