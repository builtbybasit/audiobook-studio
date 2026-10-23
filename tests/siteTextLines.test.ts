// Site text in the stores: a suggestion accepted or dismissed, saved and undone like any edit;
// lines the book does not read left out of who-speaks counts; and the "read the notes aloud"
// setting; and the marks a run leaves on lines it mended. Each test writes the chapter's script
// straight into this file's own server.
import { beforeAll, beforeEach, expect, test } from "bun:test";

import { NARRATOR } from "@/lib/cast";
import { countsSettled, useSpeakerCounts } from "@/queries";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import type { Book, Mend, Segment } from "@/types";
import { readScript, writeScript } from "~/db/script";
import { backendServer } from "./support/backendServer";
import { openDemoBook } from "./support/demoBook";
import { epubFile, story } from "./support/epub";
import { testPinia, type TestPinia } from "./support/pinia";
import { scriptChapters, type TestApi } from "./support/server";

let api: TestApi;
let BOOK: string;
/** the chapter's script as the scripting run left it, which each test starts from */
let scripted: Segment[];

let pinia: TestPinia;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
/** the Undo of every toast that offered one, newest last */
let undos: (() => void)[];

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  api = backendServer();
  const { body } = await api.import<{ book: Book }>(
    await epubFile({ chapters: [{ title: "One", paragraphs: story(3) }] }),
  );
  BOOK = body.book.id;
  await api.request(`/api/books/${BOOK}/confirm`, { method: "POST" });
  await scriptChapters(api, BOOK, [1]);
  scripted = readScript(api.db, BOOK, 1);
  expect(scripted.length).toBeGreaterThanOrEqual(3);
});

/** Write the chapter's script with `patch` applied to its first lines, then read the book in. */
async function open(...patches: Partial<Segment>[]): Promise<Segment[]> {
  const segs = scripted.map((s, i) => ({ ...structuredClone(s), ...patches[i] }));
  writeScript(api.db, BOOK, 1, segs);
  await openDemoBook(pinia, BOOK);
  return segs;
}
const saved = (id: number) => readScript(api.db, BOOK, 1).find((s) => s.id === id)!;
const WORDS: Mend = { kinds: ["words"], detail: "put back “and”" };

beforeEach(() => {
  undos = [];
  pinia = testPinia();
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  useUiStore().toast = (_msg, opts) => {
    if (opts?.undo) undos.push(opts.undo);
    return "";
  };
});

test("accepting a suggestion gives the line that type, drops the suggestion and saves both; Undo puts them back", async () => {
  const [first] = await open({
    siteCheck: { suggest: "watermark", why: "names a web address" },
  });
  scriptsStore.acceptSiteCheck(BOOK, 1, first.id);
  await scriptsStore._settled(BOOK, 1);
  expect(saved(first.id).type).toBe("watermark");
  expect(saved(first.id).siteCheck).toBeUndefined();

  undos.at(-1)!();
  await scriptsStore._settled(BOOK, 1);
  expect(saved(first.id).type).toBe(first.type);
  expect(saved(first.id).siteCheck).toEqual({ suggest: "watermark", why: "names a web address" });
});

test("dismissing a suggestion drops only the suggestion — the line is not an edit — and Undo brings it back", async () => {
  const [first] = await open({
    type: "watermark",
    siteCheck: { suggest: "narration", why: "reads like story" },
  });
  scriptsStore.dismissSiteCheck(BOOK, 1, first.id);
  await scriptsStore._settled(BOOK, 1);
  expect(saved(first.id).siteCheck).toBeUndefined();
  expect(saved(first.id).type).toBe("watermark");
  expect(saved(first.id).edited).toBe(first.edited);

  undos.at(-1)!();
  await scriptsStore._settled(BOOK, 1);
  expect(saved(first.id).siteCheck).toEqual({ suggest: "narration", why: "reads like story" });
});

