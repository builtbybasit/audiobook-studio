// What a script file carries beyond its lines, as the import applies it against the real API: each
// chapter's recap, the file's new effects (made in the library when ticked, dropped when not), and
// the book's own settings only when switched on.
import { afterEach, describe, expect, test } from "bun:test";

import { NEW_EFFECT } from "@/lib/scriptFile";
import { scriptOnly } from "@/lib/scriptHistory";
import { fetchBook, fetchCast } from "@/queries";
import { fetchScript } from "@/queries/chapterScript";
import { effectsService, HttpEffectsService, setEffectsService } from "@/services/effects";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useScriptsStore } from "@/stores/scripts";
import { useTransferStore } from "@/stores/transfer";
import { useUiStore } from "@/stores/ui";
import type { ScriptImportPlan, Segment } from "@/types";
import { previousRecap } from "~/db/library";
import { readScript } from "~/db/script";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { PARSED } from "./support/effects";
import { line } from "./support/epub";
import { testPinia } from "./support/pinia";
import { speechEndpoint, voicedBook } from "./support/server";

/** Two scripted chapters read into the stores; Undos the toasts offered are kept in order. */
async function opened() {
  const api = backendServer();
  setEffectsService(new HttpEffectsService("/api", api.fetch));
  const id = await voicedBook(api, {
    endpoints: [speechEndpoint()],
    paragraphs: [line("One")],
    voiceOf: "studio/ash",
    chapters: ["One", "Two"],
  });
  testPinia();
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  const undos: (() => unknown)[] = [];
  useUiStore().toast = (_msg, opts) => {
    if (opts?.undo) undos.push(opts.undo);
    return "";
  };
  await Promise.all([fetchBook(id), fetchCast(id), fetchScript(id, 1)]);
  return { api, id, undos };
}

/** A plan whose one chapter is the book's chapter 1 with its first line edited. */
function planOf(
  id: string,
  edit: (first: Segment) => void,
  extra: Partial<ScriptImportPlan> = {},
  recap?: string,
): ScriptImportPlan {
  const segments = useScriptsStore()
    .segmentsOf(id, 1)
    .map((s, i) => ({ ...scriptOnly(s), id: i + 1 }));
  edit(segments[0]);
  return {
    title: "",
    author: "",
    name: "book.script.zip",
    chapters: [
      {
        chapterId: 1,
        title: "One",
        fileTitle: "One",
        file: "chapters/1.json",
        segments,
        pairedBy: "source",
        ...(recap ? { recap, recapBefore: "Before the import." } : {}),
      },
    ],
    refused: [],
    ignored: [],
    cast: { add: [], differ: [], fill: [] },
    lexicon: { add: [], differ: [] },
    voices: [],
    effects: { known: [], add: [], missing: [] },
    ...extra,
  };
}

afterEach(() => {
  pointServicesAt(null);
  setEffectsService(null);
});

describe("what a script file carries", () => {
  test("each applied chapter's recap is written with its script, and Undo puts the old one back", async () => {
    const { api, id, undos } = await opened();
    const recap = "Mara has spoken; nobody answers her yet.";
    useTransferStore().plans[id] = planOf(id, (s) => (s.direction = "quietly"), {}, recap);
    await useTransferStore().apply(id, [1]);
    await useScriptsStore()._settled(id, 1);
    expect(previousRecap(api.db, id, 2)).toBe(recap);
    await undos.at(-1)!();
    await useScriptsStore()._settled(id, 1);
    expect(previousRecap(api.db, id, 2)).toBe("Before the import.");
  });

  test("a ticked new effect is made and worn; an unticked one is left off everywhere", async () => {
    const { api, id } = await opened();
    useTransferStore().plans[id] = planOf(
      id,
      (s) => {
        s.speaker = "Operator";
        s.effects = [NEW_EFFECT + "Phone", NEW_EFFECT + "Radio"];
      },
      {
        cast: {
          add: [
            {
              name: "Operator",
              aliases: [],
              gender: "f",
              description: "",
              style: "",
              effect: "Phone",
              thoughts: "Radio",
            },
          ],
          differ: [],
          fill: [],
        },
        effects: {
          known: [],
          add: [
            { name: "Phone", chain: PARSED },
            { name: "Radio", chain: PARSED },
          ],
          missing: [],
        },
      },
    );
    const report = (await useTransferStore().apply(id, [1], [], { effects: ["Phone"] }))!;
    await Promise.all([useScriptsStore()._settled(id, 1), useCastStore()._castSettled(id)]);

    const library = await effectsService().list();
    const phone = library.find((e) => e.name === "Phone")!;
    expect(library.some((e) => e.name === "Radio")).toBe(false);
    expect(report.effects).toEqual(["Phone"]);
    expect(readScript(api.db, id, 1)[0].effects).toEqual([phone.id]);
    const operator = (await libraryService().cast(id)).characters.find(
      (c) => c.name === "Operator",
    )!;
    expect(operator.effect).toBe(phone.id);
    expect(operator.thoughts).toBeUndefined();
  });

  test.each([false, true])(
    "the file's book settings are taken only when switched on (%p), and Undo puts them back",
    async (on) => {
      const { id, undos } = await opened();
      const readNotes = async () => !!(await libraryService().book(id)).book.readNotes;
      useTransferStore().plans[id] = planOf(id, (s) => (s.direction = "quietly"), {
        book: { file: { readNotes: true }, differ: ["readNotes"] },
      });
      await useTransferStore().apply(id, [1], [], { book: on });
      expect(await readNotes()).toBe(on);
      await undos.at(-1)!();
      expect(await readNotes()).toBe(false);
    },
  );
});
