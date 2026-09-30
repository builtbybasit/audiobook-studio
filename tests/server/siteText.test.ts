// Site text on the server: marked, never stripped, and never read.
//
// A chapter's script keeps every word of the prose, so a site's boilerplate and a translator's note
// are lines of their own (`watermark`, `note`) rather than words taken out. What that has to mean
// on the server is tested here: the detector's second opinion after a chapter is scripted, the
// suggestion kept and cleared by an edit, and — the rule everything else follows — a line the book
// does not read has no clip to want, is never sent, counts as no gap and is not in the audiobook.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter, Job, Segment, SegmentType } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { readScript } from "~/db/script";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { ScriptingProvider } from "~/providers/scripting";
import { REPEATED_IN, siteChecks, STORY_WORDS, storyWhy } from "~/script/siteCheck";
import { epubFile, story } from "../support/epub";
import {
  jsonBody,
  narrateChapters,
  scriptChapters,
  testApi,
  type TestApi,
} from "../support/server";

interface BookResult {
  book: Book;
  chapters: Chapter[];
}
interface ScriptResult {
  segments: Segment[];
  revision: number;
}

const line = (id: number, type: SegmentType, text: string): Segment => ({
  id,
  type,
  speaker: "Narrator",
  text,
  direction: "",
  audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("the detector", () => {
  test("suggests site text for a story line that gives itself away, and for one the book repeats", () => {
    const repeated = "Thank you all for reading along with us tonight.";
    const checked = siteChecks(
      [
        line(1, "narration", "Read the latest chapters at novelhub.com."),
        line(2, "dialogue", repeated),
        line(3, "narration", "The clerk wrote on without looking up."),
      ],
      (folded) => (folded === repeated.toLowerCase() ? REPEATED_IN : 0),
    );
    expect(checked[0].siteCheck).toMatchObject({ suggest: "watermark" });
    expect(checked[0].siteCheck?.why).toContain("names a web address");
    expect(checked[1].siteCheck).toEqual({
      suggest: "watermark",
      why: `repeated in ${REPEATED_IN} chapters`,
    });
    expect(checked[2].siteCheck).toBeUndefined();
  });

  test("does not count a short line's repeats, nor a line in fewer chapters than it takes", () => {
    const asked: string[] = [];
    const checked = siteChecks(
      [line(1, "dialogue", "Yes, of course."), line(2, "narration", "He nodded and turned away.")],
      (folded) => {
        asked.push(folded);
        return folded.startsWith("yes") ? 40 : REPEATED_IN - 1;
      },
    );
    // "Yes, of course." is in every chapter of every book; its count is not even asked
    expect(asked).toEqual(["he nodded and turned away."]);
    expect(checked.every((s) => !s.siteCheck)).toBe(true);
  });

  test("suggests story for a long line marked as site text that nothing gives away", () => {
    const checked = siteChecks(
      [
        line(1, "watermark", words(STORY_WORDS + 1)),
        line(2, "watermark", words(STORY_WORDS)),
        line(3, "note", `(TL note: ${words(STORY_WORDS + 10)})`),
      ],
      () => 0,
    );
    expect(checked[0].siteCheck).toEqual({
      suggest: "narration",
      why: storyWhy(STORY_WORDS + 1),
    });
    // short enough to be boilerplate, and a note that says it is one
    expect(checked[1].siteCheck).toBeUndefined();
    expect(checked[2].siteCheck).toBeUndefined();
  });
});

/** A model that types each paragraph as `typeOf` says, whole, and never the network. */
const typing = (typeOf: (paragraph: string) => SegmentType): ScriptingProvider => ({
  name: "Typing",
  async script({ text }) {
    return text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ type: typeOf(p), speaker: "Narrator", text: p }));
  },
});

