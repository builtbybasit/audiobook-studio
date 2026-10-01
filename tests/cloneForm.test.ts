// What the Voices tab holds a pick of voice samples to before it is sent, per provider.
//
// A sample is any audio of the one person speaking, recorded or downloaded, and each provider that
// clones says what it makes a voice from (`cloning`): how many files, how large, which formats.
// The server refuses anything outside that with the file's name; the page holds the same limits up
// front so a pick is fixed before it is sent. Fish takes up to twenty in five formats; the others
// are written as a provider that takes one small WAV or MP3, the far end of what cloning looks like.
import { beforeEach, describe, expect, test } from "bun:test";
import { testPinia } from "./support/pinia";

import type { CloneSupport } from "@/lib/providers";
import { fish } from "@/lib/providers/fish";
import { useEndpointsStore } from "@/stores/endpoints";
import { cloneFit, useSpeakerSamplesStore } from "@/stores/speakerSamples";
import type { Endpoint, KeptSample, SpeakerSamples } from "@/types";
import { formatsSaid, maxSamplesOf, sizeSaid } from "@/lib/voiceSamples";
import {
  acceptOf,
  formatOfName,
  leftOutSaid,
  limitsSaid,
  pickOf,
  pickProblem,
  requestOf,
  transcriptsMissing,
} from "@/views/endpoints/cloneForm";

const FISH = fish.cloning!;
/** A provider that makes a voice from one file, of a couple of formats, and not a large one. */
const ONE: CloneSupport = {
  maxSamples: 1,
  maxSampleBytes: 10 * 1024 * 1024,
  formats: ["wav", "mp3"],
  transcript: "required",
  advice: "Use one clean clip of 10 seconds to a minute.",
  cost: "Making a voice costs a one-off fee.",
  fee: { usd: 3, when: "made", said: "$3 a voice" },
};

const file = (name: string, bytes = 8) => new File([new Uint8Array(bytes)], name);

describe("the picker and what it says", () => {
  test("offers every name a format the provider takes goes by", () => {
    expect(acceptOf(FISH)).toBe(".wav,.mp3,.m4a,.opus,.ogg,.flac");
    expect(acceptOf(ONE)).toBe(".wav,.mp3");
  });

  test("names the formats the way the server does", () => {
    expect(formatsSaid(FISH.formats)).toBe("WAV, MP3, M4A, Opus or FLAC");
    expect(formatsSaid(["wav", "mp3"])).toBe("WAV or MP3");
    expect(formatsSaid(["mp3"])).toBe("MP3");
  });

  test("says the limits in one short line, and one sample as one", () => {
    expect(limitsSaid(FISH)).toBe("Up to 20 files, 20 MB each · WAV, MP3, M4A, Opus or FLAC");
    expect(limitsSaid(ONE)).toBe("One file, up to 10 MB · WAV or MP3");
    expect(sizeSaid(512 * 1024)).toBe("512 KB");
  });

  test("a provider that needs a transcript is owed one for every sample, trimmed", () => {
    const rows = [
      { file: file("a.wav"), transcript: " Come in. " },
      { file: file("b.wav"), transcript: "  " },
    ];
    expect(transcriptsMissing(rows, ONE)).toBe(true);
    expect(transcriptsMissing(rows, FISH)).toBe(false);
    expect(transcriptsMissing([rows[0]], ONE)).toBe(false);
    expect(requestOf(rows)).toEqual({
      samples: [rows[0].file, rows[1].file],
      transcripts: ["Come in.", ""],
    });
  });

  test("never takes more than the app keeps with a voice, whatever a provider says", () => {
    expect(maxSamplesOf({ ...FISH, maxSamples: 50 })).toBe(20);
    expect(maxSamplesOf(ONE)).toBe(1);
  });
});

