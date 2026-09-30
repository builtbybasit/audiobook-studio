// The browser's demo world, written into a library's database.
//
// `makeWorld()` is the world every screen of the demo is built against — four books with volumes
// and notices, a cast and a dictionary each, six thousand script lines with rendered clips and
// frozen receipts, finished and failed exports, endpoints with off-peak schedules and running
// promotions. The demo library holds the same world, so the server's demo shows what the
// browser's does; this is the one place the server reaches into `demo/seed/` to get it, and only the
// demo's seed calls it.
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

/** Each chapter's prose, composed the way the browser composes it, as the body an import keeps. */
const bodiesOf = (book: Book, chs: readonly Chapter[]) =>
  chs.map((c) => ({
    chapterId: c.id,
    body: partsText(chapterParts(book.id, c.id, c, book.sample)),
  }));

/** A book, its volumes, its chapters and their prose; added on the day the world says it was. */
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

// The world dates an export to the minute, and the table keeps epoch ms; read as UTC, so the day
// it reads back as is the day the world gives, wherever the server is.
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

/** The versions a chapter's script has been through, and where it stands now. */
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
 * each clip is on, so what a book has spent includes the narration it was seeded with. Taken from the world as it is seeded, before a situation moves any clip.
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
  /** the queue's history: only settled jobs, since the runner starts any job that is not */
  jobs: Job[];
  /** the histories a situation gave chapters' scripts, by `book:chapter` */
  histories: Record<string, ChapterHistory>;
  /** scripting a situation says a book had already paid for, as rows in the ledger */
  requests: RequestRecord[];
  /** each book's narration spending before the demo began (`openingOf`) */
  opening: Map<string, number>;
}

export interface WorldOptions {
  /** the library's API base, which a clip's url is under */
  base: string;
  /** when the seed is written: the day a book the world says was added "just now" was added */
  now: number;
}

/** The day the world says a book was added, or `now` for one it says was added just now. */
const addedAtOf = (book: Book, now: number): number => {
  const at = Date.parse(book.addedAt);
  return Number.isNaN(at) ? now : at;
};

/**
 * The world's books, casts, dictionaries, scripts and clips, their histories, opening balances,
 * exports and queue history, into the caller's transaction. The endpoints are not among them: they
 * are saved as the Endpoints page saves them (`worldEndpoints`).
 *
 * A book the world holds that was imported rather than seeded keeps what it has — a review still
 * open, notes on its chapters, chapters kept and skipped — and its prose is composed from the
 * sample it was read from, which the book names and the library does not keep.
 */
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
  credentials: makeCredentials(),
});
