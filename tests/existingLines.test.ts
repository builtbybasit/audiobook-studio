// What happens to finished lines after a speaker's voice or effect changes: the cast and effects
// stores ask (`existingLines`), and an answer for some chapters redoes only those, against the
// real API and runner with the fake speech and effect runners.
import { afterEach, describe, expect, test } from "bun:test";

import type { Step } from "@/types";
import { fetchBook, fetchCast } from "@/queries";
import { HttpEffectsService, setEffectsService } from "@/services/effects";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useExistingLinesStore } from "@/stores/existingLines";
import { useUiStore } from "@/stores/ui";
import { readScript } from "~/db/script";
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
async function heard() {
  const fake = fakeEffectRunner();
  const api = backendServer({ effects: fake });
  setEffectsService(new HttpEffectsService("/api", api.fetch));
  const id = await voicedBook(api, {
    endpoints: [twoVoices],
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
    expect(existing.ask).toMatchObject({ kind: "voice", name: "Mara", start: "none" });
    expect(existing.ask!.chapters.map((c) => c.id)).toEqual([1, 2]);

    expect(await existing.answer([2])).toBe(true);
    await api.runner.idle();
    const voiceOf = (ch: number) =>
      readScript(api.db, id, ch).find((s) => s.speaker === "Mara")!.audio.voiceRef;
    expect([voiceOf(1), voiceOf(2)]).toEqual(["studio/ash", "studio/bea"]);
    expect(existing.ask).toBeNull();
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
});
