// The Demo tools situations, applied on the server (`server/demo/situations.ts`, `routes/demo.ts`).
//
// Every situation the drawer lists is put into the demo through `POST /demo/situations/:id`: it
// has to apply to the seeded world without throwing, answer with its row, what it did and where to
// look, and hand `startLive` the runs it describes and none of the demo's startup runs. What the
// seeded world holds is `demoWorld.test.ts`'s to check, and what `startLive` makes of what it is
// handed is `demoLive.test.ts`'s; here `startLive` is a stub that keeps what it is given, so
// nothing runs under the situations. The demo library's own wiring of the two — a situation put in
// through `openLibrary`'s routes, its `startLive` and all — is what the Demo drawer's store drives
// (`demoStore.test.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DEMO_GROUPS, demoScenarios } from "@/mock/scenarios/catalogue";
import type { AppliedSituation, Book, DemoSituations } from "@/types";
import { createApp } from "~/app";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import type { DemoLive } from "~/demo/live";
import { newPace } from "~/demo/pace";
import { demoReset } from "~/demo/reset";
import { createRunner, type Runner } from "~/jobs/runner";
import { DEMO_BASE } from "~/libraries";
import { createSpeechGate } from "~/providers/gate";
import { voiceFiles } from "~/voices/files";
import { collectingLogger, tempAudioDir, tempExportDir, tempVoiceDir } from "../support/server";

const SITUATIONS = demoScenarios();

let db: Db;
let runner: Runner;
let app: ReturnType<typeof createApp>;
/** what the last situation handed `startLive` */
let handed: DemoLive | null = null;

beforeAll(() => {
  const { log } = collectingLogger();
  db = openDb(":memory:");
  migrate(db);
  runner = createRunner(db, {}, { log });
  const gate = createSpeechGate();
  const files = voiceFiles(tempVoiceDir());
  const reset = demoReset({
    db,
    runner,
    gate,
    voiceFiles: files,
    base: DEMO_BASE,
    dirs: [tempAudioDir(), tempExportDir()],
    live: async (live) => {
      handed = live;
    },
  });
  app = createApp(db, {
    base: DEMO_BASE,
    log,
    runner,
    gate,
    voiceFiles: files,
    demo: { reset, pace: newPace() },
  });
});

afterAll(async () => {
  await runner.stop();
  db.$client.close();
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await app.request(`http://api.test${DEMO_BASE}${path}`, init);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe("every situation applies on the server", () => {
  for (const s of SITUATIONS)
    test(s.id, async () => {
      const answer = await request<AppliedSituation>(`/demo/situations/${s.id}`, {
        method: "POST",
      });
      const { id, name, bookId, path, steps = [] } = s;
      expect(answer.scenario).toEqual({ id, name, bookId, path, steps });
      expect(answer.note).not.toBe("");
      expect(answer.open.split("?")[0]).toStartWith("/");
      // the book it is about is on the shelf it leaves
      const { books } = await request<{ books: Book[] }>("/books");
      expect(books.map((b) => b.id)).toContain(s.bookId);
      expect(handed?.bookId).toBe(s.bookId);
      expect(handed?.runs).toEqual(s.runs ?? []);
    });
});

describe("the situations' routes", () => {
  test("list every situation the Demo tools offer, with the headings they go under", async () => {
    const listed = await request<DemoSituations>("/demo/situations");
    expect(listed.groups).toEqual(DEMO_GROUPS);
    expect(listed.situations).toEqual(
      SITUATIONS.map(({ id, group, name, blurb, bookId, path, steps }) => ({
        id,
        group,
        name,
        blurb,
        bookId,
        path,
        steps: steps ?? [],
      })),
    );
  });

  test("refuse a situation there is no such row for, and leave the demo as it was", async () => {
    const before = await request<{ books: Book[] }>("/books");
    const res = await app.request(`http://api.test${DEMO_BASE}/demo/situations/nothing-like-it`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(await request<{ books: Book[] }>("/books")).toEqual(before);
  });
});
