// A line's reading, as the browser takes it and as the server does (`@/lib/reading`).
//
// The page estimates a run, previews a line and says why a clip is out of date from the reading the
// narration store takes; the server prices, sends and records a line, and judges a clip that lands,
// from the reading it takes as the line goes out. These hold the two against each other over one
// book on a server of the test's own: the same line, read by both, is sent as the same words in
// the same parts with the same instructions, and a clip the book has moved past reads as out of
// date for the same reasons on both sides.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Character, Endpoint, ExpressionTag, Segment } from "@/types";
import { scriptedAnnotation } from "@/lib/expressions";
import { compareReading, type Reading } from "@/lib/reading";
import { fetchCast } from "@/queries/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useNarrationStore } from "@/stores/narration";
import { replaceLexicon } from "~/db/cast";
import { readScript, writeScript } from "~/db/script";
import { bookDelivery, lineReading } from "~/narration/cost";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { testPinia, type TestPinia } from "./support/pinia";
import {
  jsonBody,
  narrateChapters,
  saveEndpoints,
  speechEndpoint,
  voicedBook,
  type TestApi,
} from "./support/server";

const laughs: ExpressionTag = { id: "laughs", label: "laughs", token: "(laughs)", kind: "sound" };

/** An endpoint that cuts long lines, reads round brackets as its own tags and lists one. */
const studio = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({
    maxChars: 48,
    splitAt: "clause",
    expressions: {
      status: "supported",
      brackets: ["round"],
      open: false,
      model: "studio-tts",
      baseUrl: "http://localhost:8880/v1",
      tags: [laughs],
    },
    ...over,
  });

let api: TestApi;
let pinia: TestPinia;
let id: string;

/** The server's reading of a line: its delivery from the cast, the endpoint and dictionary stored. */
const serverReading = (s: Segment): Reading =>
  lineReading(api.db, id, s, bookDelivery(api.db, id)(s.speaker));

/** What of a reading the two sides could hold differently: everything but the endpoint's object. */
const sent = (r: Reading) => ({
  plan: r.plan,
  instructions: r.instructions,
  cuts: r.cuts,
  requests: r.requests,
  voiceRef: r.reader.voiceRef,
  style: r.reader.style ?? "",
  endpoint: r.reader.endpoint?.id,
});

/** The browser's stores read again from the server, as a reload would. */
async function reread(): Promise<void> {
  await useEndpointsStore().load(true);
  await fetchCast(id);
}

beforeEach(async () => {
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  api = backendServer();
  pinia = testPinia();
  id = await voicedBook(api, {
    endpoints: [studio()],
    paragraphs: [
      "“We are short again,” said Mara, and she laughed (Common) at the crates.",
      "“Then we count it twice, slowly, and once more, because the harbour master is watching us and the light is going,” said Tobin.",
      "The tide turned twice before either of them spoke again.",
    ],
    voiceOf: "studio/ash",
  });
  // Mara has a style of her own, which goes beside each of her lines as their instructions
  const { body } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  const mara = body.characters.find((c) => c.name === "Mara")!;
  await api.request(`/api/books/${id}/characters/Mara`, {
    ...jsonBody({ ...mara, style: "Dry, tired." }),
    method: "PUT",
  });
  replaceLexicon(api.db, id, [{ id: 1, term: "twice", say: "twyce", enabled: true }]);
  // a tag placed by hand at the start of every line, and one the scripting model wrote inside the
  // dictionary's word where there is one, which goes before it
  const segs = readScript(api.db, id, 1).map((s) => {
    const inside = s.text.indexOf("twice");
    return {
      ...s,
      expressions: [
        { ...laughs, at: 0, annotationId: 1 },
        ...(inside >= 0 ? [scriptedAnnotation({ label: "laughs", at: inside + 2 }, 2)] : []),
      ],
    };
  });
  writeScript(api.db, id, 1, segs);
  await reread();
});

afterEach(() => {
  pinia.stop();
  useEndpointsStore()._detach();
  pointServicesAt(null);
});

describe("the browser and the server read a line the same way", () => {
  test("the same words, parts, instructions and signature for every line", () => {
    const narrationStore = useNarrationStore();
    const lines = readScript(api.db, id, 1);
    // the book has what the test is about: a respelled word, a cut line and a styled speaker
    const readings = lines.map(serverReading);
    expect(readings.some((r) => r.plan.hits.length)).toBe(true);
    expect(readings.some((r) => (r.cuts?.length ?? 0) > 1)).toBe(true);
    expect(readings.some((r) => r.instructions === "Dry, tired.")).toBe(true);
    expect(readings.every((r) => r.plan.tags.includes("(laughs)"))).toBe(true);
    for (const s of lines)
      expect(sent(narrationStore.reading(id, s))).toEqual(sent(serverReading(s)));
  });

  test("a voice its endpoint no longer lists is read on that endpoint by both, where the server sends it", async () => {
    // Tobin's voice is gone from `studio`'s list, and the server still sends his lines there
    const { body } = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
    const tobin = body.characters.find((c) => c.name === "Tobin")!;
    await api.request(`/api/books/${id}/characters/Tobin`, {
      ...jsonBody({ ...tobin, voice: "studio/gone" }),
      method: "PUT",
    });
    await reread();
    const narrationStore = useNarrationStore();
    const his = readScript(api.db, id, 1).filter((s) => s.speaker === "Tobin");
    expect(his.length).toBeGreaterThan(0);
    for (const s of his) {
      expect(serverReading(s).reader.endpoint?.id).toBe("studio");
      expect(sent(narrationStore.reading(id, s))).toEqual(sent(serverReading(s)));
    }
  });

  test("a clip the server rendered is current to both, and one the book moved past is out of date to both for the same reasons", async () => {
    await narrateChapters(api, id, [1]);
    const narrationStore = useNarrationStore();
    const rendered = readScript(api.db, id, 1);
    expect(rendered.every((s) => s.audio.status === "done")).toBe(true);
    for (const s of rendered) {
      expect(narrationStore.clipDrift(id, s)).toEqual([]);
      expect(compareReading(s.audio, s, serverReading(s))).toEqual([]);
    }

    // the dictionary respells the word another way, and the endpoint asks for another rate and
    // reads no brackets as tags any more — behind the browser's back, which then reads them again
    replaceLexicon(api.db, id, [{ id: 1, term: "twice", say: "twaiss", enabled: true }]);
    const moved = studio({ sampleRate: 48000 });
    moved.expressions = { ...moved.expressions!, brackets: [], tags: [] };
    await saveEndpoints(api, [moved]);
    await reread();

    const drift = readScript(api.db, id, 1).map((s) => ({
      browser: narrationStore.clipDrift(id, s),
      server: compareReading(s.audio, s, serverReading(s)),
    }));
    expect(drift.every((d) => d.browser.length > 0)).toBe(true);
    expect(drift.some((d) => d.browser.some((why) => why.startsWith("pronunciation")))).toBe(true);
    for (const d of drift) expect(d.browser).toEqual(d.server);
  });
});
