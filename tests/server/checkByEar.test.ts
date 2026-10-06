// Checking by ear through the queue: a narrated chapter's clips heard back by a transcription
// endpoint, each set against its line — the finding kept by the clip's file and served by line,
// a clip heard saying something else flagged, one heard right taking a `heard` flag down, and a
// person's flag left alone — priced into the ledger by the minute, and queued by itself after a
// narration when the book asks.
//
// The speech is the tone-rendering fake; what the transcription endpoint hears is chosen per line
// by the test (`ears`), which finds the line a clip belongs to by the clip's file name.
import { describe, expect, test } from "bun:test";

import type {
  ChapterHeard,
  ChapterScript,
  CheckQueued,
  ImportedBook,
  Job,
  RequestRecord,
  Segment,
  Transcriber,
} from "@/types";
import { listJobs } from "~/db/jobs";
import { readScript, setFlag } from "~/db/script";
import { ProviderError } from "~/providers/http";
import type {
  Transcript,
  TranscriptionInput,
  TranscriptionProvider,
} from "~/providers/transcription";
import { epubFile, story } from "../support/epub";
import { jsonBody, narrateChapters, testApi, type TestApi } from "../support/server";

const transcriber = (over: Partial<Transcriber> = {}): Transcriber => ({
  id: "phonon",
  name: "Phonon",
  baseUrl: "http://127.0.0.1:8001/v1",
  model: "phonon-2",
  enabled: true,
  concurrency: 2,
  needsKey: false,
  perMinute: 0.6,
  ...over,
});

/** Each word of `text` heard a third of a second after the last, as Phonon gives them. */
const timed = (text: string) =>
  text.split(/\s+/).map((word, i) => ({ word, start: i / 3, end: i / 3 + 0.3 }));

/**
 * A transcription endpoint that hears whatever `say` makes of the line a clip belongs to — the line
 * itself, word times and all, unless a test says otherwise — and fails the lines `fail` picks out.
 * Every request it answers is reported, billed, as the real one reports it.
 */
interface Ears {
  asked: TranscriptionInput[];
  /** the book whose clips it hears, set once the book is made */
  book: { api: TestApi | null; id: string };
  say: (s: Segment) => Transcript;
  fail: (s: Segment) => boolean;
  provider: TranscriptionProvider;
}

function ears(): Ears {
  const asked: TranscriptionInput[] = [];
  const book: Ears["book"] = { api: null, id: "" };
  const ears: Ears = {
    asked,
    book,
    say: (s) => ({ text: s.text, words: timed(s.text) }),
    fail: () => false,
    provider: {
      name: "ears (test)",
      async transcribe(input) {
        asked.push(input);
        const segs = [1, 2].flatMap((ch) => readScript(book.api!.db, book.id, ch));
        const s = segs.find((x) => x.audio.url?.endsWith(`/${input.name}`));
        if (!s) throw new Error(`no line has the clip ${input.name}`);
        if (ears.fail(s)) throw new ProviderError("Phonon answered 500: out of memory", 500, true);
        const now = Date.now();
        input.sent?.({
          startedAt: now,
          finishedAt: now,
          attempts: 1,
          rateLimited: false,
          simulated: false,
          status: "done",
          audioSeconds: input.seconds,
          billed: true,
        });
        return ears.say(s);
      },
      probe: async () => ({ ok: true, message: "Answered in 3 ms", ms: 3 }),
    },
  };
  return ears;
}

const saveTranscribers = (api: TestApi, ...transcribers: Transcriber[]) =>
  api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [], profiles: [], transcribers, credentials: [] }),
    method: "PUT",
  });

/** A book with two scripted chapters, the first narrated, and a transcription endpoint on. */
async function narrated(e = ears(), { transcribers = [transcriber()] } = {}) {
  const api = testApi({ transcription: e.provider });
  await saveTranscribers(api, ...transcribers);
  const { body } = await api.import<ImportedBook>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two"].map((title) => ({
        title,
        paragraphs: ["“We are short again,” said Mara.", ...story(2)],
      })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  await narrateChapters(api, id, [1]);
  e.book.api = api;
  e.book.id = id;
  return { api, id, e };
}

