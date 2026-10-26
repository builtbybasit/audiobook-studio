// What happens to finished lines after a speaker's voice or effect changes: the cast and effects
// stores ask (`existingLines`), and an answer for some chapters redoes only those, against the
// real API and runner with the fake speech and effect runners.
import { afterEach, describe, expect, test } from "bun:test";

import type { Step } from "@/types";
import { fetchBook, fetchCast } from "@/queries";
import { HttpEffectsService, setEffectsService } from "@/services/effects";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useEffectsStore } from "@/stores/effects";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import { readScript } from "~/db/script";
import { voices } from "~/db/schema";
import { and, eq } from "drizzle-orm";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { fakeEffectRunner } from "./support/effects";
import { line } from "./support/epub";
import { testPinia } from "./support/pinia";
import { narrateChapters, speechEndpoint, voicedBook } from "./support/server";

const twoVoices = speechEndpoint({
  voices: [
    { id: "ash", gender: "m", label: "Ash" },
    { id: "bea", gender: "f", label: "Bea" },
  ],
});
const echo: Step[] = [{ plugin: "Delay", params: { delay_seconds: 0.25 }, on: true }];

/** Two narrated chapters, Mara speaking in each in `studio/ash`, read into the stores. */
async function heard(endpoint = twoVoices) {
  const fake = fakeEffectRunner();
  const api = backendServer({ effects: fake });
  setEffectsService(new HttpEffectsService("/api", api.fetch));
  const id = await voicedBook(api, {
    endpoints: [endpoint],
    paragraphs: [line("One")],
    voiceOf: "studio/ash",
    chapters: ["One", "Two"],
  });
  await narrateChapters(api, id, [1, 2]);
  testPinia();
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  useUiStore().toast = () => "";
  await Promise.all([fetchBook(id), fetchCast(id)]);
  return { api, id, fake };
}

afterEach(() => {
  pointServicesAt(null);
  setEffectsService(null);
});

describe("lines made the old way", () => {
  test("a new voice asks with None chosen; answering chapter 2 re-narrates only its lines", async () => {
    const { api, id } = await heard();
    const existing = useExistingLinesStore();

    await useCastStore().setVoice(id, "Mara", "studio/bea");
    expect(existing.ask).toMatchObject({ kind: "voice", start: "none" });
    expect(existing.ask!.names).toEqual(["Mara"]);
    expect(existing.ask!.chapters.map((c) => c.id)).toEqual([1, 2]);

    expect(await existing.answer([2])).toBe(true);
    await api.runner.idle();
    const voiceOf = (ch: number) =>
      readScript(api.db, id, ch).find((s) => s.speaker === "Mara")!.audio.voiceRef;
    expect([voiceOf(1), voiceOf(2)]).toEqual(["studio/ash", "studio/bea"]);
    expect(existing.ask).toBeNull();
  });

  test.each([
    [
      "the Character voice",
      (id: string) =>
        useLibraryStore().setCharacterVoice(id, {
          by: "one",
          one: "studio/bea",
          male: null,
          female: null,
          other: null,
        }),
    ],
    [
      "auto-assign",
      (id: string) =>
        void useCastStore().autoAssign(id, useCastStore().autoAssignPlan(id, "gender")),
    ],
  ])("%s asks about the lines it moved to another voice", async (_, change) => {
    const { id } = await heard();
    await useEndpointsStore().load();
    const existing = useExistingLinesStore();
    // Mara falls back to the Narrator's voice, the one her lines were made in
    await useCastStore().updateCharacter(id, "Mara", { gender: "f", voice: null });
    const asked = new Promise<void>((r) =>
      existing.$subscribe(() => existing.ask && r(), { flush: "sync" }),
    );
    await change(id);
    await asked;
    expect(existing.ask).toMatchObject({ kind: "voice", lines: 2 });
    expect(existing.ask!.names).toEqual(["Mara"]);
  });

  // the simulated kind takes 0.5–2× with the request; an unknown server's speed is made here
  test.each([
    ["sent with the request", "voice", "simulated://studio", undefined],
    ["made here", "effect", "http://localhost:8880/v1", 1.09],
  ] as const)("a speed %s is asked about like a new %s", async (_, kind, baseUrl, stretched) => {
    const { id } = await heard({ ...twoVoices, baseUrl });
    await useEndpointsStore().load();
    const existing = useExistingLinesStore();

    expect(await useCastStore().setSpeed(id, "Mara", 1.09)).toBe(true);
    expect(useCastStore().byName[id]!.get("Mara")!.speed).toBe(1.09);
    expect(existing.ask).toMatchObject({ kind, lines: 2, title: "Mara now reads at 1.09×" });
    expect(useEffectsStore().contextFor(id).cast.get("Mara")?.stretched).toBe(stretched);
  });

  test("an effect answered for chapter 1 re-applies it and keeps chapter 2's old sound", async () => {
    const { api, id, fake } = await heard();
    const existing = useExistingLinesStore();
    const effect = await useEffectsStore().create("Echo", echo);
    await useCastStore().setEffect(id, "Mara", effect!.id);

    await existing.askEffect(id, "Mara", ["effect"]);
    expect(existing.ask!.chapters.map((c) => c.id)).toEqual([1, 2]);
    expect(await existing.answer([1])).toBe(true);
    await api.runner.idle();

    expect(fake.calls.batch.flat()).toHaveLength(1);
    await existing.askEffect(id, "Mara", ["effect"]);
    expect(existing.ask).toBeNull();
  });

  // the studio's speed is made here: All re-applies it, None keeps the old sound
  test.each([
    ["All books", true, 1],
    ["None", false, 0],
  ])("a voice's new speed asks once across books; %s answers it", async (_, all, batches) => {
    const { api, id, fake } = await heard();
    const existing = useExistingLinesStore();
    api.db
      .update(voices)
      .set({ speed: 1.25 })
      .where(and(eq(voices.endpointId, "studio"), eq(voices.id, "ash")))
      .run();

    await existing.askVoiceSpeed("studio/ash", "Ash now reads at 1.25×");
    expect(existing.speedAsk).toMatchObject({ title: "Ash now reads at 1.25×", ready: true });
    expect(existing.speedAsk!.books).toEqual([
      expect.objectContaining({ bookId: id, reNarrate: 0 }),
    ]);
    expect(existing.speedAsk!.books[0].reApply).toBeGreaterThan(0);
    expect(await existing.answerVoiceSpeed(all ? [id] : [])).toBe(true);
    await api.runner.idle();

    expect(existing.speedAsk).toBeNull();
    expect(fake.calls.batch).toHaveLength(batches);
    await existing.askVoiceSpeed("studio/ash", "Ash now reads at 1.25×");
    expect(existing.speedAsk).toBeNull();
  });
});
