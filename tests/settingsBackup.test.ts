// The Endpoints page's backup: settings and each cloned voice's kept samples out of one server and
// into a fresh one, through the endpoints store and the real routes.
import { afterEach, expect, test } from "bun:test";

import type { KeptVoiceSamples } from "@/types";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { cloneEndpoint, HEADS, remembering, sampleFile, saved } from "./support/cloning";
import { testPinia } from "./support/pinia";

afterEach(() => pointServicesAt(null));

async function storeOn(api: ReturnType<typeof backendServer>) {
  testPinia();
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  useUiStore().toast = () => "";
  const store = useEndpointsStore();
  await store.load();
  return { api, store };
}

test("carries each cloned voice's samples and transcripts to a fresh server, once", async () => {
  const first = backendServer({ cloner: remembering().cloner });
  await saved(first, cloneEndpoint());
  const { store } = await storeOn(first);
  await store.cloneVoice(store.endpoints[0], {
    title: "Mara",
    samples: [sampleFile("a.wav"), sampleFile("b.wav", HEADS.wav, "audio/wav", 2048)],
    transcripts: ["Come in.", ""],
  });
  const zip = await store.exportBackup();

  const { api, store: restored } = await storeOn(backendServer());
  await restored.importBackup(zip);
  expect(restored.endpoints[0].voices.map((v) => v.id)).toEqual(["new-voice-id"]);
  const kept = () =>
    api.request<KeptVoiceSamples>("/api/endpoints/fish/voices/new-voice-id/samples");
  const { body } = await kept();
  expect(body.samples.map((s) => [s.name, s.bytes, s.transcript])).toEqual([
    ["a.wav", 1024, "Come in."],
    ["b.wav", 2048, undefined],
  ]);

  // a voice whose samples are already here keeps them as they are
  await restored.importBackup(zip);
  expect((await kept()).body.madeAt).toBe(body.madeAt);
});
