// Does the server's demo show what the browser's demo shows?
//
// The browser's demo is `makeWorld()` spread into its stores; the server's is the same world
// written into the demo library's database when it is first opened. So the browser's world is the
// oracle: the demo is opened once, on a clock stopped at one instant, and everything it answers
// over its API — books and chapters, prose, casts and dictionaries, scripts and clips, endpoints,
// exports, the queue's history and what each book has spent — is compared with a world built at
// that same instant, field for field, wherever the server stores the field.
//
// What is deliberately not compared, and why:
//   - an endpoint's telemetry (`history`, `failures`, `rateLimits`, `backoffUntil`, `lastError`):
//     what one browser session observed, which the server never stores;
//   - an endpoint's `baseUrl`, its tags' `baseUrl` and `needsKey`: moved to `simulated://` on
//     purpose, and checked for that instead;
//   - a rendered clip's `url` and `sampleRate`: the world's clips have no file, the demo's are
//     given where theirs will be made and the rate it will be made at, and are checked for that;
//   - a book's `chapters` counts, which only the server's listing carries: checked against the
//     world's chapters rather than skipped;
//   - an export's `createdAt` past the day, which is all the server's export row answers with;
//   - an endpoint's `credentialId: null` where it has no operational block: stored, it reads back
//     absent (`rows/endpoints.ts`), which the page reads the same — the endpoint's own key slot;
//   - a chapter's prose as the browser composes it on demand is compared, but not the
//     `notice` marks between its parts, which a server's chapter never has.
//
// And the world itself, before any of it is written: every seed and every situation is built on a
// fresh `makeWorld()` and changed in memory, so two worlds must share nothing, and every reference
// in one — a voice, a volume, a speaker, an exported chapter — must point at something it holds.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";

import { isSimulated } from "@/lib/providers";
import { makeCredentials } from "~/demo/seed/fixtures/credentials";
import { BOOK_SEEDS } from "~/demo/seed/fixtures/books";
import { makeEndpoints } from "~/demo/seed/fixtures/endpoints";
import { makeJobHistory } from "~/demo/seed/fixtures/jobs";
import { makeLexicon } from "~/demo/seed/fixtures/lexicon";
import { makeProfiles } from "~/demo/seed/fixtures/profiles";
import { makeWorld } from "~/demo/seed/world";
import { chapterParts, partsText } from "~/demo/seed/world/text";
import type {
  Book,
  BookSpend,
  Chapter,
  Character,
  Credential,
  Endpoint,
  ExportItem,
  Job,
  LexEntry,
  Profile,
  Segment,
  SegmentAudio,
  Take,
} from "@/types";
import { readEndpoints, readProfiles } from "~/db/endpoints";
import { SIMULATED_ID } from "~/demo/seed";
import { DEMO_BASE, openLibrary, type Library } from "~/libraries";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { SAMPLE_RATE } from "~/providers/fakeSpeech";
import { wavEncoders } from "~/providers/wavEncoder";
import { collectingLogger, tempAudioDir, tempExportDir, tempVoiceDir } from "../support/server";

/** The instant both worlds are built at: every date either one takes from the clock is this. */
const NOW = Date.parse("2026-09-29T12:00:00Z");

/** A `fetch` that fails the test: nothing the demo holds may reach the network. */
const noNetwork = (async (url: string) => {
  throw new Error(`the demo made a request: ${String(url)}`);
}) as unknown as typeof globalThis.fetch;

let demo: Library;
const audioDir = tempAudioDir();
let world: ReturnType<typeof makeWorld>;
let history: Job[];

beforeAll(() => {
  setSystemTime(new Date(NOW));
  demo = openLibrary({
    name: "demo",
    base: DEMO_BASE,
    databaseUrl: ":memory:",
    audioDir,
    exportDir: tempExportDir(),
    voiceDir: tempVoiceDir(),
    encoders: wavEncoders(),
    log: collectingLogger().log,
    providers: {
      scripting: endpointScriptingProvider({ fetch: noNetwork }),
      speech: endpointSpeechProvider({ fetch: noNetwork }),
    },
    demo: true,
  });
  world = makeWorld(NOW);
  let id = 100;
  history = makeJobHistory(() => id++);
  setSystemTime();
});

afterAll(() => demo.db.$client.close());

