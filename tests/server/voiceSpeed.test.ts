// A voice's speed changed on the Endpoints page: the lines made at the old one in every book, as
// an old voice to re-narrate where the endpoint takes the speed, or old sound to Re-apply where it
// is made here; a speaker with a speed of their own is left out.
import { describe, expect, test } from "bun:test";

import type { Character, Segment, StaleSound, VoiceSpeedLines, VoiceSpeedRedone } from "@/types";
import { and, eq } from "drizzle-orm";
import { voices } from "~/db/schema";
import { fakeEffectRunner } from "../support/effects";
import {
  jsonBody,
  narrateChapters,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

const paragraphs = ["“We are short again,” said Mara.", "“Then we count it twice,” said Tobin."];

async function twoBooks(baseUrl: string) {
  const api = testApi({ effects: fakeEffectRunner() });
  // $15 per million characters, so every line has a price
  const endpoint = speechEndpoint({ baseUrl, price: 15, billing: { unit: "chars", rate: 15 } });
  const ids: string[] = [];
  for (const endpoints of [[endpoint], undefined]) {
    const id = await voicedBook(api, { endpoints, paragraphs, voiceOf: "studio/ash" });
    await narrateChapters(api, id, [1]);
    ids.push(id);
  }
  // in the second book Mara reads at a speed of her own, whatever the voice's is
  const cast = await api.request<{ characters: Character[] }>(`/api/books/${ids[1]}/cast`);
  const mara = cast.body.characters.find((c) => c.name === "Mara")!;
  await api.request(`/api/books/${ids[1]}/characters/Mara`, {
    ...jsonBody({ ...mara, speed: 1.5 }),
    method: "PUT",
  });
  api.db
    .update(voices)
    .set({ speed: 1.25 })
    .where(and(eq(voices.endpointId, "studio"), eq(voices.id, "ash")))
    .run();
  return { api, ids };
}

const done = async (api: TestApi, id: string, but?: string) =>
  (
    await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
  ).body.segments.filter((s) => s.audio.status === "done" && s.speaker !== but).length;
const old = (api: TestApi) =>
  api.request<VoiceSpeedLines>("/api/endpoints/voice-speed/old", jsonBody({ ref: "studio/ash" }));

describe("a voice's speed change", () => {
  // simulated takes 0.5–2× with the request; an unknown server's speed is made here
  test.each([
    ["sends it", "simulated://studio", "narration"],
    ["stretches it", "http://localhost:8880/v1", "effects"],
  ] as const)(
    "on an endpoint that %s asks about every book's lines, and redoes the books picked",
    async (_, baseUrl, kind) => {
      const { api, ids } = await twoBooks(baseUrl);
      const sent = kind === "narration";
      const want = [await done(api, ids[0]), await done(api, ids[1], "Mara")];
      expect(want[1]).toBeGreaterThan(0);

      const { body } = await old(api);
      expect(body.books.map((b) => [b.bookId, sent ? b.reNarrate : b.reApply])).toEqual([
        [ids[0], want[0]],
        [ids[1], want[1]],
      ]);
      for (const b of body.books) {
        expect(sent ? b.reApply : b.reNarrate).toBe(0);
        expect(b.cost! > 0).toBe(sent);
      }

      const redo = (books: string[]) =>
        api.request<VoiceSpeedRedone>(
          "/api/endpoints/voice-speed/redo",
          jsonBody({ ref: "studio/ash", books }),
        );
      for (const [i, id] of ids.entries()) {
        const { status, body: queued } = await redo([id]);
        expect(status).toBe(202);
        expect(queued.books.map((b) => [b.bookId, b.jobs > 0, b.reapplied])).toEqual([
          [id, sent, !sent],
        ]);
        await api.runner.idle();
        expect((await old(api)).body.books.map((b) => b.bookId)).toEqual(ids.slice(i + 1));
      }
      // Mara's own speed isn't the voice's: her old sound is left for her own Re-apply
      const stale = await api.request<StaleSound>(`/api/books/${ids[1]}/effects/stale`);
      const hers = (await done(api, ids[1])) - want[1];
      expect(stale.body.lines).toBe(sent ? 0 : hers);
    },
  );
});