test("a line of site text and a note the book does not read are no one's lines, and the server counts them the same way", async () => {
  // a thought is spoken, and counted apart too
  const segs = await open(
    { type: "watermark", mended: { kinds: ["moved"] } },
    { type: "note" },
    { type: "thought", mended: WORDS },
  );
  const spoken = segs.slice(2);
  const bySpeaker: Record<string, number> = {};
  for (const s of spoken) bySpeaker[s.speaker] = (bySpeaker[s.speaker] ?? 0) + 1;

  expect(scriptsStore.lineCounts(BOOK, 1)).toEqual(bySpeaker);
  // taking a speaker off the cast still asks about every line that names one
  expect(Object.values(scriptsStore.lineCounts(BOOK, 1, true)).reduce((a, n) => a + n, 0)).toBe(
    segs.length,
  );
  const stats = await libraryService().speakerCounts(BOOK);
  for (const [name, n] of Object.entries(bySpeaker)) expect(stats[name]?.lines).toBe(n);
  // and of those, the thought lines the book's thought effect reaches
  for (const name of Object.keys(bySpeaker))
    expect(stats[name]?.thoughts).toBe(
      spoken.filter((s) => s.speaker === name && s.type === "thought").length,
    );

  const counts = scriptsStore.lineCountsOf(BOOK, 1);
  // a mended line counts whether it is read aloud or not
  expect(counts).toMatchObject({ total: spoken.length, skipped: 2, mended: 2 });
  // the script's own count, and the count the server lists the chapter with, agree
  expect(counts).toEqual(libraryStore.chapter(BOOK, 1)!.lines!);
});

test.each([
  ["given to", (_from: string, to: string, id: number) => scriptsStore.setSpeaker(BOOK, 1, id, to)],
  ["renamed to", (from: string, to: string) => useCastStore().renameCharacter(BOOK, from, to)],
] as const)(
  "a line %s another speaker moves in the server's counts, though they were read before",
  async (_, move) => {
    // the Narrator is never renamed
    const line = (await open()).find((s) => s.speaker !== NARRATOR)!;
    const to = "Someone Else";
    const counts = pinia.run(() => useSpeakerCounts(BOOK));
    await counts.refresh();
    expect(useCastStore().castStats(BOOK)[to]).toBeUndefined();

    await move(line.speaker, to, line.id);
    await scriptsStore._settled(BOOK, 1);
    // the write's answer asked for them again; this waits for that read
    await countsSettled(BOOK);
    const stats = useCastStore().castStats(BOOK);
    for (const name of [line.speaker, to])
      expect(stats[name]?.lines ?? 0).toBe(scriptsStore.lineCounts(BOOK)[name] ?? 0);
    expect(stats[to]).toMatchObject({ first: 1 });
  },
);

test("reading the notes aloud is saved, read back, and makes a note a line again", async () => {
  const segs = await open({ type: "watermark" }, { type: "note" });
  const note = segs[1];
  const before = scriptsStore.lineCounts(BOOK, 1)[note.speaker] ?? 0;

  await libraryStore.setReadNotes(BOOK, true);
  expect(scriptsStore.lineCounts(BOOK, 1)[note.speaker]).toBe(before + 1);
  // the chapters the server answered with count the note too
  expect(libraryStore.chapter(BOOK, 1)!.lines).toMatchObject({ skipped: 1 });
  await libraryStore.loadBook(BOOK);
  expect(libraryStore.bookById(BOOK)!.readNotes).toBe(true);

  await libraryStore.setReadNotes(BOOK, false);
  await libraryStore.loadBook(BOOK);
  expect(libraryStore.bookById(BOOK)!.readNotes ?? false).toBe(false);
  expect(libraryStore.chapter(BOOK, 1)!.lines).toMatchObject({ skipped: 2 });
});

test.each([
  ["a text edit", (id: number) => scriptsStore.updateSegment(BOOK, 1, id, { text: "By hand." })],
  ["a new speaker", (id: number) => scriptsStore.setSpeaker(BOOK, 1, id, "Someone Else")],
  ["a split", (id: number) => scriptsStore.splitSegment(BOOK, 1, id, 1)],
  ["a join", (id: number) => scriptsStore.joinSegments(BOOK, 1, id)],
])("%s drops the mend mark of the line it changes", async (_, edit) => {
  const [first] = await open({ mended: WORDS });
  edit(first.id);
  await scriptsStore._settled(BOOK, 1);
  expect(readScript(api.db, BOOK, 1).filter((s) => s.mended)).toEqual([]);
});

test("“Looks right” drops every mark in the chapter without making an edit, and Undo brings them back", async () => {
  const segs = await open({ mended: WORDS }, {}, { mended: { kinds: ["moved", "model"] } });
  scriptsStore.dismissMended(BOOK, 1);
  await scriptsStore._settled(BOOK, 1);
  const after = readScript(api.db, BOOK, 1);
  expect(after.filter((s) => s.mended)).toEqual([]);
  expect(after.map((s) => [s.edited, s.audio.status])).toEqual(
    segs.map((s) => [s.edited, s.audio.status]),
  );

  undos.at(-1)!();
  await scriptsStore._settled(BOOK, 1);
  expect(saved(segs[0].id).mended).toEqual(WORDS);
  expect(saved(segs[2].id).mended).toEqual({ kinds: ["moved", "model"] });
});