async function get<T>(path: string): Promise<T> {
  const res = await demo.app.request(`http://api.test${DEMO_BASE}${path}`);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

const chaptersOf = (bookId: string): Chapter[] => world.chapters[bookId] ?? [];

describe("the demo's library is the browser's world", () => {
  test("the shelf: every book, in order, with its volumes and how its chapters stand", async () => {
    const { books } = await get<{ books: Book[] }>("/books");
    expect(books.map(({ chapters: _counts, ...b }) => b)).toEqual(world.books);
    for (const b of books) {
      const chs = chaptersOf(b.id);
      expect(b.chapters).toEqual({
        total: chs.length,
        included: chs.filter((c) => !c.excluded).length,
        scripted: chs.filter((c) => c.scripting === "done" || c.scripting === "fallback").length,
        narrated: chs.filter((c) => c.narration === "done" || c.narration === "stale").length,
      });
    }
  });

  test("every book's chapters, notes and all, and the prose each one reads as", async () => {
    for (const book of world.books) {
      const { chapters } = await get<{ chapters: Chapter[] }>(`/books/${book.id}`);
      // the line counts are the server's, counted from the scripts, and not part of the world
      expect(chapters.map(({ lines: _lines, ...c }) => c)).toEqual(chaptersOf(book.id));
      for (const c of chapters) {
        const { text } = await get<{ text: string }>(
          `/books/${book.id}/chapters/${c.id}/text?format=markdown`,
        );
        expect(text).toBe(partsText(chapterParts(book.id, c.id, c, book.sample)));
      }
    }
  });

  test("every book's cast and pronunciation dictionary", async () => {
    for (const book of world.books) {
      const cast = await get<{ characters: Character[]; lexicon: LexEntry[] }>(
        `/books/${book.id}/cast`,
      );
      expect(cast.characters).toEqual(world.characters[book.id] ?? []);
      expect(cast.lexicon).toEqual(world.lexicon[book.id] ?? []);
    }
  });

  test("every chapter's script, line for line, with every clip, receipt, take and retake", async () => {
    const stripped = <T extends SegmentAudio | Take>({
      url: _url,
      sampleRate: _rate,
      ...clip
    }: T) => clip;
    const withoutFiles = (s: Segment): Segment => ({
      ...s,
      audio: {
        ...stripped(s.audio),
        ...(s.audio.takes ? { takes: s.audio.takes.map(stripped) } : {}),
      },
      ...(s.candidate ? { candidate: stripped(s.candidate) } : {}),
    });
    for (const book of world.books)
      for (const c of chaptersOf(book.id)) {
        const { segments } = await get<{ segments: Segment[] }>(
          `/books/${book.id}/chapters/${c.id}/script`,
        );
        expect(segments.map(withoutFiles)).toEqual(world.segments[`${book.id}:${c.id}`] ?? []);
      }
  });

  test("the exports, with their files, chapters and signatures", async () => {
    for (const book of world.books) {
      const { exports } = await get<{ exports: ExportItem[] }>(`/books/${book.id}/exports`);
      const expected = world.exports.filter((e) => e.bookId === book.id);
      const byId = (a: ExportItem, b: ExportItem) => a.id - b.id;
      expect(
        [...exports].sort(byId).map((e) => ({ ...e, createdAt: e.createdAt.slice(0, 10) })),
      ).toEqual(
        [...expected].sort(byId).map((e) => ({ ...e, createdAt: e.createdAt.slice(0, 10) })),
      );
    }
  });

  test("the queue's history from earlier today, every job settled", async () => {
    const { jobs } = await get<{ jobs: Job[] }>("/jobs");
    expect(jobs).toEqual(history);
    expect(jobs.every((j) => j.finishedAt != null)).toBe(true);
  });

  test("what each book had spent on its narration before the demo began", async () => {
    for (const book of world.books) {
      const { spend } = await get<{ spend: BookSpend }>(`/books/${book.id}/spend`);
      const opening = Object.entries(world.segments)
        .filter(([key]) => key.slice(0, key.lastIndexOf(":")) === book.id)
        .flatMap(([, segs]) => segs)
        .reduce((n, s) => n + (s.audio.cost ?? 0), 0);
      expect(spend.opening).toBeCloseTo(opening, 9);
      expect(spend.spent).toBeCloseTo(opening, 9);
      expect(spend.reserved).toBe(0);
    }
  });

  test("the speech endpoints, scripting profiles and credentials, and the Simulated preset after them", async () => {
    const config = await get<{
      endpoints: Endpoint[];
      profiles: Profile[];
      credentials: Credential[];
      script: { profile: string | null };
    }>("/endpoints");
    const settings = ({
      history: _h,
      failures: _f,
      rateLimits: _r,
      backoffUntil: _b,
      lastError: _l,
      baseUrl: _u,
      needsKey: _k,
      hasKey: _hk,
      expressions,
      credentialId,
      ...rest
    }: Endpoint & { hasKey?: boolean }) => ({
      ...rest,
      ...(credentialId != null ? { credentialId } : {}),
      ...(expressions ? { expressions: { ...expressions, baseUrl: "" } } : {}),
    });
    const profile = ({
      baseUrl: _u,
      needsKey: _k,
      hasKey: _hk,
      ...rest
    }: Profile & { hasKey?: boolean }) => rest;

    expect(config.endpoints.map((e) => e.id)).toEqual([
      ...world.endpoints.map((e) => e.id),
      SIMULATED_ID,
    ]);
    expect(config.endpoints.slice(0, -1).map(settings)).toEqual(world.endpoints.map(settings));
    expect(config.profiles.map((p) => p.id)).toEqual([
      ...world.profiles.map((p) => p.id),
      SIMULATED_ID,
    ]);
    expect(config.profiles.slice(0, -1).map(profile)).toEqual(world.profiles.map(profile));
    expect(config.credentials).toEqual(makeCredentials());
    // runs go to the world's first profile, as the Scripting page shows from the start
    expect(config.script.profile).toBe(world.profiles[0].id);
  });
});

describe("the demo reaches nothing and bills nothing", () => {
  test("every endpoint and profile in the demo's database is simulated, needs no key and holds none", () => {
    const all = [...readEndpoints(demo.db), ...readProfiles(demo.db)];
    expect(all.length).toBe(world.endpoints.length + world.profiles.length + 2);
    for (const e of all) {
      expect(isSimulated(e.baseUrl)).toBe(true);
      expect(e.needsKey).toBe(false);
    }
    // an endpoint's expressions model is reached at a url of its own, simulated as well
    const expressive = readEndpoints(demo.db).flatMap((e) => e.expressions?.baseUrl ?? []);
    expect(expressive).not.toHaveLength(0);
    expect(expressive.filter((url) => !isSimulated(url))).toEqual([]);
    const keys = demo.db.$client.query(
      "SELECT count(*) AS n FROM endpoints WHERE api_key IS NOT NULL",
    );
    expect((keys.get() as { n: number }).n).toBe(0);
    // the same host and path, so each still says which provider it stands in for
    expect(readEndpoints(demo.db)[0].baseUrl).toBe("simulated://api.openai.com/v1");
  });

  test("nothing the seed writes is left waiting or running: the runs the demo opens with are set going, not found", () => {
    const count = (sql: string) => (demo.db.$client.query(sql).get() as { n: number }).n;
    expect(
      count("SELECT count(*) AS n FROM jobs WHERE finished_at IS NULL OR active_key IS NOT NULL"),
    ).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM chapters WHERE scripting IN ('queued', 'running') OR narration IN ('queued', 'running')",
      ),
    ).toBe(0);
    expect(count("SELECT count(*) AS n FROM clips WHERE status IN ('queued', 'generating')")).toBe(
      0,
    );
  });

  test("every clip with audio names the file the demo will make for it, and nothing is on disk yet", () => {
    const clips = demo.db.$client
      .query("SELECT book_id, role, status, url, sample_rate FROM clips")
      .all() as {
      book_id: string;
      role: string;
      status: string;
      url: string | null;
      sample_rate: number | null;
    }[];
    const rendered = clips.filter(
      (c) => c.role === "take" || c.status === "done" || c.status === "stale",
    );
    expect(rendered).not.toHaveLength(0);
    for (const c of rendered) {
      expect(c.url).toMatch(new RegExp(`^${DEMO_BASE}/audio/${c.book_id}/[a-f0-9-]{36}\\.wav$`));
      expect(c.sample_rate).toBe(SAMPLE_RATE);
    }
    expect(new Set(rendered.map((c) => c.url)).size).toBe(rendered.length);
    expect(clips.filter((c) => !rendered.includes(c) && c.url != null)).toEqual([]);
    expect(existsSync(audioDir) ? readdirSync(audioDir) : []).toEqual([]);
  });
});

