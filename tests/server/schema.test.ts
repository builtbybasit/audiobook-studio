// Does the schema actually hold the domain?
//
// The seeded world is the reference answer. It is the same data every screen in the app is built
// against — books with volumes and notices, a cast, a pronunciation dictionary, six thousand script
// lines with rendered clips, frozen speech receipts, retakes waiting for a verdict, endpoints with
// off-peak schedules and running promotions, finished and failed exports — so a schema that can
// take all of it and give it back unchanged is a schema that holds the domain, and one that cannot
// is wrong in a way no hand-written fixture would have found.
//
// These assert **round-trip equality**, not field lists. A mapper that quietly turns an absent
// `note` into a null one, or a take into something carrying `status`, fails here rather than in a
// screen six months from now.
import { beforeEach, describe, expect, test } from "bun:test";

// The mock world reaches for `matchMedia` through the stores it shares types with; the frontend
// suite stubs it the same way.
Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });

import { sql } from "drizzle-orm";

import type { Job, RequestRecord, World } from "@/types";
import { credentials } from "@/lib/credentials";
import { makeWorld } from "@/mock";
import { openDb, type Db } from "~/db/client";
import { deleteVolume } from "~/db/library";
import { migrate } from "~/db/migrate";
import {
  readCast,
  readChapters,
  readEndpoints,
  readExport,
  readHistory,
  readJob,
  readLexicon,
  readProfiles,
  readRequests,
  readScript,
  writeBook,
  writeCast,
  writeEndpoint,
  writeExport,
  writeHistory,
  writeJob,
  writeLexicon,
  writeProfile,
  writeCredentials,
  writeRequest,
  writeScript,
} from "../support/persist";

let db: Db;
let world: World;

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  world = makeWorld();
});

/** The seeded world's books, written with their chapters. */
function writeBooks(): void {
  for (const book of world.books) writeBook(db, book, world.chapters[book.id] ?? []);
}

describe("the library", () => {
  test("every seeded book's chapters come back as they went in", () => {
    writeBooks();
    for (const book of world.books)
      expect(readChapters(db, book.id)).toEqual(world.chapters[book.id] ?? []);
  });

  test("a chapter with an import note keeps it, and one without stays without", () => {
    writeBooks();
    const all = world.books.flatMap((b) => readChapters(db, b.id));
    const noted = all.filter((c) => c.note);
    const plain = all.filter((c) => !c.note);
    expect(noted.length).toBeGreaterThan(0);
    expect(plain.length).toBeGreaterThan(0);
    // absent is not null: a chapter with no note has no `note` key at all
    expect(plain.every((c) => !("note" in c))).toBe(true);
  });
});

describe("the cast and the dictionary", () => {
  test("every book's cast round-trips, in its own order", () => {
    writeBooks();
    for (const book of world.books) {
      const cast = world.characters[book.id] ?? [];
      writeCast(db, book.id, cast);
      expect(readCast(db, book.id)).toEqual(cast);
    }
  });

  test("every book's pronunciation dictionary round-trips", () => {
    writeBooks();
    for (const [bookId, entries] of Object.entries(world.lexicon)) {
      writeLexicon(db, bookId, entries);
      expect(readLexicon(db, bookId)).toEqual(entries);
    }
    expect(Object.keys(world.lexicon).length).toBeGreaterThan(0);
  });
});