const check = (api: TestApi, id: string, ids: number[]) =>
  api.request<CheckQueued>(`/api/books/${id}/chapters/check`, jsonBody({ ids }));

async function checked(api: TestApi, id: string, ids = [1]) {
  const queued = await check(api, id, ids);
  await api.runner.idle();
  return queued;
}

const heardOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<{ lines: ChapterHeard }>(`/api/books/${id}/chapters/${ch}/heard`)).body.lines;

const scriptOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<ChapterScript>(`/api/books/${id}/chapters/${ch}/script`)).body;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

describe("checking a chapter by ear", () => {
  test("hears every clip once, keeps what it heard with its word marks, and prices it", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;

    const { status, body } = await checked(api, id);
    expect(status).toBe(202);
    expect(body.skipped).toEqual([]);
    expect(body.jobs.map((j) => [j.kind, j.chapterId])).toEqual([["check", 1]]);
    expect(e.asked).toHaveLength(segs.length);
    // the cast's names go as hints, the narrator's does not
    expect(e.asked[0].hints).toContain("Mara");
    expect(e.asked[0].hints).not.toContain("Narrator");
    expect(e.asked[0].words).toBe(true);

    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("done");
    expect(job.checkRun).toEqual({
      endpoint: "phonon",
      lines: segs.length,
      checked: segs.length,
      mismatched: 0,
      failed: 0,
    });

    const lines = await heardOf(api, id);
    expect(Object.keys(lines).map(Number)).toEqual(segs.map((s) => s.id));
    const mara = segs.find((s) => s.text.startsWith("We are"))!;
    const heard = lines[mara.id];
    expect(heard).toMatchObject({ text: mara.text, heard: mara.text, score: 0, mismatch: false });
    expect(heard.words!.map(([from, to]) => mara.text.slice(from, to))).toEqual([
      "We",
      "are",
      "short",
      "again",
    ]);
    expect(heard.words![1].slice(2)).toEqual([1 / 3, 1 / 3 + 0.3]);

    const rows = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=transcription&id=phonon&range=1h",
    );
    expect(rows.body.requests).toHaveLength(segs.length);
    expect(rows.body.requests[0]).toMatchObject({
      kind: "transcription",
      bookId: id,
      label: "Check · One",
    });
    const seconds = segs.reduce((n, s) => n + s.audio.duration, 0);
    const cost = rows.body.requests.reduce((n, r) => n + (r.cost ?? 0), 0);
    expect(cost).toBeCloseTo((seconds / 60) * 0.6, 6);
  });

  test("flags a clip heard saying something else, takes a heard flag down, and leaves a person's", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;
    const [wrong, mine, right] = segs;
    // a person flagged one line; an earlier check had flagged another that it now hears right
    await api.request(`/api/books/${id}/chapters/1/lines/${mine.id}/flag`, {
      ...jsonBody({ kind: "delivery", note: "too flat" }),
      method: "PUT",
    });
    api.db.transaction((tx) =>
      setFlag(tx, id, 1, right.id, { kind: "heard", note: "Heard: “nothing”", at: 1 }),
    );
    const said = "The ledger burned in the hearth while the rain kept on.";
    e.say = (s) =>
      s.id === wrong.id || s.id === mine.id
        ? { text: said, words: timed(said) }
        : { text: s.text, words: timed(s.text) };

    const before = (await scriptOf(api, id)).revision;
    const { body } = await checked(api, id);
    const after = await scriptOf(api, id);
    const by = new Map(after.segments.map((s) => [s.id, s]));
    expect(by.get(wrong.id)!.flag).toMatchObject({ kind: "heard", note: `Heard: “${said}”` });
    expect(by.get(mine.id)!.flag).toMatchObject({ kind: "delivery", note: "too flat" });
    expect(by.get(right.id)!.flag).toBeUndefined();
    // the browser re-reads a chapter whose flags moved
    expect(after.revision).toBeGreaterThan(before);

    const lines = await heardOf(api, id);
    expect(lines[wrong.id]).toMatchObject({ heard: said, mismatch: true });
    expect(lines[mine.id].mismatch).toBe(true);
    expect((await jobById(api, body.jobs[0].id)).checkRun).toMatchObject({ mismatched: 2 });
  });

  test("a chapter already heard is left out, and a line edited since is heard again", async () => {
    const { api, id, e } = await narrated();
    await checked(api, id);
    const asked = e.asked.length;

    const again = await checked(api, id, [1, 2, 9]);
    expect(again.body.jobs).toEqual([]);
    expect(again.body.skipped).toEqual([
      { id: 1, why: "nothing" },
      { id: 2, why: "unnarrated" },
      { id: 9, why: "missing" },
    ]);
    expect(e.asked).toHaveLength(asked);

    // the line's words change and its clip does not: the clip no longer says the line
    const script = await scriptOf(api, id);
    const [first, ...rest] = script.segments;
    const edited = { ...first, text: `${first.text} Twice.` };
    const { status } = await api.request(`/api/books/${id}/chapters/1/script`, {
      ...jsonBody({ segments: [edited, ...rest], ifRevision: script.revision }),
      method: "PUT",
    });
    expect(status).toBe(200);
    e.say = () => ({ text: first.text, words: timed(first.text) });
    const queued = await checked(api, id);
    expect(queued.body.jobs).toHaveLength(1);
    expect(e.asked).toHaveLength(asked + 1);
    expect((await heardOf(api, id))[first.id]).toMatchObject({
      text: edited.text,
      heard: first.text,
      mismatch: true,
    });
  });

  test("a request that fails is counted and the rest of the chapter is still heard", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;
    e.fail = (s) => s.id === segs[1].id;
    const { body } = await checked(api, id);
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.checkRun).toMatchObject({ checked: segs.length - 1, failed: 1 });
    expect(job.activity?.some((a) => a.message === `Line ${segs[1].id} could not be heard`)).toBe(
      true,
    );
    const lines = await heardOf(api, id);
    expect(Object.keys(lines).map(Number)).toEqual(
      segs.filter((s) => s.id !== segs[1].id).map((s) => s.id),
    );
    // nothing a check does touches a clip
    expect((await scriptOf(api, id)).segments.map((s) => s.audio)).toEqual(
      segs.map((s) => s.audio),
    );

    // a retry hears only the line it missed
    e.fail = () => false;
    const asked = e.asked.length;
    await checked(api, id);
    expect(e.asked).toHaveLength(asked + 1);
  });

  test("is refused whole when no transcription endpoint is switched on", async () => {
    const { api, id, e } = await narrated(ears(), {
      transcribers: [transcriber({ enabled: false })],
    });
    const { status, body } = await check(api, id, [1]);
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toBe(
      "No transcription endpoint is switched on. Add one on the Endpoints page.",
    );
    expect(listJobs(api.db).filter((j) => j.kind === "check")).toEqual([]);
    expect(e.asked).toEqual([]);
  });

  test("follows a narration by itself only when the book checks by ear", async () => {
    const { api, id } = await narrated();
    // chapter 1 was narrated before anyone asked
    expect(listJobs(api.db).filter((j) => j.kind === "check")).toEqual([]);

    const patched = await api.request<ImportedBook>(`/api/books/${id}`, {
      ...jsonBody({ checkByEar: true }),
      method: "PATCH",
    });
    expect(patched.body.book.checkByEar).toBe(true);
    await narrateChapters(api, id, [2]);
    const checks = listJobs(api.db).filter((j) => j.kind === "check");
    expect(checks.map((j) => [j.chapterId, j.status])).toEqual([[2, "done"]]);
    expect(Object.keys(await heardOf(api, id, 2)).length).toBeGreaterThan(0);
  });
});
