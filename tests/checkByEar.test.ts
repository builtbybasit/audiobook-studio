// Checking narration by ear, the browser's half: asking for a check, the queue noticing one move,
// and the flag it raises reading like the others.
//
// The check itself is the server's — what it hears, what it flags, what it leaves a person's flag
// alone for — and is tested there (`tests/server/`). What is tested here is what the page does
// with it: the run is asked for and reported the way a narration run is, a check that moves has
// what it heard and the script it flagged read again, and a heard flag is listed with the rest.
//
// The services are fakes that answer only what each test asks of them, over a book put straight
// into the library store: none of this needs the server's world.
import { beforeEach, describe, expect, test } from "bun:test";
import { useQuery } from "@pinia/colada";

import { FLAG_LABEL, flagText } from "@/lib/scriptReview";
import { useBookJobs } from "@/queries";
import { useChapterHeard } from "@/queries/chapterHeard";
import { keys } from "@/queries/keys";
import { ApiError } from "@/services/http";
import { setJobsService, type JobsService } from "@/services/jobs";
import { libraryService, setLibraryService, type LibraryService } from "@/services/library";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { reviewInbox } from "@/views/review/inbox";
import type { Book, Chapter, CheckQueued, Job, Segment } from "@/types";
import { flush, testPinia, type TestPinia } from "./support/pinia";

const BOOK = "heard";
const chapter = (id: number): Chapter =>
  ({ id, title: `Chapter ${id}`, scripting: "done", narration: "done" }) as Chapter;
const line = (id: number, over: Partial<Segment> = {}): Segment =>
  ({
    id,
    type: "narration",
    speaker: "Narrator",
    text: "The door opened.",
    audio: { status: "done", duration: 1.2 },
    ...over,
  }) as Segment;

let pinia: TestPinia;
let toasts: { msg: string; kind?: string; description?: string }[];

beforeEach(() => {
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  pinia?.stop();
  pinia = testPinia();
  toasts = [];
  useUiStore().toast = (msg, opts = {}) => (
    toasts.push({ msg, kind: opts.kind, description: opts.description }),
    ""
  );
  useLibraryStore()._put({ id: BOOK, title: "Heard", author: "", volumes: [] } as unknown as Book, [
    chapter(1),
    chapter(2),
  ]);
});

/** A jobs service that answers `checkChapters` with `answer` and the queue with nothing. */
function checking(answer: () => Promise<CheckQueued>): number[][] {
  const asked: number[][] = [];
  setJobsService({
    list: async () => [],
    checkChapters: async (_book: string, ids: number[]) => (asked.push(ids), answer()),
  } as unknown as JobsService);
  return asked;
}

const checkJob = (id: number, chapterId: number, over: Partial<Job> = {}): Job => ({
  id,
  kind: "check",
  bookId: BOOK,
  chapterId,
  label: `Check · ch ${chapterId}`,
  status: "queued",
  progress: 0,
  queuedAt: id,
  startedAt: null,
  finishedAt: null,
  cancelled: false,
  ...over,
});