describe("the script and its clips", () => {
  /** Write every seeded script. Six thousand lines, which is the point. */
  function writeScripts(): number {
    let n = 0;
    for (const [key, segs] of Object.entries(world.segments)) {
      const i = key.lastIndexOf(":");
      writeScript(db, key.slice(0, i), Number(key.slice(i + 1)), segs);
      n += segs.length;
    }
    return n;
  }

  test("every seeded line of every book comes back identical", () => {
    writeBooks();
    const written = writeScripts();
    expect(written).toBeGreaterThan(1000);

    for (const [key, segs] of Object.entries(world.segments)) {
      const i = key.lastIndexOf(":");
      expect(readScript(db, key.slice(0, i), Number(key.slice(i + 1)))).toEqual(segs);
    }
  });

  test("a rendered clip keeps the receipt it was charged from", () => {
    writeBooks();
    writeScripts();
    const charged = Object.entries(world.segments)
      .flatMap(([key, segs]) => segs.map((s) => ({ key, s })))
      .filter(({ s }) => s.audio.charge);
    expect(charged.length).toBeGreaterThan(0);

    const { key, s } = charged[0];
    const i = key.lastIndexOf(":");
    const back = readScript(db, key.slice(0, i), Number(key.slice(i + 1))).find(
      (x) => x.id === s.id,
    );
    // the frozen document, whole: rates, why, units and basis
    expect(back?.audio.charge).toEqual(s.audio.charge);
  });

  test("a retake waiting for a verdict stays beside the clip, not instead of it", () => {
    writeBooks();
    writeScripts();
    const withCandidate = Object.entries(world.segments)
      .flatMap(([key, segs]) => segs.map((s) => ({ key, s })))
      .filter(({ s }) => s.candidate);
    expect(withCandidate.length).toBeGreaterThan(0);

    const { key, s } = withCandidate[0];
    const i = key.lastIndexOf(":");
    const back = readScript(db, key.slice(0, i), Number(key.slice(i + 1))).find(
      (x) => x.id === s.id,
    );
    expect(back?.candidate).toEqual(s.candidate);
    // the book's clip is untouched: nothing reads the candidate as what the chapter plays
    expect(back?.audio).toEqual(s.audio);
  });

  test("a superseded take comes back a take, not a clip", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const chapterId = world.chapters[bookId][0].id;
    const [first] = world.segments[`${bookId}:${chapterId}`];
    const withTake = {
      ...first,
      audio: {
        ...first.audio,
        n: 2,
        takes: [
          {
            n: 1,
            at: 1_700_000_000_000,
            ms: 880,
            duration: 2.5,
            endpoint: "local",
            voice: "bm_george",
            text: first.text,
            rejected: true,
          },
        ],
      },
    };
    writeScript(db, bookId, chapterId, [withTake]);

    const back = readScript(db, bookId, chapterId)[0];
    expect(back).toEqual(withTake);
    // a `Take` has no status, no split detail and no error — reading one back must not invent them
    expect(back.audio.takes?.[0]).not.toHaveProperty("status");
    expect(back.audio.takes?.[0]).not.toHaveProperty("cuts");
  });

  test("a line with no clip reads as one that has never been rendered", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const chapterId = world.chapters[bookId][0].id;
    const bare = {
      id: 1,
      type: "narration" as const,
      speaker: "Narrator",
      text: "The ledger opened.",
      direction: "",
      audio: { status: "none" as const, endpoint: null, ms: 0, duration: 0 },
    };
    writeScript(db, bookId, chapterId, [bare]);
    expect(readScript(db, bookId, chapterId)).toEqual([bare]);
  });
});

describe("script history", () => {
  test("a version's segments come back as an independent copy", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const chapterId = world.chapters[bookId][0].id;
    const segs = world.segments[`${bookId}:${chapterId}`];
    const history = {
      versions: [
        {
          id: 1,
          at: 1_700_000_000_000,
          origin: { kind: "scripted" as const, model: "gpt-4o" },
          segments: segs.slice(0, 3),
        },
        {
          id: 2,
          at: 1_700_000_100_000,
          origin: { kind: "edited" as const, edits: 2 },
          segments: segs.slice(0, 4),
        },
      ],
      head: {
        at: 1_700_000_200_000,
        origin: { kind: "checkpoint" as const, name: "before DeepSeek" },
        open: true,
      },
      nextId: 3,
    };
    writeHistory(db, bookId, chapterId, history);

    const back = readHistory(db, bookId, chapterId);
    expect(back).toEqual(history);
    // stored whole, so nothing that happens to the working script can reach into it
    expect(back?.versions[0].segments).not.toBe(segs);
  });
});