describe("the world the demo is seeded from is fresh", () => {
  test("two worlds share no mutable state", () => {
    const a = makeWorld();
    const b = makeWorld();

    a.characters.cliche[0].aliases.push("scribbled-in");
    a.characters.cliche[0].name = "Renamed";
    a.endpoints[0].voices.push({ id: "ghost", gender: "n", label: "Ghost" });
    a.endpoints[0].enabled = false;
    a.lexicon.cliche[0].say = "changed";
    a.segments["cliche:1"][0].text = "rewritten";
    a.chapters.cliche[0].title = "Retitled";

    expect(b.characters.cliche[0].aliases).not.toContain("scribbled-in");
    expect(b.characters.cliche[0].name).not.toBe("Renamed");
    expect(b.endpoints[0].voices.some((v) => v.id === "ghost")).toBe(false);
    expect(b.endpoints[0].enabled).toBe(true);
    expect(b.lexicon.cliche[0].say).not.toBe("changed");
    expect(b.segments["cliche:1"][0].text).not.toBe("rewritten");
    expect(b.chapters.cliche[0].title).not.toBe("Retitled");
  });

  test("the hand-authored seeds are never written back to", () => {
    const before = JSON.stringify(BOOK_SEEDS);
    const w = makeWorld();
    for (const c of w.characters.cliche) {
      c.aliases.push("mutated");
      c.description = "mutated";
    }
    expect(JSON.stringify(BOOK_SEEDS)).toBe(before);
  });

  test("every fixture factory hands back its own copy", () => {
    expect(makeEndpoints()[0]).not.toBe(makeEndpoints()[0]);
    expect(makeProfiles()[0]).not.toBe(makeProfiles()[0]);
    expect(makeLexicon().cliche).not.toBe(makeLexicon().cliche);
  });
});