describe("a scripting run", () => {
  test("writes the detector's suggestions with the script, and says what it marked", async () => {
    const repeated = "Thank you all for reading along with us tonight.";
    const address = "Visit example.com for the maps.";
    const long = `The rain kept on. ${words(STORY_WORDS)}`;
    const api = testApi({
      scripting: typing((p) => (p === long ? "watermark" : "narration")),
    });
    const chapter = (title: string, extra: string[] = []) => ({
      title,
      paragraphs: [`${title} began in the counting house.`, "He nodded again.", repeated, ...extra],
    });
    const { body } = await api.import<BookResult>(
      await epubFile({
        chapters: [
          chapter("One"),
          chapter("Two"),
          chapter("Three"),
          chapter("Four"),
          chapter("Five", [address, long]),
        ],
      }),
    );
    const id = body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    // one run, in order: chapter n finds the repeated line in the n - 1 chapters before it
    const queued = await api.request<{ jobs: Job[] }>(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1, 2, 3, 4, 5] }),
    );
    await api.runner.idle();

    const checkOf = (chapterId: number, text: string) =>
      readScript(api.db, id, chapterId).find((s) => s.text === text)?.siteCheck;
    expect(checkOf(3, repeated)).toBeUndefined();
    expect(checkOf(4, repeated)).toEqual({ suggest: "watermark", why: "repeated in 3 chapters" });
    expect(checkOf(5, repeated)).toEqual({ suggest: "watermark", why: "repeated in 4 chapters" });
    expect(checkOf(5, "He nodded again.")).toBeUndefined();
    expect(checkOf(5, address)?.why).toContain("names a web address");
    expect(checkOf(5, long)).toMatchObject({ suggest: "narration" });
    expect(checkOf(5, long)?.why).toContain("nothing in them gives site text away");

    const activity = async (n: number) =>
      (await api.request<{ job: Job }>(`/api/jobs/${queued.body.jobs[n - 1].id}`)).body.job
        .activity ?? [];
    const five = await activity(5);
    expect(five.map((e) => e.message)).toContain("1 line marked as site text, 0 notes, 3 to check");
    // most of chapter five's words are on its one watermark line, and nothing is read of them
    expect(five.find((e) => e.level === "warning")?.message).toMatch(/^\d+% of this chapter/);
    // a chapter with nothing marked and nothing to check says nothing about it
    expect((await activity(1)).some((e) => e.message.includes("site text"))).toBe(false);
  });
});

// ---------- a narrated chapter with site text in it ----------

const TEXT = {
  said: "We are short again,",
  watermark: "Read the latest chapters at novelhub.com.",
  note: "(TL note: a ledger is an account book.)",
};

/**
 * A chapter the fake scripts into dialogue and narration, a watermark and a note, narrated, with
 * what each request was sent kept.
 */