describe("endpoints and their rate cards", () => {
  // Endpoints point at named credentials, so the registry has to exist before any of them do.
  beforeEach(() => writeCredentials(db, credentials));

  test("every seeded speech endpoint round-trips, schedule and promotions included", () => {
    world.endpoints.forEach((e, i) => writeEndpoint(db, e, i));
    const back = readEndpoints(db);
    expect(back).toHaveLength(world.endpoints.length);

    world.endpoints.forEach((e, i) => {
      const got = back[i];
      expect(got.id).toBe(e.id);
      expect(got.voices).toEqual(e.voices);
      expect(got.billing).toEqual(e.billing);
      expect(got.pricing).toEqual(e.pricing);
      expect(got.expressions).toEqual(e.expressions);
    });
  });

  test("every seeded scripting profile round-trips", () => {
    world.profiles.forEach((p, i) => writeProfile(db, p, i));
    const back = readProfiles(db);
    expect(back).toEqual(world.profiles);
  });

  test("an expired promotion is kept, so the receipts it priced stay explicable", () => {
    const withPromos = world.profiles.find((p) => (p.pricing?.promotions.length ?? 0) > 0)!;
    writeProfile(db, withPromos, 0);
    const back = readProfiles(db)[0];
    expect(back.pricing?.promotions).toEqual(withPromos.pricing!.promotions);
    // including any whose end date has already passed
    expect(back.pricing!.promotions.length).toBeGreaterThan(0);
  });

  test("live telemetry is not stored: an endpoint comes back with no backoff and no history", () => {
    // a restart must not resurrect a cooldown for a rate limit that expired days ago
    const busy = {
      ...world.endpoints[0],
      backoffUntil: Date.now() + 60_000,
      failures: 9,
      rateLimits: 4,
    };
    writeEndpoint(db, busy, 0);
    const back = readEndpoints(db)[0];
    expect(back.backoffUntil).toBe(0);
    expect(back.failures).toBe(0);
    expect(back.rateLimits).toBe(0);
    expect(back.history).toEqual([]);
  });
});

describe("exports", () => {
  test("every seeded export round-trips with its files and its chapter signatures", () => {
    writeBooks();
    for (const e of world.exports) {
      writeExport(db, e, Date.parse(e.createdAt));
      const back = readExport(db, e.id)!;
      expect(back.files).toEqual(e.files);
      expect(back.chapterIds).toEqual(e.chapterIds);
      // the signatures are what "this export needs an update" is decided from
      expect(back.state).toEqual(e.state);
      expect(back.timeline).toEqual(e.timeline);
      expect(back.settings).toEqual(e.settings);
      expect(back.status).toBe(e.status);
    }
    expect(world.exports.length).toBeGreaterThan(0);
  });
});

