// The Endpoints page's backup: settings and each cloned voice's kept samples out of one server and
// into a fresh one, through the endpoints store and the real routes.
import { afterEach, expect, test } from "bun:test";

import JSZip from "jszip";

import type { KeptSample, KeptVoiceSamples, SettingsFile } from "@/types";
import { packBackup, type PackVoice } from "@/lib/settingsBackup";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import type { VoiceCloner } from "~/providers/clone";
import type { VoiceLister } from "~/providers/voices";
import { backendServer, pointServicesAt } from "./support/backendServer";
import { cloneEndpoint, HEADS, remembering, sampleFile, saved } from "./support/cloning";
import { testPinia } from "./support/pinia";

afterEach(() => pointServicesAt(null));

async function storeOn(api: ReturnType<typeof backendServer>) {
  testPinia();
  // the ui store reaches for `matchMedia` as it is built, and Bun has no window
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  Object.assign(useUiStore(), { toast: () => "", toastLoading: <T>(work: Promise<T>) => work });
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

test("finds and makes again only the voices with kept samples the server no longer lists", async () => {
  let made = 0;
  const cloner: VoiceCloner = {
    clone: async (_target, r) => ({ id: `v${++made}`, label: r.title, gender: "?" }),
  };
  const listed: string[] = [];
  let down = false;
  const voices: VoiceLister = {
    list: async () => {
      if (down) throw new Error("connection refused");
      return {
        voices: listed.map((id) => ({ id, label: id, gender: "?" as const })),
        total: listed.length,
        page: 1,
        hasMore: false,
      };
    },
  };
  const api = backendServer({ cloner, voices });
  await saved(api, cloneEndpoint({ voices: [{ id: "stock", label: "Stock", gender: "f" }] }));
  const { store } = await storeOn(api);
  const ep = store.endpoints[0];
  for (const [i, title] of ["Mara", "Tomas"].entries())
    await store.cloneVoice(ep, {
      title,
      samples: [sampleFile(`${title}.wav`, HEADS.wav, "audio/wav", 1024 * (i + 1))],
      transcripts: [""],
    });
  listed.push("v2");
  // the stock voice isn't listed either, but has no kept samples to say it was ever cloned
  const lost = () => store.lostVoices(ep, ["v1", "v2", "v3"]).map((v) => v.label);
  await store.serverVoices(ep);
  expect(lost()).toEqual(["Mara"]);

  expect(await store.remakeLostVoices(ep)).toBe(1);
  expect(lost()).toEqual([]);
  expect(Object.fromEntries(ep.voices.map((v) => [v.label, v.id]))).toEqual({
    Stock: "stock",
    Mara: "v3",
    Tomas: "v2",
  });

  down = true;
  expect(await store.serverVoices(ep)).toBeNull();
  expect(lost()).toEqual([]);
});
