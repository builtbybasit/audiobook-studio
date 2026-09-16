// Audiobooks already on disk. Each one stores the fingerprint of every chapter it was built from,
// which is what "this export needs an update" is decided from later — not a timestamp, which only
// says a build happened, not whether the audio in it is still the audio in the book.
//
// Built last, and from the draft, because those fingerprints only mean anything once the clips in
// `seedPipeline` and `seedStory` are in place.
import { DEFAULT_PACING } from "@/lib/speech";
import { chapterSignature } from "@/lib/exports";
import { volumesOfSeed } from "@/mock/world/chapters";
import type { WorldDraft } from "@/mock/world/draft";
import type { ExportItem } from "@/types";

export function makeExports(w: WorldDraft): ExportItem[] {
  const sign = (bookId: string, ids: number[]): Record<number, string> =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        chapterSignature(
          w.chapters[bookId].find((c) => c.id === id)!,
          w.segments[`${bookId}:${id}`] ?? [],
          DEFAULT_PACING,
        ),
      ]),
    );
  /** A build made before those clips were re-rendered: the stored fingerprint no longer matches. */
  const asBuiltEarlier = (state: Record<number, string>, ids: number[]) => {
    for (const id of ids) if (state[id]) state[id] = state[id] + ":v0";
    return state;
  };
  const size = (seconds: number, kbps: number) =>
    Math.max(1, Math.round(((seconds * kbps) / 8 / 1024) * 1.04));
  const spanOf = (bookId: string, ids: number[]) =>
    ids.reduce((a, id) => a + (w.chapters[bookId].find((c) => c.id === id)?.duration ?? 0), 0) +
    Math.max(0, ids.length - 1) * 2;

  const starforgeIds = w.chapters.starforge.slice(0, 15).map((c) => c.id);
  const clicheV2Ids = [1, 2];
  const gatesIds = Array.from({ length: 196 }, (_, i) => i + 1);
  const gatesFiles = volumesOfSeed("gates").map((v, i, all) => {
    const ids = gatesIds.filter((id) => id >= v.from && id <= v.to);
    const duration = spanOf("gates", ids);
    return {
      name: `Thousand Gates of the Ninth Heaven - ${v.name.split("·")[0].trim()}.m4b`,
      chapterIds: ids,
      duration,
      size: size(duration, 64),
      markers: ids.length,
      volume: { number: i + 1, name: v.name, of: all.length },
    };
  });

  const exports: ExportItem[] = [
    {
      id: 1,
      bookId: "starforge",
      key: "ashes of the starforge|m4b|single",
      filename: "Ashes of the Starforge.m4b",
      title: "Ashes of the Starforge",
      series: "Ashes of the Starforge",
      author: "M. R. Halloway",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      format: "m4b",
      grouping: "single",
      files: [
        {
          name: "Ashes of the Starforge.m4b",
          chapterIds: starforgeIds,
          duration: spanOf("starforge", starforgeIds),
          size: size(spanOf("starforge", starforgeIds), 96),
          markers: 15,
          volume: null,
        },
      ],
      chapterIds: starforgeIds,
      chapters: 15,
      duration: spanOf("starforge", starforgeIds),
      bitrate: 96,
      chapterGap: 2,
      normalize: false,
      loudness: -18,
      size: size(spanOf("starforge", starforgeIds), 96),
      markers: 15,
      createdAt: "2026-09-04 21:14",
      version: 1,
      replaces: null,
      status: "done",
      state: sign("starforge", starforgeIds),
    },
    {
      id: 2,
      bookId: "cliche",
      key: "the cliché cultivation world|m4b|volume",
      filename: "The Cliché Cultivation World - Vol. 1.m4b",
      title: "The Cliché Cultivation World",
      series: "The Cliché Cultivation World",
      author: "Unknown Daoist",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      format: "m4b",
      grouping: "volume",
      files: [
        {
          name: "The Cliché Cultivation World - Vol. 1.m4b",
          chapterIds: [1],
          duration: spanOf("cliche", [1]),
          size: size(spanOf("cliche", [1]), 96),
          markers: 1,
          volume: { number: 1, name: "Vol. 1 · Outer Sect", of: 3 },
        },
      ],
      chapterIds: [1],
      chapters: 1,
      duration: spanOf("cliche", [1]),
      bitrate: 96,
      chapterGap: 2,
      normalize: false,
      loudness: -18,
      size: size(spanOf("cliche", [1]), 96),
      markers: 1,
      createdAt: "2026-09-08 09:02",
      version: 1,
      replaces: null,
      status: "replaced",
      state: sign("cliche", [1]),
    },
    {
      id: 3,
      bookId: "cliche",
      key: "the cliché cultivation world|m4b|volume",
      filename: "The Cliché Cultivation World - Vol. 1.m4b",
      title: "The Cliché Cultivation World",
      series: "The Cliché Cultivation World",
      author: "Unknown Daoist",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      format: "m4b",
      grouping: "volume",
      files: [
        {
          name: "The Cliché Cultivation World - Vol. 1.m4b",
          chapterIds: clicheV2Ids,
          duration: spanOf("cliche", clicheV2Ids),
          size: size(spanOf("cliche", clicheV2Ids), 96),
          markers: 2,
          volume: { number: 1, name: "Vol. 1 · Outer Sect", of: 3 },
        },
      ],
      chapterIds: clicheV2Ids,
      chapters: 2,
      duration: spanOf("cliche", clicheV2Ids),
      bitrate: 96,
      chapterGap: 2,
      normalize: false,
      loudness: -18,
      size: size(spanOf("cliche", clicheV2Ids), 96),
      markers: 2,
      createdAt: "2026-09-10 18:40",
      version: 2,
      replaces: 2,
      status: "done",
      reused: 1,
      rebuilt: 1,
      state: sign("cliche", clicheV2Ids),
    },
    // the long serial, built when volume 6 was still being narrated: nine chapters have landed
    // since and four of its own were rendered again afterwards
    {
      id: 4,
      bookId: "gates",
      key: "thousand gates of the ninth heaven|m4b|volume",
      filename: "Thousand Gates of the Ninth Heaven/",
      title: "Thousand Gates of the Ninth Heaven",
      series: "Thousand Gates of the Ninth Heaven",
      author: "Cloudwalker of the Eastern Sea",
      narrator: "Kokoro · Heart, with OpenAI dialogue",
      year: 2026,
      description: "",
      format: "m4b",
      grouping: "volume",
      files: gatesFiles,
      chapterIds: gatesIds,
      chapters: gatesIds.length,
      duration: gatesFiles.reduce((a, f) => a + f.duration, 0),
      bitrate: 64,
      chapterGap: 2,
      normalize: true,
      loudness: -18,
      size: gatesFiles.reduce((a, f) => a + f.size, 0),
      markers: gatesFiles.reduce((a, f) => a + f.markers, 0),
      createdAt: "2026-09-09 07:26",
      version: 2,
      replaces: null,
      status: "done",
      reused: 158,
      rebuilt: 38,
      state: asBuiltEarlier(sign("gates", gatesIds), [37, 88, 96, 140, 141]),
    },
    // a build that fell over: the version before it is still the one on disk
    {
      id: 5,
      bookId: "cliche",
      key: "the cliché cultivation world (complete)|m4b|single",
      filename: "The Cliché Cultivation World (complete).m4b",
      title: "The Cliché Cultivation World",
      series: "The Cliché Cultivation World",
      author: "Unknown Daoist",
      narrator: "OpenAI TTS · multi-voice",
      year: 2026,
      description: "",
      format: "m4b",
      grouping: "single",
      files: [
        {
          name: "The Cliché Cultivation World (complete).m4b",
          chapterIds: [1, 2, 3],
          duration: spanOf("cliche", [1, 2, 3]),
          size: size(spanOf("cliche", [1, 2, 3]), 96),
          markers: 3,
          volume: null,
        },
      ],
      chapterIds: [1, 2, 3],
      chapters: 3,
      duration: spanOf("cliche", [1, 2, 3]),
      bitrate: 96,
      chapterGap: 2,
      normalize: false,
      loudness: -18,
      size: 0,
      markers: 3,
      createdAt: "2026-09-13 22:05",
      version: 1,
      replaces: null,
      status: "failed",
      error:
        "Encoding stopped while writing The Cliché Cultivation World (complete).m4b at “Qi Deviation”.",
      state: sign("cliche", [1, 2, 3]),
    },
  ];

  return exports;
}