describe("the world the demo is seeded from holds together", () => {
  // these only read, so one world serves them all
  const w = makeWorld();

  test("every speaker routes to a voice that exists on an endpoint that exists", () => {
    for (const [bookId, cast] of Object.entries(w.characters))
      for (const c of cast) {
        if (!c.voice) continue;
        const [epId, voiceId] = [c.voice.slice(0, c.voice.indexOf("/")), c.voice.split("/")[1]];
        const ep = w.endpoints.find((e) => e.id === epId);
        expect(ep, `${bookId}/${c.name} → ${c.voice}`).toBeDefined();
        expect(
          ep!.voices.some((v) => v.id === voiceId),
          `${bookId}/${c.name}`,
        ).toBe(true);
      }
  });

  test("every book has a Narrator, so an unvoiced speaker always has a fallback", () => {
    for (const bookId of Object.keys(w.characters)) {
      const narrator = w.characters[bookId].find((c) => c.name === "Narrator");
      expect(narrator, bookId).toBeDefined();
      expect(narrator!.voice, bookId).toBeTruthy();
    }
  });

  test("chapters, volumes and segments agree", () => {
    for (const b of w.books) {
      const ids = new Set(w.chapters[b.id].map((c) => c.id));
      for (const c of w.chapters[b.id])
        expect(
          b.volumes.some((v) => v.id === c.volumeId),
          `${b.id} ch ${c.id}`,
        ).toBe(true);
      for (const k of Object.keys(w.segments))
        if (k.startsWith(b.id + ":")) expect(ids.has(Number(k.split(":")[1])), k).toBe(true);
    }
  });

  test("every speaker in a script is in the book's cast", () => {
    for (const [k, segs] of Object.entries(w.segments)) {
      const names = new Set(w.characters[k.split(":")[0]].map((c) => c.name));
      for (const s of segs) expect(names.has(s.speaker), `${k} · ${s.speaker}`).toBe(true);
    }
  });

  test("every finished export names chapters the book still has", () => {
    for (const e of w.exports) {
      const ids = new Set(w.chapters[e.bookId].map((c) => c.id));
      for (const id of e.chapterIds) expect(ids.has(id), `${e.filename} ch ${id}`).toBe(true);
    }
  });
});