async function narrated(api?: TestApi) {
  const sent: string[] = [];
  const speech = fakeSpeechProvider();
  api ??= testApi({
    speech: { ...speech, speak: (input) => (sent.push(input.text), speech.speak(input)) },
  });
  const { body } = await api.import<BookResult>(
    await epubFile({
      chapters: [
        {
          title: "One",
          paragraphs: [`“${TEXT.said}” said Mara.`, TEXT.watermark, TEXT.note, ...story(1)],
        },
      ],
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await scriptChapters(api, id, [1]);
  await narrateChapters(api, id, [1]);
  return { api, id, sent };
}

const chapterOf = async (api: TestApi, id: string) =>
  (await api.request<BookResult>(`/api/books/${id}`)).body.chapters[0];

const scriptOf = async (api: TestApi, id: string) =>
  (await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`)).body;

/** Write the chapter's script with `change` made to it, as the reader does. */
async function edit(api: TestApi, id: string, change: (segs: Segment[]) => Segment[]) {
  const { segments, revision } = await scriptOf(api, id);
  return api.request<ScriptResult & { history: { versions: unknown[] } }>(
    `/api/books/${id}/chapters/1/script`,
    { ...jsonBody({ segments: change(segments), ifRevision: revision }), method: "PUT" },
  );
}
const retype = (text: string, type: SegmentType) => (segs: Segment[]) =>
  segs.map((s) => (s.text === text ? { ...s, type } : s));

describe("a line the book does not read", () => {
  test("is never sent, is no gap, and is counted apart", async () => {
    const { api, id, sent } = await narrated();
    expect(sent).toContain(TEXT.said);
    expect(sent).not.toContain(TEXT.watermark);
    expect(sent).not.toContain(TEXT.note);

    const segs = readScript(api.db, id, 1);
    const chapter = await chapterOf(api, id);
    expect(chapter.narration).toBe("done");
    expect(chapter.lines).toEqual({
      total: segs.length - 2,
      done: segs.length - 2,
      generating: 0,
      failed: 0,
      skipped: 2,
    });

    // nor can one be asked for by hand
    const watermark = segs.find((s) => s.type === "watermark")!;
    const retake = await api.request<{ skipped: { id: number; why: string }[] }>(
      `/api/books/${id}/chapters/1/retakes`,
      jsonBody({ ids: [watermark.id] }),
    );
    expect(retake.body.skipped).toEqual([{ id: watermark.id, why: "unspoken" }]);
  });

  test("marked by an edit, keeps its clip out of the chapter's length and the audiobook, and back as story plays again with no render", async () => {
    const { api, id, sent } = await narrated();
    const before = await chapterOf(api, id);
    const clip = readScript(api.db, id, 1).find((s) => s.text === TEXT.said)!.audio;

    expect((await edit(api, id, retype(TEXT.said, "watermark"))).status).toBe(200);
    const marked = await chapterOf(api, id);
    expect(marked.narration).toBe("done");
    expect(marked.duration).toBeLessThan(before.duration);
    // the clip is kept, so marking the line back costs nothing
    expect(readScript(api.db, id, 1).find((s) => s.text === TEXT.said)!.audio.url).toBe(clip.url);

    const built = await api.request<{ export: { id: number } }>(
      `/api/books/${id}/exports`,
      jsonBody({ ids: [1], settings: { ...DEFAULT_EXPORT_SETTINGS, title: "One" } }),
    );
    expect(built.status).toBe(202);
    await api.runner.idle();
    const exported = (
      await api.request<{ export: { status: string; duration: number } }>(
        `/api/books/${id}/exports/${built.body.export.id}`,
      )
    ).body.export;
    expect(exported.status).toBe("done");
    expect(exported.duration).toBeCloseTo(marked.duration, 1);

    await edit(api, id, retype(TEXT.said, "dialogue"));
    const back = await chapterOf(api, id);
    expect(back.narration).toBe("done");
    expect(back.duration).toBeCloseTo(before.duration, 6);
    const rendered = sent.length;
    const again = await api.request<{ skipped: { id: number; why: string }[] }>(
      `/api/books/${id}/chapters/narrate`,
      jsonBody({ ids: [1], scope: "fill" }),
    );
    expect(again.body.skipped).toEqual([{ id: 1, why: "nothing" }]);
    await api.runner.idle();
    expect(sent).toHaveLength(rendered);
  });

  test("marked back as story by an edit is a gap until it is rendered", async () => {
    const { api, id } = await narrated();
    await edit(api, id, retype(TEXT.note, "narration"));
    expect((await chapterOf(api, id)).narration).toBe("failed");
    await edit(api, id, retype(TEXT.note, "note"));
    expect((await chapterOf(api, id)).narration).toBe("done");
  });
});

describe("a book that reads its notes", () => {
  test("wants their clips: on, the chapter is partly narrated until a run renders them; off, narrated again", async () => {
    const { api, id, sent } = await narrated();
    const before = await chapterOf(api, id);
    const patch = (readNotes: boolean) =>
      api.request<BookResult>(`/api/books/${id}`, {
        ...jsonBody({ readNotes }),
        method: "PATCH",
      });

    const on = await patch(true);
    expect(on.body.book.readNotes).toBe(true);
    expect(on.body.chapters[0].narration).toBe("failed");
    expect(on.body.chapters[0].lines).toMatchObject({ skipped: 1 });

    const rendered = sent.length;
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1], scope: "fill" }));
    await api.runner.idle();
    expect(sent.slice(rendered)).toEqual([TEXT.note]);
    const read = await chapterOf(api, id);
    expect(read.narration).toBe("done");
    expect(read.duration).toBeGreaterThan(before.duration);

    const off = await patch(false);
    expect(off.body.chapters[0].narration).toBe("done");
    // the note's clip is kept, and not heard
    expect(off.body.chapters[0].duration).toBeCloseTo(before.duration, 6);
    expect((await api.request<BookResult>(`/api/books/${id}`)).body.book.readNotes).toBe(false);
  });
});

describe("a suggestion", () => {
  test("is kept by an edit, cleared by a change of type, and dismissed without a version", async () => {
    const { api, id } = await narrated();
    const check = { suggest: "narration" as const, why: "reads like story" };
    const suggest = (segs: Segment[]) =>
      segs.map((s) => (s.text === TEXT.watermark ? { ...s, siteCheck: check } : s));
    await edit(api, id, suggest);
    const kept = (await scriptOf(api, id)).segments.find((s) => s.text === TEXT.watermark);
    expect(kept?.siteCheck).toEqual(check);

    // dismissed: the suggestion goes, and the script is the same script, so no version
    const versions = (await edit(api, id, suggest)).body.history.versions.length;
    const dismissed = await edit(api, id, (segs) =>
      segs.map((s) => ({ ...s, siteCheck: undefined })),
    );
    expect(dismissed.body.segments.every((s) => !s.siteCheck)).toBe(true);
    expect(dismissed.body.history.versions).toHaveLength(versions);

    // taken: the line's new type is the person's decision, whatever copy of the suggestion rode along
    await edit(api, id, suggest);
    const taken = await edit(api, id, (segs) => retype(TEXT.watermark, "narration")(suggest(segs)));
    const line = taken.body.segments.find((s) => s.text === TEXT.watermark)!;
    expect(line.type).toBe("narration");
    expect(line.siteCheck).toBeUndefined();
  });
});