describe("a pick", () => {
  test("is cut to the most the provider makes a voice from, and the cut is said", () => {
    const files = Array.from({ length: 23 }, (_, i) => file(`take${i}.wav`));
    const twenty = pickOf(files, FISH);
    expect(twenty.samples).toHaveLength(20);
    expect(twenty.leftOut).toBe(3);
    expect(leftOutSaid(twenty.leftOut, FISH)).toBe("Only the first 20 are used: 3 left out.");

    const one = pickOf(files.slice(0, 3), ONE);
    expect(one.samples.map((f) => f.name)).toEqual(["take0.wav"]);
    expect(leftOutSaid(one.leftOut, ONE)).toBe("Only one sample is used: 2 left out.");

    expect(pickOf(files.slice(0, 2), FISH)).toEqual({ samples: files.slice(0, 2), leftOut: 0 });
  });

  test("a file larger than the provider takes stops it, by name", () => {
    const big = file("interview.mp3", 11 * 1024 * 1024);
    expect(pickProblem([file("ok.wav"), big], ONE, "Acme")).toBe(
      "interview.mp3 is larger than 10 MB, the most Acme takes for one sample.",
    );
    // Fish takes twenty megabytes a file
    expect(pickProblem([big], FISH, "Fish Audio")).toBeNull();
  });

  test("a file named as a format the provider does not take stops it, by name", () => {
    expect(pickProblem([file("podcast.FLAC")], ONE, "Acme")).toBe(
      "podcast.FLAC is FLAC audio, which Acme does not make a voice from. Use WAV or MP3.",
    );
    expect(pickProblem([file("clip.ogg")], ONE, "Acme")).toContain("Opus audio");
    expect(pickProblem([file("clip.ogg"), file("b.m4a"), file("c.flac")], FISH, "Fish")).toBeNull();
  });

  test("a name that says no known format is left for the server to judge by its bytes", () => {
    expect(formatOfName("download")).toBeNull();
    expect(formatOfName("clip.webm")).toBeNull();
    expect(formatOfName("Clip.Take.MP3")).toBe("mp3");
    expect(pickProblem([file("download")], ONE, "Acme")).toBeNull();
  });

  test("samples that come to more than the server reads in one go stop it", () => {
    // six of Fish's largest are each allowed, and past 100 MB together
    const six = Array.from({ length: 6 }, (_, i) => file(`t${i}.wav`, 18 * 1024 * 1024));
    expect(pickProblem(six, FISH, "Fish Audio")).toBe("The samples come to more than 100 MB.");
    expect(pickProblem(six.slice(0, 5), FISH, "Fish Audio")).toBeNull();
  });
});

describe("where a clone link opens", () => {
  const kept = (format: KeptSample["format"], bytes = 2048): KeptSample => ({
    file: `${"a".repeat(32)}.${format}`,
    name: `one.${format}`,
    format,
    bytes,
  });
  const waiting = (samples: KeptSample[]): SpeakerSamples => ({
    id: 7,
    speaker: "Mara",
    title: "Mara (cloned)",
    consentAt: 1_700_000_000_000,
    consentText: "This is my voice.",
    source: "The Cliche.script.zip",
    samples,
  });

  test("a provider that takes every sample fits best, then one that takes fewer of them", () => {
    const three = [kept("wav"), kept("mp3"), kept("wav")];
    expect(cloneFit(FISH, three)).toBe(2);
    expect(cloneFit(ONE, three)).toBe(1);
    expect(cloneFit(ONE, [kept("wav")])).toBe(2);
    expect(cloneFit(ONE, [kept("flac")])).toBe(0);
    expect(cloneFit(ONE, [kept("wav", 11 * 1024 * 1024)])).toBe(0);
  });

  describe("with endpoints", () => {
    let endpointsStore: ReturnType<typeof useEndpointsStore>;
    let samplesStore: ReturnType<typeof useSpeakerSamplesStore>;
    const at = (id: string, baseUrl: string, enabled = true): Endpoint => ({
      ...endpointsStore.endpoints[0],
      id,
      name: id,
      baseUrl,
      enabled,
    });
    beforeEach(() => {
      testPinia();
      endpointsStore = useEndpointsStore();
      samplesStore = useSpeakerSamplesStore();
    });

    test("opens the first enabled endpoint that clones, and none when nothing does", () => {
      endpointsStore.endpoints = [
        at("local", "http://127.0.0.1:8880/v1"),
        at("fish-off", "https://api.fish.audio/v1", false),
        at("fish", "https://api.fish.audio/v1"),
      ];
      const sample = waiting([kept("wav")]);
      expect(samplesStore.cloneEndpointFor(sample)?.id).toBe("fish");
      expect(samplesStore.cloneLink("book", sample)).toMatchObject({
        path: "/endpoints",
        query: { endpoint: "tts:fish", tab: "voices", book: "book", samples: "7" },
      });

      endpointsStore.endpoints = [at("local", "http://127.0.0.1:8880/v1")];
      expect(samplesStore.cloneEndpointFor(sample)).toBeNull();
      expect(samplesStore.cloneLink("book", sample)).toBeNull();
    });
  });
});
