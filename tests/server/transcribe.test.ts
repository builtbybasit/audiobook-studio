// Transcribing: a narrated chapter's clips transcribed and set against their lines. The finding
// is kept by clip file; a mismatch flags the line, a match clears a `heard` flag, a person's flag is
// left alone; priced by the minute; queued after narration when the book asks. `ears` picks what
// the transcription endpoint hears per line, finding the line by the clip's file name.
import { describe, expect, test } from "bun:test";

import type {
  ChapterHeard,
  ChapterScript,
  TranscribeQueued,
  ImportedBook,
  Job,
  RequestRecord,
  Segment,
  Transcriber,
} from "@/types";
import { listJobs } from "~/db/jobs";
import { transcribeHandler, enqueueTranscribe } from "~/jobs/transcribe";
import { createSpeechGate } from "~/providers/gate";
import { readScript, setFlag } from "~/db/script";
import { ProviderError } from "~/providers/http";
import type {
  Transcript,
  TranscriptionInput,
  TranscriptionProvider,
} from "~/providers/transcription";
import { epubFile, story } from "../support/epub";
import {
  door,
  jobContext,
  jsonBody,
  narrateChapters,
  queueOnly,
  testApi,
  type TestApi,
} from "../support/server";

const transcriber = (over: Partial<Transcriber> = {}): Transcriber => ({
  id: "phonon",
  name: "Phonon",
  baseUrl: "http://127.0.0.1:8010/v1",
  model: "phonon-2.5-en",
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
 * A transcription endpoint that hears what `say` makes of a clip's line (the line itself by
 * default) and fails the lines `fail` picks. Every answer is reported and billed like the real one.
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
    },
  };
  return ears;
}

const saveTranscribers = (api: TestApi, ...transcribers: Transcriber[]) =>
  api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [], profiles: [], transcribers, credentials: [] }),
    method: "PUT",
  });

/** Two scripted chapters, the first narrated (through `lexicon` if given), transcription on. */
async function narrated(
  e = ears(),
  { transcribers = [transcriber()], lexicon = [] as { term: string; say: string }[] } = {},
) {
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
  if (lexicon.length)
    await api.request(`/api/books/${id}/lexicon`, {
      ...jsonBody({ entries: lexicon.map((x, i) => ({ id: i + 1, ...x, enabled: true })) }),
      method: "PUT",
    });
  await narrateChapters(api, id, [1]);
  e.book.api = api;
  e.book.id = id;
  return { api, id, e };
}

const transcribe = (api: TestApi, id: string, ids: number[], again?: boolean) =>
  api.request<TranscribeQueued>(`/api/books/${id}/chapters/transcribe`, jsonBody({ ids, again }));

async function transcribed(api: TestApi, id: string, ids = [1], again?: boolean) {
  const queued = await transcribe(api, id, ids, again);
  await api.runner.idle();
  return queued;
}

const heardOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<{ lines: ChapterHeard }>(`/api/books/${id}/chapters/${ch}/heard`)).body.lines;

const scriptOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<ChapterScript>(`/api/books/${id}/chapters/${ch}/script`)).body;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

