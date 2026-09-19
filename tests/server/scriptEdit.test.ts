// Editing a script over HTTP: an edit names the revision it read, a stale one is refused, and the
// history is written in the same transaction as the script — one entry per editing session, one
// per bulk correction, one per restore, and none for a session that came back to where it began.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter, ChapterHistory, ScriptVersion, Segment } from "@/types";
import { SESSION_IDLE_MS } from "@/lib/scriptHistory";
import { readHistory } from "~/db/history";
import { getJob } from "~/db/jobs";
import { fakeScriptingProvider } from "~/providers/fake";
import { epubFile, story } from "../support/epub";
import {
  collectingLogger,
  gatedProvider,
  jsonBody,
  testApi,
  testRunner,
  type TestApi,
} from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface ScriptResult {
  segments: Segment[];
  revision: number;
}
interface Edited extends ScriptResult {
  history: ChapterHistory;
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

const dialogue = () => [
  "The ledger lay open on the table. “We are short again,” said Mara.",
  ...story(),
];
/** How the fake model signs the versions it replaces. */
const FAKE = fakeScriptingProvider().name;

async function scripted(api = testApi()) {
  const { body } = await api.import<ImportResult>(
    await epubFile({
      chapters: ["One", "Two"].map((title) => ({ title, paragraphs: dialogue() })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
  await api.runner.idle();
  const script = (await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`)).body;
  return { api, id, ...script };
}

const edit = (api: TestApi, id: string, body: unknown, ch = 1) =>
  api.request<Edited>(`/api/books/${id}/chapters/${ch}/script`, {
    ...jsonBody(body),
    method: "PUT",
  });
const historyOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<{ history: ChapterHistory }>(`/api/books/${id}/chapters/${ch}/history`)).body
    .history;
const rewrite = (segs: Segment[], text: string): Segment[] =>
  segs.map((s, i) => (i === 0 ? { ...s, text, edited: true } : s));

describe("editing a script", () => {
  test("writes the edit, moves the revision on, and answers with the history", async () => {
    const { api, id, segments, revision } = await scripted();
    const { status, body } = await edit(api, id, {
      segments: rewrite(segments, "Edited by hand."),
      ifRevision: revision,
    });
    expect(status).toBe(200);
    expect(body.segments[0].text).toBe("Edited by hand.");
    expect(body.revision).toBe(revision + 1);
    // the first edit preserved the script the model wrote, under the model's name
    expect(body.history.versions.map((v) => v.origin.kind)).toEqual(["scripted"]);
    expect(body.history.head.origin).toEqual({ kind: "edited", edits: 1 });
    expect(body.history.head.open).toBe(true);
    expect(
      (await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`)).body.segments[0].text,
    ).toBe("Edited by hand.");
  });

  test("a stale edit is refused and nothing is written, the way a stale job result is", async () => {
    const { api, id, segments, revision } = await scripted();
    await edit(api, id, { segments: rewrite(segments, "First."), ifRevision: revision });
    // a second tab still holding the old revision
    const { status, body } = await edit(api, id, {
      segments: rewrite(segments, "Second."),
      ifRevision: revision,
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: "conflict" } });
    const kept = (await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`)).body;
    expect(kept.segments[0].text).toBe("First.");
    expect(kept.revision).toBe(revision + 1);
    // and the refused edit left no trace in the history either
    expect((await historyOf(api, id)).head.origin).toEqual({ kind: "edited", edits: 1 });
  });

  test("an empty script and a line with no text are refused before anything is looked at", async () => {
    const { api, id, segments, revision } = await scripted();
    expect((await edit(api, id, { segments: [], ifRevision: revision })).status).toBe(400);
    const blank = await edit(api, id, { segments: rewrite(segments, ""), ifRevision: revision });
    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ error: { code: "bad_request" } });
  });

  test("a chapter with no script reads as scripted once an edit gives it one", async () => {
    const { api, id, segments } = await scripted();
    const { body } = await edit(api, id, { segments, ifRevision: 0 }, 2);
    expect(body.revision).toBe(1);
    const chapters = (await api.request<ImportResult>(`/api/books/${id}`)).body.chapters;
    expect(chapters[1].scripting).toBe("done");
    // nothing was there to preserve, so the history holds no version yet
    expect(body.history.versions).toEqual([]);
  });
});

describe("the history an edit writes", () => {
  test("edits close together are one session; a bulk correction and a restore are entries of their own", async () => {
    const { api, id, segments, revision } = await scripted();
    const a = await edit(api, id, { segments: rewrite(segments, "One."), ifRevision: revision });
    const b = await edit(api, id, {
      segments: rewrite(segments, "Two."),
      ifRevision: a.body.revision,
    });
    expect(b.body.history.head.origin).toEqual({ kind: "edited", edits: 2 });
    expect(b.body.history.versions).toHaveLength(1);

    const bulk = await edit(api, id, {
      segments: rewrite(segments, "Three."),
      ifRevision: b.body.revision,
      origin: { kind: "bulk", label: "Speaker → Mara", lines: 1 },
    });
    // the session's script is preserved under the session's name before the batch replaces it
    expect(bulk.body.history.versions.map((v) => v.origin)).toEqual([
      { kind: "scripted", profile: FAKE, again: false },
      { kind: "edited", edits: 2 },
    ]);
    expect(bulk.body.history.head.origin).toEqual({
      kind: "bulk",
      label: "Speaker → Mara",
      lines: 1,
    });
    expect(bulk.body.history.head.open).toBeUndefined();

    const restored = await edit(api, id, {
      segments: bulk.body.history.versions[0].segments,
      ifRevision: bulk.body.revision,
      origin: { kind: "restored", from: 1, fromAt: bulk.body.history.versions[0].at },
    });
    expect(restored.body.history.versions).toHaveLength(3);
    expect(restored.body.history.head.origin).toEqual({
      kind: "restored",
      from: 1,
      fromAt: bulk.body.history.versions[0].at,
    });
    expect(restored.body.segments[0].text).toBe(segments[0].text);
  });

  test("a session that comes back to where it began leaves no entry", async () => {
    const { api, id, segments, revision } = await scripted();
    const before = await historyOf(api, id);
    const a = await edit(api, id, {
      segments: rewrite(segments, "Changed."),
      ifRevision: revision,
    });
    expect(a.body.history.versions).toHaveLength(1);
    // undone: the script is exactly what the session started from
    const b = await edit(api, id, { segments, ifRevision: a.body.revision });
    expect(b.body.history.versions).toEqual([]);
    expect(b.body.history.head).toEqual(before.head);
    expect(b.body.history.nextId).toBe(before.nextId);
    // the script itself was still written: the revision moved twice
    expect(b.body.revision).toBe(revision + 2);
  });

  test("an edit after a quiet spell opens a session of its own", async () => {
    const { api, id, segments, revision } = await scripted();
    const a = await edit(api, id, { segments: rewrite(segments, "One."), ifRevision: revision });
    // the clock moves past the idle limit
    api.db.run(
      `update script_heads set at = at - ${SESSION_IDLE_MS + 1} where book_id = '${id}' and chapter_id = 1`,
    );
    const b = await edit(api, id, {
      segments: rewrite(segments, "Two."),
      ifRevision: a.body.revision,
    });
    expect(b.body.history.versions.map((v) => v.origin)).toEqual([
      { kind: "scripted", profile: FAKE, again: false },
      { kind: "edited", edits: 1 },
    ]);
    expect(b.body.history.head.origin).toEqual({ kind: "edited", edits: 1 });
  });

  test("a checkpoint names the script as it stands and changes nothing else; forgetting it puts the head back", async () => {
    const { api, id, revision } = await scripted();
    const saved = await api.request<{ version: ScriptVersion; history: ChapterHistory }>(
      `/api/books/${id}/chapters/1/history/checkpoints`,
      jsonBody({ name: "Before the cull" }),
    );
    expect(saved.status).toBe(201);
    expect(saved.body.version.origin).toEqual({
      kind: "checkpoint",
      name: "Before the cull",
      was: { kind: "scripted", profile: FAKE, again: false },
    });
    expect(saved.body.history.head.origin).toEqual(saved.body.version.origin);
    expect(
      (await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`)).body.revision,
    ).toBe(revision);

