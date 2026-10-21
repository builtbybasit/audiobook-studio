// The Endpoints page's backup: settings and each cloned voice's kept samples out of one server and
// into a fresh one, through the endpoints store and the real routes.
import { afterEach, expect, test } from "bun:test";

import JSZip from "jszip";

import type { KeptSample, KeptVoiceSamples, SettingsFile } from "@/types";
import { packBackup, type PackVoice } from "@/lib/settingsBackup";
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

test("names each sample after its voice, in its endpoint's folder, never two alike", async () => {
  const sample = (format: KeptSample["format"]) => ({
    file: "x",
    name: "take.wav",
    format,
    bytes: 1,
    blob: new Blob(["x"]),
  });
  const voice = (title: string, endpointName: string, ...formats: KeptSample["format"][]) =>
    ({
      endpointId: "e",
      endpointName,
      voiceId: title,
      title,
      samples: formats.map(sample),
    }) satisfies PackVoice;
  const zip = await packBackup({ endpoints: [] } as unknown as SettingsFile, [
    voice("Mara", "OmniVoice local", "wav", "wav", "mp3"),
    voice("mara", "OmniVoice local", "wav"),
    voice("Mara 2", "OmniVoice local", "flac"),
    voice("Who? / Them", "Fish: Audio", "wav"),
  ]);
  const names = Object.keys((await JSZip.loadAsync(zip)).files).filter((n) => !n.endsWith("/"));
  expect(names.sort()).toEqual(
    [
      "voices/OmniVoice local/Mara.wav",
      "voices/OmniVoice local/Mara 2.wav",
      "voices/OmniVoice local/Mara 3.mp3",
      "voices/OmniVoice local/mara (2).wav",
      "voices/OmniVoice local/Mara 2 (2).flac",
      "voices/Fish Audio/Who Them.wav",
      "settings.json",
    ].sort(),
  );
});
