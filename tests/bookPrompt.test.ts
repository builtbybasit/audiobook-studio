// A book's say over the scripting prompt: its notes and its own prompt, as the store saves them,
// as the run estimate prices them, and as the chapter's history names a run that used them.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { BUILT_IN_PROMPT } from "@/lib/prompt";
import { originLabel, originNote, originPrompt } from "@/lib/scriptHistory";
import { newProfile } from "@/lib/scripting";
import { useEndpointsStore } from "@/stores/endpoints";
import { storedBookPrompt, useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useUiStore } from "@/stores/ui";
import { useQueryCache } from "@pinia/colada";
import { endpointHistoryKey } from "@/queries/endpointHistory";
import type { BookPrompt, ReasoningEffort, RequestRecord, VersionOrigin } from "@/types";
import { demoServer } from "./support/demoServer";
import { openDemoBook } from "./support/demoBook";
import { testPinia, type TestPinia } from "./support/pinia";

const BOOK = "cliche";
const none: BookPrompt = { notes: "", replace: false, system: "", user: "" };

let pinia: TestPinia;
let libraryStore: ReturnType<typeof useLibraryStore>;
let toasts: string[];

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  await demoServer();
});
beforeEach(async () => {
  pinia = testPinia();
  toasts = [];
  useUiStore().toast = (msg) => {
    toasts.push(msg);
    return "";
  };
  libraryStore = useLibraryStore();
  await openDemoBook(pinia, BOOK);
});

describe("saving a book's prompt", () => {
  test("is nothing at all when it has no notes, is off and holds no text", () => {
    expect(storedBookPrompt(none)).toBeNull();
    expect(storedBookPrompt({ ...none, notes: "  " })).toBeNull();
    // a replacement switched off is kept, so switching it back on finds it again
    const kept = { ...none, system: "Be brief." };
    expect(storedBookPrompt(kept)).toEqual(kept);
  });

  test("notes survive a reload, and clearing them clears the book's prompt", async () => {
    const notes = "Dialogue is marked with em-dashes.";
    expect(await libraryStore.setBookPrompt(BOOK, { ...none, notes })).toBe(true);
    await libraryStore.loadBook(BOOK);
    expect(libraryStore.bookById(BOOK)?.prompt?.notes).toBe(notes);

    expect(await libraryStore.setBookPrompt(BOOK, none)).toBe(true);
    await libraryStore.loadBook(BOOK);
    expect(libraryStore.bookById(BOOK)?.prompt ?? null).toBeNull();
  });

  test("a prompt that could not be sent is refused with the reason, and nothing changes", async () => {
    const before = libraryStore.bookById(BOOK)?.prompt;
    const noExcerpt = { ...none, replace: true, system: "Script it.", user: "Chapter one." };
    expect(await libraryStore.setBookPrompt(BOOK, noExcerpt)).toBe(false);
    expect(await libraryStore.setBookPrompt(BOOK, { ...none, notes: "x".repeat(4001) })).toBe(
      false,
    );
    expect(toasts).toEqual([
      "This book's prompt was not saved",
      "This book's prompt was not saved",
    ]);
    expect(libraryStore.bookById(BOOK)?.prompt).toEqual(before);
    // switched off, the same text is only kept, not sent, and saves
    expect(await libraryStore.setBookPrompt(BOOK, { ...noExcerpt, replace: false })).toBe(true);
  });
});

test("the run estimate prices the prompt the run would send", () => {
  const p = newProfile({ id: "test", model: "m", needsKey: false, maxChars: 500, inPrice: 1 });
  useEndpointsStore().profiles = [p];
  const scriptingStore = useScriptingStore();
  scriptingStore.scriptSettings.profile = p.id;
  const book = libraryStore.bookById(BOOK)!;
  book.prompt = undefined;
  const plain = scriptingStore.scriptEstimate(BOOK, [1]);
  // the book's own prompt, four thousand characters longer: about a thousand tokens a request more
  book.prompt = {
    ...BUILT_IN_PROMPT,
    system: `${BUILT_IN_PROMPT.system}\n${"x".repeat(3999)}`,
    notes: "",
    replace: true,
  };
  const long = scriptingStore.scriptEstimate(BOOK, [1]);
  expect(long.chunks).toBe(plain.chunks);
  expect(long.inputTokens - plain.inputTokens).toBe(plain.chunks * 1000);
  expect(long.outputTokens).toBe(plain.outputTokens);
});