    const dropped = await api.request<{ history: ChapterHistory }>(
      `/api/books/${id}/chapters/1/history/versions/${saved.body.version.id}`,
      { method: "DELETE" },
    );
    expect(dropped.body.history.versions).toEqual([]);
    expect(dropped.body.history.head.origin).toEqual({
      kind: "scripted",
      profile: FAKE,
      again: false,
    });
    expect(dropped.body.history.nextId).toBe(saved.body.version.id);
    const again = await api.request<Failure>(
      `/api/books/${id}/chapters/1/history/versions/${saved.body.version.id}`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(404);
  });

  test("a checkpoint of a chapter with no script is refused, and a blank name is a bad request", async () => {
    const { api, id } = await scripted();
    const none = await api.request<Failure>(
      `/api/books/${id}/chapters/2/history/checkpoints`,
      jsonBody({ name: "Nothing" }),
    );
    expect(none.status).toBe(409);
    const blank = await api.request<Failure>(
      `/api/books/${id}/chapters/1/history/checkpoints`,
      jsonBody({ name: "  " }),
    );
    expect(blank.status).toBe(400);
  });
});

describe("the history a scripting job writes", () => {
  test("a re-script preserves the script it replaced, in the transaction that wrote the new one", async () => {
    const { api, id, segments, revision } = await scripted();
    expect((await historyOf(api, id)).versions).toEqual([]);
    await edit(api, id, { segments: rewrite(segments, "By hand."), ifRevision: revision });
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    const h = await historyOf(api, id);
    expect(h.versions.map((v) => v.origin)).toEqual([
      { kind: "scripted", profile: FAKE, again: false },
      { kind: "edited", edits: 1 },
    ]);
    expect(h.versions[1].segments[0].text).toBe("By hand.");
    expect(h.head.origin).toEqual({ kind: "scripted", profile: FAKE, again: true });
    // the same rule as the store's: the version is script content only
    expect(h.versions[1].segments[0].audio).toEqual({
      status: "none",
      endpoint: null,
      ms: 0,
      duration: 0,
    });
  });

  test("a re-script that comes back identical adds nothing", async () => {
    const { api, id } = await scripted();
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    expect(readHistory(api.db, id, 1).versions).toEqual([]);
  });

  test("a run that was refused for landing on newer work writes no history and adds no speaker", async () => {
    const gate = gatedProvider([{ type: "dialogue", speaker: "Stranger", text: "Late." }]);
    const { api, id, segments, revision } = await scripted();
    // a slow re-script, on a runner of its own over the same database
    const runner = testRunner(api.db, collectingLogger().log, { scripting: gate.provider });
    const { job } = runner.enqueue({
      kind: "scripting",
      bookId: id,
      chapterId: 1,
      label: "Re-script",
    });
    await gate.started;
    await edit(api, id, {
      segments: rewrite(segments, "Edited under the run."),
      ifRevision: revision,
    });
    gate.release();
    await runner.idle();
    expect(getJob(api.db, job.id)?.status).toBe("failed");
    const h = readHistory(api.db, id, 1);
    expect(h.versions).toHaveLength(1); // the edit's, and nothing from the run
    expect(h.head.origin.kind).toBe("edited");
    const cast = (await api.request<{ characters: { name: string }[] }>(`/api/books/${id}/cast`))
      .body;
    expect(cast.characters.map((c) => c.name)).not.toContain("Stranger");
  });

  test("a chapter's history goes with its volume, and follows a renumbering", async () => {
    const { api, id, segments, revision } = await scripted();
    await edit(api, id, { segments: rewrite(segments, "Kept."), ifRevision: revision });
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Three", paragraphs: dialogue() }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [3] }));
    await api.runner.idle();
    await edit(
      api,
      id,
      {
        segments: rewrite(segments, "Third."),
        ifRevision: 1,
      },
      3,
    );
    expect((await historyOf(api, id, 3)).head.origin.kind).toBe("edited");
    // volume 1 goes: chapter 3 becomes chapter 1 and its history comes with it
    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    const h = await historyOf(api, id, 1);
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0].segments[0].text).not.toBe("Kept.");
    expect((await api.request<Failure>(`/api/books/${id}/chapters/3/history`)).status).toBe(404);
  });
});