describe("asking for a check", () => {
  test("queues the chapters and says which were left out, and why", async () => {
    const asked = checking(async () => ({
      jobs: [checkJob(1, 1)],
      skipped: [
        { id: 2, why: "unnarrated" },
        { id: 3, why: "nothing" },
      ],
      runId: 9,
      chapters: [chapter(1), chapter(2)],
    }));
    expect(await useJobsStore().checkChapters(BOOK, [1, 2, 3])).toBe(true);
    expect(asked).toEqual([[1, 2, 3]]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].msg).toBe("Check by ear · 1 chapter");
    expect(toasts[0].description).toContain(
      "Left out: 1 chapter not narrated yet; 1 chapter already heard.",
    );
  });

  test("a selection with nothing to hear queues nothing and warns", async () => {
    checking(async () => ({
      jobs: [],
      skipped: [{ id: 1, why: "busy" }],
      runId: 9,
      chapters: [chapter(1), chapter(2)],
    }));
    expect(await useJobsStore().checkChapters(BOOK, [1])).toBe(false);
    expect(toasts).toEqual([
      {
        msg: "Nothing to check in this selection",
        kind: "warn",
        description: "1 chapter already being narrated or checked",
      },
    ]);
  });

  test("with no transcription endpoint switched on, the server's sentence is the toast", async () => {
    const refusal = "No transcription endpoint is switched on";
    checking(async () => {
      throw new ApiError(refusal, 400);
    });
    expect(await useJobsStore().checkChapters(BOOK, [1])).toBe(false);
    expect(toasts.map((t) => [t.msg, t.kind])).toEqual([[refusal, "error"]]);
  });

  test("a paused book is not checked, and nothing is sent", async () => {
    const asked = checking(async () => {
      throw new Error("sent");
    });
    useLibraryStore().bookById(BOOK)!.budget = { cap: null, paused: true };
    expect(await useJobsStore().checkChapters(BOOK, [1])).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("a check that moves", () => {
  test("has what it heard of its chapter and the chapter's script read again", async () => {
    let queue: Job[] = [checkJob(1, 1)];
    setJobsService({ list: async () => queue } as unknown as JobsService);
    const reads = { heard: [] as number[], script: [] as number[] };
    const real = libraryService();
    setLibraryService(
      Object.assign(Object.create(real) as LibraryService, {
        book: async () => ({
          book: useLibraryStore().bookById(BOOK)!,
          chapters: useLibraryStore().chaptersOf(BOOK),
        }),
        chapterHeard: async (_b: string, ch: number) => (reads.heard.push(ch), {}),
        chapterScript: async (_b: string, ch: number) => (
          reads.script.push(ch),
          { segments: [line(1)], revision: 1 }
        ),
      }),
    );
    const jobs = pinia.run(() => useBookJobs());
    // the Narration page's reads of chapter 1, and an unrelated chapter's script that must stay put
    pinia.run(() => useChapterHeard(BOOK, 1));
    pinia.run(() =>
      useQuery({
        key: keys.chapterScript(BOOK, 1),
        staleTime: Infinity,
        query: () => libraryService().chapterScript(BOOK, 1),
      }),
    );
    pinia.run(() =>
      useQuery({
        key: keys.chapterScript(BOOK, 2),
        staleTime: Infinity,
        query: () => libraryService().chapterScript(BOOK, 2),
      }),
    );
    await jobs.refetch();
    await flush();
    expect(reads).toEqual({ heard: [1], script: [1, 2] });

    queue = [checkJob(1, 1, { status: "running", progress: 40, startedAt: 2 })];
    await jobs.refetch();
    await flush();
    await flush();
    expect(reads).toEqual({ heard: [1, 1], script: [1, 2, 1] });

    // a poll that finds it where it was asks for nothing
    await jobs.refetch();
    await flush();
    expect(reads).toEqual({ heard: [1, 1], script: [1, 2, 1] });
  });
});

describe("a heard flag", () => {
  test("is listed with the other flags, saying what was heard", () => {
    const flag = { kind: "heard" as const, note: "Heard: “The floor opened.”", at: 5 };
    useScriptsStore()._install(BOOK, 1, { segments: [line(1, { flag }), line(2)], revision: 1 });
    expect(FLAG_LABEL.heard).toBe("heard saying something else");
    const flagged = reviewInbox(BOOK).find((g) => g.kind === "flagged")!;
    expect(flagged.items).toHaveLength(1);
    expect(flagged.items[0]).toMatchObject({
      detail: flagText(flag),
      at: 5,
      to: { query: { ch: "1", filter: "flagged", seg: "1" } },
    });
    expect(flagged.items[0].detail).toContain("The floor opened.");
    expect(flagged.blurb).toContain("check by ear");
  });
});