test("the run estimate adds the thinking the endpoint's recent requests at its level reported", () => {
  const p = newProfile({
    id: "thinker",
    model: "m",
    needsKey: false,
    maxChars: 500,
    inPrice: 1,
    outPrice: 2,
  });
  p.reasoning = "high";
  useEndpointsStore().profiles = [p];
  const scriptingStore = useScriptingStore();
  scriptingStore.scriptSettings.profile = p.id;
  libraryStore.bookById(BOOK)!.prompt = undefined;
  const plain = scriptingStore.scriptEstimate(BOOK, [1]);
  expect(plain.reasoningTokens).toBe(0);

  // what the ledger holds for it: half an input token of thinking per input token, at "high"
  useQueryCache().setQueryData(
    endpointHistoryKey([{ key: `scripting:${p.id}`, id: p.id, kind: "scripting" }]),
    {
      [`scripting:${p.id}`]: [
        ledgerRow(p.id, 1000, 500, "high"),
        ledgerRow(p.id, 3000, 9000, "low"),
      ],
    },
  );
  const thinking = scriptingStore.scriptEstimate(BOOK, [1]);
  expect(thinking.inputTokens).toBe(plain.inputTokens);
  expect(thinking.reasoningTokens).toBeGreaterThan(0);
  // each request thinks about half its input, and bills it as output
  expect(Math.abs(thinking.reasoningTokens - plain.inputTokens / 2)).toBeLessThanOrEqual(
    thinking.chunks,
  );
  expect(thinking.outputTokens).toBe(plain.outputTokens + thinking.reasoningTokens);
  expect(thinking.outputCost).toBeGreaterThan(plain.outputCost);
});

/** One answered scripting request in the ledger, with the thinking it reported. */
function ledgerRow(
  endpointId: string,
  inputTokens: number,
  reasoningTokens: number,
  reasoningEffort: ReasoningEffort,
): RequestRecord {
  return {
    id: `r${inputTokens}`,
    endpointId,
    kind: "scripting",
    bookId: BOOK,
    chapterId: 1,
    label: "Script · ch 1",
    status: "done",
    attempts: 1,
    queuedAt: 0,
    startedAt: 0,
    finishedAt: 1,
    queueMs: 0,
    responseMs: 1000,
    usage: { inputTokens, outputTokens: reasoningTokens + 100, reasoningTokens },
    reasoningEffort,
    cost: 0,
    costBasis: "calculated",
    simulated: false,
  };
}

test("a scripted version names where its prompt came from, beside the model", () => {
  const origin: VersionOrigin = {
    kind: "scripted",
    profile: "Luna",
    model: "gpt-6-luna",
    prompt: { from: "book", fingerprint: "3f2a9c01" },
  };
  expect(originLabel(origin)).toBe("Scripted with Luna");
  expect(originNote(origin)).toBe("gpt-6-luna · book's prompt · 3f2a9c01");
  // an endpoint's own prompt is named after the endpoint it was scripted with
  expect(originPrompt({ ...origin, prompt: { from: "endpoint", fingerprint: "3f2a9c01" } })).toBe(
    "Luna's prompt · 3f2a9c01",
  );
  // one scripted before the prompt was recorded says nothing about it
  expect(originPrompt({ ...origin, prompt: undefined })).toBe("");
  expect(originNote({ ...origin, prompt: undefined })).toBe("gpt-6-luna");
});