describe("the queue", () => {
  test("a bulk job keeps the run it belongs to, and what it is holding", () => {
    writeBooks();
    const job: Job = {
      id: 400,
      kind: "narration",
      bookId: world.books[0].id,
      chapterId: 3,
      label: "Chapter 3",
      status: "running",
      progress: 0.4,
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_001_000,
      finishedAt: null,
      cancelled: false,
      bulk: { id: 7, op: "Narrate", index: 2, total: 8, scope: "fill" },
      narrationRun: {
        reserved: 1.25,
        clips: 120,
        estimated: 0.98,
        estimatedInput: 0.4,
        estimatedAudio: 0.58,
      },
      activity: [{ id: 1, at: 1_700_000_001_500, level: "info", message: "Dispatched 12 clips" }],
    };
    writeJob(db, job);
    expect(readJob(db, job.id)).toEqual(job);
  });

  test("what a job holds against the cap is a column, so the gate can sum it", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const base = {
      kind: "narration" as const,
      bookId,
      chapterId: null,
      label: "run",
      status: "running" as const,
      progress: 0,
      queuedAt: 0,
      startedAt: null,
      finishedAt: null,
      cancelled: false,
    };
    writeJob(db, { ...base, id: 1, narrationRun: { reserved: 2, clips: 10 } });
    writeJob(db, {
      ...base,
      id: 2,
      scriptRun: {
        profile: world.profiles[0],
        requests: 4,
        completed: 0,
        active: 1,
        reserved: 3,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    expect(readJob(db, 1)?.narrationRun?.reserved).toBe(2);
    expect(readJob(db, 2)?.scriptRun?.reserved).toBe(3);
  });
});

describe("the usage ledger", () => {
  test("a settled request keeps its receipt exactly as it was frozen", () => {
    writeBooks();
    const record: RequestRecord = {
      id: "req-1",
      endpointId: "openai",
      kind: "scripting",
      bookId: world.books[0].id,
      chapterId: 2,
      label: "Script chunk 1",
      status: "done",
      attempts: 1,
      queuedAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_100,
      finishedAt: 1_700_000_008_000,
      queueMs: 100,
      responseMs: 7900,
      usage: { inputTokens: 5000, outputTokens: 1200, cachedInput: 2000 },
      cost: 0.0135,
      costBasis: "calculated",
      priced: {
        at: 1_700_000_008_000,
        rule: "priced at the rates in force when the request completed",
        lines: [{ component: "input", tokens: 3000, rate: 2.5, amount: 0.0075 }],
        total: 0.0135,
        calculated: 0.0135,
        reported: null,
        basis: "calculated",
        unknowns: [],
        usage: {
          inputTokens: 5000,
          cachedInput: 2000,
          cacheWrite: null,
          outputTokens: 1200,
          format: "openai",
          problems: [],
        },
        rates: {} as never,
      },
      simulated: true,
    };
    writeRequest(db, record);
    expect(readRequests(db)).toEqual([record]);
  });

  test("a cost that is not known stays null, and is never read as free", () => {
    writeBooks();
    const unknown: RequestRecord = {
      id: "req-2",
      endpointId: "proxy",
      kind: "tts",
      bookId: null,
      chapterId: null,
      label: "Line 4",
      status: "done",
      attempts: 1,
      queuedAt: 0,
      startedAt: 0,
      finishedAt: 1,
      queueMs: 0,
      responseMs: 1,
      usage: { chars: 120, bytes: 140 },
      cost: null,
      costBasis: "unknown",
      simulated: true,
    };
    writeRequest(db, unknown);
    const [back] = readRequests(db);
    expect(back.cost).toBeNull();
    expect(back.costBasis).toBe("unknown");
    // and a quantity nobody counted stays absent rather than becoming zero
    expect(back.usage).toEqual({ chars: 120, bytes: 140 });
  });
});

describe("what follows a renumbered chapter, and what must not", () => {
  /** A book of more than one volume, so removing one actually moves the chapters after it. */
  function twoVolumeBook(): { bookId: string; volumeId: number; moved: number } {
    writeBooks();
    const book = world.books.find((b) => b.volumes.length > 1) ?? world.books[0];
    const first = book.volumes[0];
    // a chapter in the second volume: it is the one whose number the removal changes
    return { bookId: book.id, volumeId: first.id, moved: first.to + 1 };
  }

  const request = (bookId: string, chapterId: number): RequestRecord => ({
    id: "req-moved",
    endpointId: "openai",
    kind: "tts",
    bookId,
    chapterId,
    label: `Chapter ${chapterId} · narration`,
    status: "done",
    attempts: 1,
    queuedAt: 0,
    startedAt: 0,
    finishedAt: 1,
    queueMs: 0,
    responseMs: 1,
    usage: { chars: 4200 },
    cost: 0.063,
    costBasis: "calculated",
    simulated: true,
  });

  const job = (bookId: string, chapterId: number): Job => ({
    id: 900,
    kind: "narration",
    bookId,
    chapterId,
    label: `Chapter ${chapterId}`,
    status: "queued",
    progress: 0,
    queuedAt: 1_700_000_000_000,
    startedAt: null,
    finishedAt: null,
    cancelled: false,
  });

  test("a queued job follows its chapter to the number it now has", () => {
    const { bookId, volumeId, moved } = twoVolumeBook();
    writeJob(db, job(bookId, moved));

    const gone = deleteVolume(db, bookId, volumeId).chapters;
    expect(gone).toBeGreaterThan(0);

    // A number in a column would have left this job pointing at somebody else's chapter — and a
    // queued narration that runs on the wrong chapter is not a display problem.
    expect(readJob(db, 900)?.chapterId).toBe(moved - gone);
  });

  test("a job for a chapter that is removed ends with it", () => {
    const { bookId } = twoVolumeBook();
    const chapterId = readChapters(db, bookId)[0].id;
    writeJob(db, job(bookId, chapterId));

    db.run(sql`DELETE FROM chapters WHERE book_id = ${bookId} AND id = ${chapterId}`);

    // there is nothing left to run, open or retry
    expect(readJob(db, 900)).toBeNull();
  });

  test("a whole-book job keeps its place when chapters move under it", () => {
    const { bookId, volumeId } = twoVolumeBook();
    writeJob(db, { ...job(bookId, 1), id: 901, kind: "export", chapterId: null });

    deleteVolume(db, bookId, volumeId);

    // a null chapter satisfies the reference by definition, which is what a build needs
    expect(readJob(db, 901)?.chapterId).toBeNull();
  });

  test("a settled request still reports the chapter it was for after a renumbering", () => {
    const { bookId, volumeId, moved } = twoVolumeBook();
    writeRequest(db, request(bookId, moved));

    const gone = deleteVolume(db, bookId, volumeId).chapters;

    // The ledger row was not rewritten — it never is — and it still names the right chapter,
    // because what it stored was the chapter itself rather than the number it went by that day.
    const [back] = readRequests(db);
    expect(back.chapterId).toBe(moved - gone);
    expect(back.cost).toBe(0.063);
  });

  test("removing a chapter keeps what was spent on it, and what it was called", () => {
    const { bookId } = twoVolumeBook();
    const chapterId = readChapters(db, bookId)[0].id;
    writeRequest(db, request(bookId, chapterId));

    db.run(sql`DELETE FROM chapters WHERE book_id = ${bookId} AND id = ${chapterId}`);

    const [back] = readRequests(db);
    // the money does not disappear with the chapter: it stays in every total
    expect(back.cost).toBe(0.063);
    // the chapter is gone, so there is no number to give — `label` is what still names the work
    expect(back.chapterId).toBeNull();
    expect(back.label).toContain(`Chapter ${chapterId}`);
  });
});

describe("what a chapter owns, it owns", () => {
  /** A book with one chapter, its script, a clip, a take and a version of its history. */
  function seedChapter(bookId: string, chapterId: number): void {
    const segs = world.segments[`${bookId}:${chapterId}`].slice(0, 5);
    writeScript(db, bookId, chapterId, segs);
    writeHistory(db, bookId, chapterId, {
      versions: [{ id: 1, at: 1, origin: { kind: "scripted" }, segments: segs }],
      head: { at: 2, origin: { kind: "edited", edits: 1 } },
      nextId: 2,
    });
  }

  test("renumbering a book carries its script, clips and history with it", () => {
    writeBooks();
    const bookId = world.books.find((b) => b.volumes.length > 1)?.id ?? world.books[0].id;
    const chapters = readChapters(db, bookId);
    const moved = chapters[1];
    seedChapter(bookId, moved.id);
    const before = readScript(db, bookId, moved.id);
    expect(before.length).toBe(5);

    // the shift renumbering does, in the same shape `renumber` uses
    db.run(
      sql`UPDATE chapters SET id = id + 1000000 WHERE book_id = ${bookId} AND id = ${moved.id}`,
    );

    // nothing was orphaned: the foreign keys carried all of it
    expect(readScript(db, bookId, moved.id + 1_000_000)).toEqual(before);
    expect(readHistory(db, bookId, moved.id + 1_000_000)?.versions).toHaveLength(1);
    expect(readScript(db, bookId, moved.id)).toEqual([]);
  });

  test("removing a chapter removes its script, its clips and its history", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const chapterId = readChapters(db, bookId)[0].id;
    seedChapter(bookId, chapterId);
    expect(readScript(db, bookId, chapterId).length).toBe(5);

    db.run(sql`DELETE FROM chapters WHERE book_id = ${bookId} AND id = ${chapterId}`);

    expect(readScript(db, bookId, chapterId)).toEqual([]);
    expect(readHistory(db, bookId, chapterId)).toBeNull();
    // and no clip outlived the line it belonged to
    const orphans = db.all<{ n: number }>(sql`SELECT count(*) as n FROM clips`);
    expect(orphans[0].n).toBe(0);
  });

  test("removing a book takes its cast and its dictionary with it", () => {
    writeBooks();
    const bookId = world.books[0].id;
    writeCast(db, bookId, world.characters[bookId] ?? []);
    writeLexicon(db, bookId, world.lexicon[bookId] ?? []);
    expect(readCast(db, bookId).length).toBeGreaterThan(0);

    db.run(sql`DELETE FROM books WHERE id = ${bookId}`);

    expect(readCast(db, bookId)).toEqual([]);
    expect(readLexicon(db, bookId)).toEqual([]);
    expect(readChapters(db, bookId)).toEqual([]);
  });

  test("a line may hold one clip and one retake, but any number of takes", () => {
    writeBooks();
    const bookId = world.books[0].id;
    const chapterId = readChapters(db, bookId)[0].id;
    const [line] = world.segments[`${bookId}:${chapterId}`];
    writeScript(db, bookId, chapterId, [line]);

    // a second `current` clip for the same line is what the store's rule forbids, and the
    // database refuses it rather than leaving two clips claiming to be the chapter's audio
    expect(() =>
      db.run(
        sql`INSERT INTO clips (book_id, chapter_id, segment_id, role, status, ms, duration)
            VALUES (${bookId}, ${chapterId}, ${line.id}, 'current', 'done', 0, 0)`,
      ),
    ).toThrow();

    // takes are a list, and are deliberately not constrained
    for (const n of [1, 2, 3])
      db.run(
        sql`INSERT INTO clips (book_id, chapter_id, segment_id, role, n, status, ms, duration)
            VALUES (${bookId}, ${chapterId}, ${line.id}, 'take', ${n}, 'done', 0, 0)`,
      );
    expect(readScript(db, bookId, chapterId)[0].audio.takes).toHaveLength(3);
  });
});