describe("transcribing a chapter", () => {
  test("hears every clip once, keeps what it heard with its word marks, and prices it", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;

    const { status, body } = await transcribed(api, id);
    expect(status).toBe(202);
    expect(body.skipped).toEqual([]);
    expect(body.jobs.map((j) => [j.kind, j.chapterId])).toEqual([["transcribe", 1]]);
    expect(e.asked).toHaveLength(segs.length);
    // a clip is sent the cast's names its line is written with, the narrator's never
    const hinted = e.asked.map((a) => ({
      text: segs.find((s) => s.audio.url?.endsWith(`/${a.name}`))!.text,
      hints: a.hints ?? [],
    }));
    for (const { text, hints } of hinted) for (const h of hints) expect(text).toContain(h);
    expect(hinted.find((x) => x.text.includes("Mara"))?.hints).toContain("Mara");
    expect(hinted.flatMap((x) => x.hints)).not.toContain("Narrator");
    expect(e.asked[0].words).toBe(true);

    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("done");
    expect(job.transcribeRun).toEqual({
      endpoint: "phonon",
      lines: segs.length,
      transcribed: segs.length,
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
      label: "Transcribe",
    });
    const seconds = segs.reduce((n, s) => n + s.audio.duration, 0);
    const cost = rows.body.requests.reduce((n, r) => n + (r.cost ?? 0), 0);
    expect(cost).toBeCloseTo((seconds / 60) * 0.6, 6);
  });

  test("flags a clip heard saying something else, takes a mismatch flag down, and leaves a person's", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;
    const [wrong, mine, right] = segs;
    // a person flagged one line; an earlier transcription had flagged another that it now hears right
    await api.request(`/api/books/${id}/chapters/1/lines/${mine.id}/flag`, {
      ...jsonBody({ kind: "delivery", note: "too flat" }),
      method: "PUT",
    });
    api.db.transaction((tx) =>
      setFlag(tx, id, 1, right.id, { kind: "mismatch", note: "Heard: “nothing”", at: 1 }),
    );
    const said = "The ledger burned in the hearth while the rain kept on.";
    e.say = (s) =>
      s.id === wrong.id || s.id === mine.id
        ? { text: said, words: timed(said) }
        : { text: s.text, words: timed(s.text) };

    const before = (await scriptOf(api, id)).revision;
    const { body } = await transcribed(api, id);
    const after = await scriptOf(api, id);
    const by = new Map(after.segments.map((s) => [s.id, s]));
    expect(by.get(wrong.id)!.flag).toMatchObject({ kind: "mismatch", note: `Heard: “${said}”` });
    expect(by.get(mine.id)!.flag).toMatchObject({ kind: "delivery", note: "too flat" });
    expect(by.get(right.id)!.flag).toBeUndefined();
    // the browser re-reads a chapter whose flags moved
    expect(after.revision).toBeGreaterThan(before);

    const lines = await heardOf(api, id);
    expect(lines[wrong.id]).toMatchObject({ heard: said, mismatch: true });
    expect(lines[mine.id].mismatch).toBe(true);
    expect((await jobById(api, body.jobs[0].id)).transcribeRun).toMatchObject({ mismatched: 2 });
  });

  test("a chapter already heard is left out, and a line edited since is heard again", async () => {
    const { api, id, e } = await narrated();
    await transcribed(api, id);
    const asked = e.asked.length;

    const again = await transcribed(api, id, [1, 2, 9]);
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
    const queued = await transcribed(api, id);
    expect(queued.body.jobs).toHaveLength(1);
    expect(e.asked).toHaveLength(asked + 1);
    expect((await heardOf(api, id))[first.id]).toMatchObject({
      text: edited.text,
      heard: first.text,
      mismatch: true,
    });
  });

  test("transcribed again, every clip is heard, those already heard too", async () => {
    const { api, id, e } = await narrated();
    await transcribed(api, id);
    const asked = e.asked.length;
    expect((await transcribed(api, id)).body.skipped).toEqual([{ id: 1, why: "nothing" }]);

    // heard as something else this time: the finding is replaced, and the line flagged
    const first = (await scriptOf(api, id)).segments[0];
    e.say = (s) => ({ text: s.id === first.id ? "Something else entirely" : s.text });
    const again = await transcribed(api, id, [1], true);
    expect(again.body.jobs[0].transcribeRun).toMatchObject({ again: true, lines: asked });
    expect(e.asked).toHaveLength(2 * asked);
    expect((await heardOf(api, id))[first.id]).toMatchObject({ mismatch: true });
    expect((await scriptOf(api, id)).segments[0].flag?.kind).toBe("mismatch");
  });

  test("a name the dictionary respells is heard right as it was sent", async () => {
    const { api, id, e } = await narrated(ears(), {
      lexicon: [{ term: "Mara", say: "Shiv-awn" }],
    });
    const first = (await scriptOf(api, id)).segments.find((s) => s.text.includes("Mara"))!;
    expect(first.audio.pronounced).toContain("Shiv-awn");
    const sent = first.text.replace("Mara", "Shiv awn");
    e.say = (s) => (s.id === first.id ? { text: sent, words: timed(sent) } : { text: s.text });
    await transcribed(api, id);
    const heard = (await heardOf(api, id))[first.id];
    expect(heard).toMatchObject({ heard: sent, mismatch: false });
    const marks = heard.words!.map(([from, to]) => first.text.slice(from, to));
    expect(marks).toContain("Mara");
  });

  test("a request that fails is counted and the rest of the chapter is still heard", async () => {
    const { api, id, e } = await narrated();
    const segs = (await scriptOf(api, id)).segments;
    e.fail = (s) => s.id === segs[1].id;
    const { body } = await transcribed(api, id);
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.transcribeRun).toMatchObject({ transcribed: segs.length - 1, failed: 1 });
    expect(job.activity?.some((a) => a.message === `Line ${segs[1].id} could not be heard`)).toBe(
      true,
    );
    const lines = await heardOf(api, id);
    expect(Object.keys(lines).map(Number)).toEqual(
      segs.filter((s) => s.id !== segs[1].id).map((s) => s.id),
    );
    // nothing a transcription does touches a clip
    expect((await scriptOf(api, id)).segments.map((s) => s.audio)).toEqual(
      segs.map((s) => s.audio),
    );

    // a retry hears only the line it missed
    e.fail = () => false;
    const asked = e.asked.length;
    await transcribed(api, id);
    expect(e.asked).toHaveLength(asked + 1);
  });

  test("two chapters' transcriptions on one endpoint share its concurrency: never more out at once", async () => {
    const { api, id, e } = await narrated();
    await narrateChapters(api, id, [2]);
    const held = door();
    const provider: TranscriptionProvider = {
      name: e.provider.name,
      transcribe: (input, target) => held.through(() => e.provider.transcribe(input, target)),
    };
    // run by hand, both at once, whatever the runner would do
    await api.runner.stop();
    const { jobs } = enqueueTranscribe(api.db, queueOnly(api.db), id, [1, 2]);
    const gate = createSpeechGate();
    const handler = transcribeHandler(provider, api.files, gate);
    const runs = jobs.map((job) => handler.run(jobContext(api.db, job)));

    // transcriber() takes two at once
    await held.reached(2);
    expect(held.inside).toBe(2);
    expect(gate.live().phonon.waiting).toBeGreaterThan(0);
    held.open();
    await Promise.all(runs);
    expect(held.most).toBe(2);
  });

  test("is refused whole when no transcription endpoint is switched on", async () => {
    const { api, id, e } = await narrated(ears(), {
      transcribers: [transcriber({ enabled: false })],
    });
    const { status, body } = await transcribe(api, id, [1]);
    expect(status).toBe(400);
    expect((body as unknown as { error: { message: string } }).error.message).toBe(
      "No transcription endpoint is switched on. Add one on the Endpoints page.",
    );
    expect(listJobs(api.db).filter((j) => j.kind === "transcribe")).toEqual([]);
    expect(e.asked).toEqual([]);
  });

  test("follows a narration by itself only when the book transcribes after narration", async () => {
    const { api, id } = await narrated();
    // chapter 1 was narrated before anyone asked
    expect(listJobs(api.db).filter((j) => j.kind === "transcribe")).toEqual([]);

    const patched = await api.request<ImportedBook>(`/api/books/${id}`, {
      ...jsonBody({ autoTranscribe: true }),
      method: "PATCH",
    });
    expect(patched.body.book.autoTranscribe).toBe(true);
    await narrateChapters(api, id, [2]);
    const runs = listJobs(api.db).filter((j) => j.kind === "transcribe");
    expect(runs.map((j) => [j.chapterId, j.status])).toEqual([[2, "done"]]);
    expect(Object.keys(await heardOf(api, id, 2)).length).toBeGreaterThan(0);
  });
});
